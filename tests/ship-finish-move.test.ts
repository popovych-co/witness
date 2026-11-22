import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import '../src/gates/index.js'
import { captureCarry, carryRef, cleanTree, gitAtLeast, keptPrefix, keptRefs, operationInProgress, remedyLine } from '../src/carry.js'
import { readStream } from '../src/journal.js'
import { gateRuns } from '../src/rounds.js'
import { finishMove } from '../src/ship.js'
import { shellLine, shellWord } from '../src/toon.js'
import { branchName } from '../src/worktree.js'
import { addOrigin, fakeScenario, gateEnv, hermeticEnv, putVerdict, shippableRepo, writePlan, type TestRepo } from './helpers.js'

// Row 243 (design §4.1.1 step 0, §4.1.3, §4.1.5; issue #86). A ship run that crashed mid-move leaves
// refs/witness/carry/<plan> behind, with the plan's uncommitted work in it and maybe not in the tree.
// Every ship run first finishes that move, in step 0's sub-order: the worktree gone; an operation in
// progress (witness's own rebase aborted, a session's never); HEAD off the plan's branch; unmerged
// entries (the carry's own, or a session's); the work already back; a clean tracked tree re-applied;
// anything else refused with the restore steps. Probes P35, P40, P41, P43, P52, P53 (passes 4-I and
// 5-K), with their final assertions inverted to the fixed behaviour.

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\n$/, '')
const tryG = (cwd: string, ...args: string[]): boolean => {
  try { g(cwd, ...args); return true } catch { return false }
}
// git as a session runs it by hand: its own reflog action (none), and an editor that accepts.
const sessionEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_EDITOR: 'true' }
  delete env.GIT_REFLOG_ACTION
  return env
}
const session = (cwd: string, ...args: string[]): { code: number | null; out: string } => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd, encoding: 'utf8', env: sessionEnv() })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}
const read = (wt: string, f: string): string => readFileSync(join(wt, f), 'utf8')
const put = (wt: string, f: string, body: string): void => writeFileSync(join(wt, f), body)
const porcelain = (wt: string): string => g(wt, 'status', '--porcelain')
const stashList = (wt: string): string => g(wt, 'stash', 'list')
const head = (wt: string): string => g(wt, 'rev-parse', 'HEAD')
const lastReflog = (wt: string, n = 1): string => g(wt, 'reflog', '-n', String(n), '--format=%gs', 'HEAD')
const hasCarry = (cwd: string, planId: string): boolean => tryG(cwd, 'show-ref', '--verify', '--quiet', carryRef(planId))
const staged = (wt: string, f: string): string => g(wt, 'show', `:${f}`)
const unmergedCount = (wt: string): number => g(wt, 'ls-files', '-u').split('\n').filter((l) => l !== '').length
const STEP0_SENTENCE = 'its reflog cannot tell'

const CLEAN = {
  coverage: [
    { anchor: '.gitignore', note: 'read' },
    { anchor: 'package.json', note: 'read' },
    { anchor: 'src/token.ts', note: 'read' },
    { anchor: 'tests/token.test.ts', note: 'read' },
  ],
  findings: [],
}

// shippableRepo with an origin and three plain files in the plan's base (f.txt, g.txt, h.txt, committed
// on main, the plan's branch rebased onto it: its tree is clean then). `moveMain` commits on main and
// pushes, as another flow's merge lands.
async function movedPlan() {
  const seed = await shippableRepo()
  const { repo, wt } = seed
  addOrigin(repo)
  // the markers the tests read are git's default style, whatever a global merge.conflictStyle says
  repo.git('config', 'merge.conflictStyle', 'merge')
  repo.write('f.txt', 'a\nb\nc\n')
  repo.write('g.txt', '1\n2\n3\n')
  repo.write('h.txt', 'x\ny\nz\n')
  repo.git('add', 'f.txt', 'g.txt', 'h.txt')
  repo.git('commit', '-m', 'f, g and h')
  repo.git('push', 'origin', 'main')
  g(wt, 'fetch', '-q', 'origin', 'main')
  g(wt, 'rebase', '-q', 'origin/main')
  expect(porcelain(wt)).toBe('')
  const moveMain = (files: Record<string, string>, message = 'another flow merged'): void => {
    for (const [f, body] of Object.entries(files)) repo.write(f, body)
    repo.git('add', ...Object.keys(files))
    repo.git('commit', '-m', message)
    repo.git('push', 'origin', 'main')
  }
  const onMain = (): boolean => {
    g(wt, 'fetch', '-q', 'origin', 'main')
    return tryG(wt, 'merge-base', '--is-ancestor', 'origin/main', 'HEAD')
  }
  return { ...seed, moveMain, onMain }
}

// The plan's uncommitted work most tests carry: g.txt staged and changed again, h.txt changed.
function putWork(wt: string): void {
  put(wt, 'g.txt', '1\nSTAGED\n3\n')
  g(wt, 'add', 'g.txt')
  put(wt, 'g.txt', '1\nSTAGED\nWORK\n')
  put(wt, 'h.txt', 'x\ny\nz\nWORK-H\n')
  expectWork(wt)
}
// Both halves exactly: the staged version staged, the worktree versions on disk.
function expectWork(wt: string): void {
  expect(porcelain(wt)).toBe('MM g.txt\n M h.txt')
  expect(staged(wt, 'g.txt')).toBe('1\nSTAGED\n3')
  expect(read(wt, 'g.txt')).toBe('1\nSTAGED\nWORK\n')
  expect(read(wt, 'h.txt')).toBe('x\ny\nz\nWORK-H\n')
}

// Every ship run here sees the fake harness first on PATH, with a clean verdict: a run that gets past
// step 0 (or a crash point that never fires) reaches the ship gate, and no test may start a real
// reviewer there.
function fakeHarness(): Record<string, string> {
  const scenario = fakeScenario()
  putVerdict(scenario, CLEAN)
  return gateEnv(scenario)
}

// `witness ship` as a process of its own: crashPoint exits it (9), as a real crash ends one.
const HERE = resolve(import.meta.dirname, '..')
function shipChild(repo: TestRepo, planId: string, env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const childEnv: NodeJS.ProcessEnv = { ...hermeticEnv({ WITNESS_REGISTRY: 'off', ...fakeHarness(), ...env }) }
  delete childEnv.WITNESS_DRIVE
  delete childEnv.WITNESS_RUNNER_TURN
  const r = spawnSync(join(HERE, 'node_modules', '.bin', 'tsx'), [join(HERE, 'src', 'bin.ts'), 'ship', planId],
    { cwd: repo.root, env: childEnv, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}
// The move crashes at one of rebaseIfMoved's three points, and leaves its carry ref behind.
function crashAt(repo: TestRepo, wt: string, planId: string, point: 'after-capture' | 'after-reset' | 'mid-rebase', env: Record<string, string> = {}): void {
  const r = shipChild(repo, planId, { ...env, WITNESS_CRASH_AFTER: `carry-${point}` })
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(9)
  expect(hasCarry(wt, planId)).toBe(true)
}

// A git that answers its version as an old one, and runs the real git for everything else.
function oldGitDir(version: string): string {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const dir = mkdtempSync(join(tmpdir(), 'witness-oldgit-'))
  writeFileSync(join(dir, 'git'),
    `#!/bin/sh\nif [ "$1" = "--version" ] || [ "$1" = "version" ]; then echo "git version ${version}"; exit 0; fi\nexec '${real}' "$@"\n`)
  chmodSync(join(dir, 'git'), 0o755)
  return dir
}

describe('step 0 finishes an interrupted move at every ship run (row 243, #86)', () => {
  it('crash before the reset: the work is still in the tree → ref dropped, ship proceeds (P35)', async () => {
    const { repo, wt, planId, moveMain, onMain } = await movedPlan()
    putWork(wt)
    moveMain({ 'm.txt': 'main\n' })
    crashAt(repo, wt, planId, 'after-capture')
    // the crash left the work where it was, and the carry ref beside it
    expectWork(wt)
    const r = await repo.cli(['ship', planId], { env: fakeHarness() })
    expect(r.stderr).not.toMatch(/carry-pending/)
    expect(r.stderr).not.toMatch(/clash-unresolved|operation-in-progress|index-locked/)
    expect(r.stdout).toMatch(/interrupted move is finished/)
    expect(tryG(wt, 'rev-parse', '--verify', carryRef(planId))).toBe(false)
    // ship went on to move the work itself, onto the moved base
    expect(r.stdout).toContain('rebased before the battery')
    expect(onMain()).toBe(true)
    expectWork(wt)
    expect(keptRefs(wt, planId)).toEqual([])
    expect(stashList(wt)).toBe('')
  }, 240_000)

  it('crash after the reset: the tracked tree is clean → re-applied', async () => {
    const { repo, wt, planId, moveMain } = await movedPlan()
    putWork(wt)
    moveMain({ 'm.txt': 'main\n' })
    const at = head(wt)
    crashAt(repo, wt, planId, 'after-reset')
    // the crash left a clean tree on the old base: the work is only in the carry ref
    expect(porcelain(wt)).toBe('')
    expect(head(wt)).toBe(at)
    expect(finishMove(repo.root, wt, planId)).toEqual({ ok: true, value: 'finished' })
    expectWork(wt)
    expect(head(wt)).toBe(at)
    expect(hasCarry(wt, planId)).toBe(false)
    expect(keptRefs(wt, planId)).toEqual([])
    expect(stashList(wt)).toBe('')
    // nothing is left to finish
    expect(finishMove(repo.root, wt, planId)).toEqual({ ok: true, value: 'none' })
  }, 240_000)

  it('crash mid-rebase: witness\'s own rebase is aborted and the carry re-applied (P40, P53)', async () => {
    const { repo, wt, planId, moveMain } = await movedPlan()
    // a plan commit that conflicts with main, so witness's rebase stops; then the uncommitted work
    put(wt, 'f.txt', 'a\nPLAN1\nc\n')
    g(wt, 'commit', '-qam', 'session fix 1')
    putWork(wt)
    moveMain({ 'f.txt': 'a\nMAIN1\nc\n' })
    const at = head(wt)
    crashAt(repo, wt, planId, 'mid-rebase')
    // witness's own rebase stands stopped: its (start), then its picks of the plan's earlier commits,
    // every entry since the (start) witness's own
    expect(operationInProgress(wt)).toBe('rebase-merge')
    const since = g(wt, 'reflog', '--format=%gs', 'HEAD').split('\n')
    const start = since.findIndex((s) => / \(start\)/.test(s))
    expect(since[start]).toMatch(/^witness-carry \(start\)/)
    expect(start).toBeGreaterThan(0)
    expect(since.slice(0, start + 1).every((s) => s.startsWith('witness-carry '))).toBe(true)
    const stoppedF = read(wt, 'f.txt')
    expect(stoppedF).toMatch(/^<{7} /m)
    const said: string[] = []
    expect(finishMove(repo.root, wt, planId, (l) => said.push(l))).toEqual({ ok: true, value: 'finished' })
    // at git's fresh stop, untouched: the conflicted file kept first (fix round 1), then the abort
    const kept = keptRefs(wt, planId)
    expect(kept.map((k) => k.files)).toEqual([['f.txt']])
    expect(g(wt, 'show', `${kept[0]!.ref}:f.txt`)).toBe(stoppedF.replace(/\n$/, ''))
    expect(said.join('\n')).toContain(shellLine(['git', 'show', kept[0]!.ref]))
    // aborted: back on the plan's branch at its own commit, no rebase in progress
    expect(operationInProgress(wt)).toBeUndefined()
    expect(g(wt, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${branchName(planId)}`)
    expect(head(wt)).toBe(at)
    expect(lastReflog(wt, 3)).toMatch(/witness-carry \(abort\)/)
    // and the carry re-applied, both halves
    expectWork(wt)
    expect(hasCarry(wt, planId)).toBe(false)
    expect(stashList(wt)).toBe('')
  }, 240_000)

  // Fix round 1. Witness's own crashed rebase is aborted only at git's fresh stop: something still
  // unmerged, no worktree change outside the conflicted files, and the index as git's stop left it.
  // A session partway through resolving it writes no reflog entry, so the reflog alone would read
  // the rebase as witness's and the abort would wipe the session's resolution.
  async function crashedStop(twoConflicts = false) {
    const p = await movedPlan()
    put(p.wt, 'f.txt', 'a\nPLAN1\nc\n')
    if (twoConflicts) put(p.wt, 'g.txt', '1\nPLAN-G\n3\n')
    g(p.wt, 'commit', '-qam', 'session fix 1')
    put(p.wt, 'h.txt', 'x\ny\nz\nWORK-H\n')
    p.moveMain(twoConflicts ? { 'f.txt': 'a\nMAIN1\nc\n', 'g.txt': '1\nMAIN-G\n3\n' } : { 'f.txt': 'a\nMAIN1\nc\n' })
    crashAt(p.repo, p.wt, p.planId, 'mid-rebase')
    expect(operationInProgress(p.wt)).toBe('rebase-merge')
    expect(porcelain(p.wt)).toMatch(/^UU f\.txt$/m)
    if (twoConflicts) expect(porcelain(p.wt)).toMatch(/^UU g\.txt$/m)
    return { ...p, stop: head(p.wt) }
  }
  // Refused carry-pending, the rebase left exactly as the session has it.
  function expectTouched(r: ReturnType<typeof finishMove>, wt: string, planId: string, stop: string): void {
    expect(r.ok).toBe(false)
    const x = !r.ok ? r.violations : []
    expect(x.map((y) => y.rule)).toEqual(['carry-pending'])
    expect(x[0]!.got).toMatch(/touched since it stopped/)
    // the human's choice, in prose: never a runnable row
    expect(x[0]!.want).toContain(shellLine(['git', 'rebase', '--continue']))
    expect(x[0]!.want).toContain(shellLine(['git', 'rebase', '--abort']))
    expect(x[0]!.remedy).toBeUndefined()
    // and the restore steps carry-pending gives
    const ref = carryRef(planId)
    expect(x[0]!.want).toContain(shellLine(['git', 'stash', 'show', '-p', ref]))
    expect(x[0]!.want).toContain(shellLine(['git', 'stash', 'apply', '--index', ref]))
    expect(x[0]!.want).toContain(keptPrefix(planId))
    // nothing aborted: the rebase stands where the session has it, the carry kept, no backup made
    expect(operationInProgress(wt)).toBe('rebase-merge')
    expect(head(wt)).toBe(stop)
    expect(lastReflog(wt, 5)).not.toMatch(/abort/)
    expect(hasCarry(wt, planId)).toBe(true)
    expect(keptRefs(wt, planId)).toEqual([])
    expect(stashList(wt)).toBe('')
  }

  it('mid-resolution: a session resolved and staged witness\'s stopped conflict, no --continue → carry-pending, nothing aborted (fix round 1)', async () => {
    const { repo, wt, planId, stop } = await crashedStop()
    put(wt, 'f.txt', 'a\nMAIN1+PLAN1\nc\n')
    expect(session(wt, 'add', 'f.txt').code).toBe(0)
    put(wt, 'h.txt', 'x\ny\nz\nSESSION-H\n')
    // the session wrote no reflog entry: the reflog alone still reads the rebase as witness's own
    expect(lastReflog(wt)).toMatch(/^witness-carry /)
    expect(unmergedCount(wt)).toBe(0)
    expectTouched(finishMove(repo.root, wt, planId), wt, planId, stop)
    // the resolution, staged, and the other edit are where the session left them
    expect(read(wt, 'f.txt')).toBe('a\nMAIN1+PLAN1\nc\n')
    expect(staged(wt, 'f.txt')).toBe('a\nMAIN1+PLAN1\nc')
    expect(read(wt, 'h.txt')).toBe('x\ny\nz\nSESSION-H\n')
  }, 240_000)

  it('a tracked edit beside the still-unmerged conflict → carry-pending, nothing aborted (fix round 1)', async () => {
    const { repo, wt, planId, stop } = await crashedStop()
    put(wt, 'h.txt', 'x\ny\nz\nSESSION-H\n')
    expectTouched(finishMove(repo.root, wt, planId), wt, planId, stop)
    expect(porcelain(wt)).toMatch(/^UU f\.txt$/m)
    expect(read(wt, 'h.txt')).toBe('x\ny\nz\nSESSION-H\n')
  }, 240_000)

  it('one of two conflicts resolved and staged, the other still unmerged → carry-pending, nothing aborted (fix round 1)', async () => {
    const { repo, wt, planId, stop } = await crashedStop(true)
    put(wt, 'f.txt', 'a\nMAIN1+PLAN1\nc\n')
    expect(session(wt, 'add', 'f.txt').code).toBe(0)
    // still unmerged, and no worktree change outside the conflicted files: only the index tells
    expect(porcelain(wt)).toMatch(/^UU g\.txt$/m)
    expect([...new Set(g(wt, 'diff', '--name-only').split('\n'))]).toEqual(['g.txt'])
    expectTouched(finishMove(repo.root, wt, planId), wt, planId, stop)
    expect(staged(wt, 'f.txt')).toBe('a\nMAIN1+PLAN1\nc')
    expect(porcelain(wt)).toMatch(/^UU g\.txt$/m)
  }, 240_000)

  it('a fresh stop with an edit never staged inside the unmerged file → aborted, the carry re-applied, the edit kept (fix round 1)', async () => {
    const { repo, wt, planId } = await crashedStop()
    put(wt, 'f.txt', 'a\nHALF-RESOLVED\nc\n')
    expect(porcelain(wt)).toMatch(/^UU f\.txt$/m)
    const said: string[] = []
    expect(finishMove(repo.root, wt, planId, (l) => said.push(l))).toEqual({ ok: true, value: 'finished' })
    // the file's bytes were kept before the abort, in the plan's next kept ref
    const kept = keptRefs(wt, planId)
    expect(kept.map((k) => k.files)).toEqual([['f.txt']])
    expect(kept[0]!.ref).toBe(`${keptPrefix(planId)}1`)
    expect(g(wt, 'show', `${kept[0]!.ref}:f.txt`)).toBe('a\nHALF-RESOLVED\nc')
    expect(said.join('\n')).toContain(kept[0]!.ref)
    expect(said.join('\n')).toContain(shellLine(['git', 'show', kept[0]!.ref]))
    // aborted, and the carry back on the plan's branch
    expect(operationInProgress(wt)).toBeUndefined()
    expect(g(wt, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${branchName(planId)}`)
    expect(read(wt, 'f.txt')).toBe('a\nPLAN1\nc\n')
    expect(read(wt, 'h.txt')).toBe('x\ny\nz\nWORK-H\n')
    expect(porcelain(wt)).toBe(' M h.txt')
    expect(hasCarry(wt, planId)).toBe(false)
    // the backup went through a scratch index: the stash list untouched
    expect(stashList(wt)).toBe('')
  }, 240_000)

  // The final review's M6. Step 0 names its kept ref only once the abort has landed — "kept before it
  // was aborted" over a rebase still standing is untrue — and a retry at the same fresh stop reuses the
  // backup it already wrote (same tree, same parent, same files) rather than writing an identical one.
  it('a fresh stop whose abort meets a held lock names no kept ref; the retry reuses the backup and names it once the abort lands (M6)', async () => {
    const { repo, wt, planId, stop } = await crashedStop()
    const lock = resolve(wt, g(wt, 'rev-parse', '--git-path', 'index.lock'))
    writeFileSync(lock, '')
    const said: string[] = []
    const r = finishMove(repo.root, wt, planId, (l) => said.push(l))
    expect(r.ok).toBe(false)
    expect(!r.ok ? r.violations.map((x) => x.rule) : []).toEqual(['index-locked'])
    // the backup is written first, but no line claims an abort that did not land
    expect(keptRefs(wt, planId).map((k) => k.ref)).toEqual([`${keptPrefix(planId)}1`])
    expect(said.filter((l) => l.startsWith('kept:'))).toEqual([])
    expect(operationInProgress(wt)).toBe('rebase-merge')
    expect(head(wt)).toBe(stop)
    rmSync(lock)
    const again: string[] = []
    expect(finishMove(repo.root, wt, planId, (l) => again.push(l))).toEqual({ ok: true, value: 'finished' })
    // the same stop's backup, reused: still one kept ref, and named now that the abort landed
    expect(keptRefs(wt, planId).map((k) => k.ref)).toEqual([`${keptPrefix(planId)}1`])
    expect(again.filter((l) => l.startsWith('kept:'))).toEqual([
      expect.stringContaining(shellLine(['git', 'show', `${keptPrefix(planId)}1`])),
    ])
    expect(operationInProgress(wt)).toBeUndefined()
    expect(read(wt, 'h.txt')).toBe('x\ny\nz\nWORK-H\n')
    expect(hasCarry(wt, planId)).toBe(false)
    expect(stashList(wt)).toBe('')
  }, 240_000)

  it('a fresh stop whose abort git refuses (no lock): carry-pending names the kept ref, and no kept: line claims the abort (M6)', async () => {
    if (process.platform === 'win32') return   // the failing git is a shell script on PATH
    const { repo, wt, planId, stop } = await crashedStop()
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    const dir = mkdtempSync(join(tmpdir(), 'witness-noabort-'))
    writeFileSync(join(dir, 'git'),
      `#!/bin/sh\nseen=\nfor a in "$@"; do [ "$a" = rebase ] && seen=1; [ -n "$seen" ] && [ "$a" = --abort ] && { echo 'error: the abort was refused' >&2; exit 1; }; done\nexec '${real}' "$@"\n`)
    chmodSync(join(dir, 'git'), 0o755)
    try {
      const env = fakeHarness()
      const r = shipChild(repo, planId, { ...env, PATH: `${dir}${delimiter}${env.PATH}` })
      expect(r.status, r.stderr).toBe(2)
      expect(r.stderr).toMatch(/carry-pending/)
      expect(r.stderr).toContain('the abort was refused')
      const kept = `${keptPrefix(planId)}1`
      expect(keptRefs(wt, planId).map((k) => k.ref)).toEqual([kept])
      expect(r.stderr).toContain(kept)
      expect(r.stdout.split('\n').filter((l) => l.startsWith('kept:'))).toEqual([])
      expect(operationInProgress(wt)).toBe('rebase-merge')
      expect(head(wt)).toBe(stop)
      expect(hasCarry(wt, planId)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 240_000)

  it('a session continued witness\'s rebase → operation-in-progress; nothing aborted, its commits kept (P53)', async () => {
    const { repo, wt, planId, moveMain } = await movedPlan()
    // two plan commits that both conflict with main, and uncommitted work in h.txt
    put(wt, 'f.txt', 'a\nPLAN1\nc\n')
    g(wt, 'commit', '-qam', 'session fix 1')
    put(wt, 'g.txt', '1\nPLAN2\n3\n')
    g(wt, 'commit', '-qam', 'session fix 2')
    put(wt, 'h.txt', 'x\ny\nz\nWORK-H\n')
    moveMain({ 'f.txt': 'a\nMAIN1\nc\n', 'g.txt': '1\nMAIN2\n3\n' })
    crashAt(repo, wt, planId, 'mid-rebase')
    // the session resolves fix 1 and continues witness's rebase, which stops again on fix 2
    put(wt, 'f.txt', 'a\nMAIN1+PLAN1\nc\n')
    expect(session(wt, 'add', 'f.txt').code).toBe(0)
    expect(session(wt, 'rebase', '--continue').code).not.toBe(0)
    expect(operationInProgress(wt)).toBe('rebase-merge')
    expect(lastReflog(wt)).toMatch(/^rebase \(continue\)/)
    const resolved = head(wt)
    const r = finishMove(repo.root, wt, planId)
    expect(r.ok).toBe(false)
    const x = !r.ok ? r.violations : []
    expect(x.map((y) => y.rule)).toEqual(['operation-in-progress', 'carry-pending'])
    expect(x[0]!.want).toContain(shellLine(['git', 'rebase', '--continue']))
    // the reflog shows the session's own entries: no "if it is witness's own" sentence
    expect(x.some((y) => y.want.includes(STEP0_SENTENCE) || y.got.includes(STEP0_SENTENCE))).toBe(false)
    expect(x[1]!.got).toMatch(/a session started/)
    // nothing aborted: the session's resolved commit stands, its rebase still in progress
    expect(operationInProgress(wt)).toBe('rebase-merge')
    expect(head(wt)).toBe(resolved)
    expect(g(wt, 'log', '-1', '--format=%s', 'HEAD')).toBe('session fix 1')
    expect(g(wt, 'show', 'HEAD:f.txt')).toBe('a\nMAIN1+PLAN1\nc')
    expect(lastReflog(wt, 5)).not.toMatch(/abort/)
    // nothing applied into it; the work waits in the carry ref
    expect(read(wt, 'h.txt')).toBe('x\ny\nz\n')
    expect(g(wt, 'diff', `${carryRef(planId)}^1`, carryRef(planId))).toContain('+WORK-H')
    expect(stashList(wt)).toBe('')
  }, 240_000)

  it('a session\'s own rebase from the same HEAD is never aborted (P40)', async () => {
    const { repo, wt, planId, moveMain } = await movedPlan()
    putWork(wt)
    moveMain({ 'm.txt': 'main\n' })
    crashAt(repo, wt, planId, 'after-reset')
    const carryBase = g(wt, 'rev-parse', `${carryRef(planId)}^1`)
    expect(head(wt)).toBe(carryBase)
    // the session rebases by hand from that same HEAD, stopped by a failing --exec
    expect(session(wt, 'rebase', '--exec', 'false', 'origin/main').code).not.toBe(0)
    expect(operationInProgress(wt)).toBe('rebase-merge')
    // its orig-head is <carry>^1: orig-head alone would have read it as witness's own (P40)
    const origHead = resolve(wt, g(wt, 'rev-parse', '--git-path', 'rebase-merge/orig-head'))
    expect(readFileSync(origHead, 'utf8').trim()).toBe(carryBase)
    const newest = lastReflog(wt)
    expect(newest).toMatch(/^rebase \(/)
    const r = finishMove(repo.root, wt, planId)
    expect(r.ok).toBe(false)
    const x = !r.ok ? r.violations : []
    expect(x.map((y) => y.rule)).toEqual(['operation-in-progress', 'carry-pending'])
    expect(x[0]!.want).toContain(shellLine(['git', 'rebase', '--abort']))
    expect(x.some((y) => y.want.includes(STEP0_SENTENCE) || y.got.includes(STEP0_SENTENCE))).toBe(false)
    // never aborted, never applied into
    expect(operationInProgress(wt)).toBe('rebase-merge')
    expect(lastReflog(wt)).toBe(newest)
    expect(read(wt, 'h.txt')).toBe('x\ny\nz\n')
    expect(hasCarry(wt, planId)).toBe(true)
    expect(stashList(wt)).toBe('')
  }, 240_000)

  it('with no HEAD reflog (core.logAllRefUpdates=false) witness\'s own crashed rebase reads as silent: never aborted, the step-0 sentence named', async () => {
    const { repo, wt, planId, moveMain } = await movedPlan()
    put(wt, 'f.txt', 'a\nPLAN1\nc\n')
    g(wt, 'commit', '-qam', 'session fix 1')
    putWork(wt)
    moveMain({ 'f.txt': 'a\nMAIN1\nc\n' })
    g(wt, 'config', 'core.logAllRefUpdates', 'false')
    const headLog = resolve(wt, g(wt, 'rev-parse', '--git-path', 'logs/HEAD'))
    rmSync(headLog, { force: true })
    crashAt(repo, wt, planId, 'mid-rebase')
    expect(existsSync(headLog)).toBe(false)
    expect(operationInProgress(wt)).toBe('rebase-merge')
    const r = finishMove(repo.root, wt, planId)
    expect(r.ok).toBe(false)
    const x = !r.ok ? r.violations : []
    expect(x.map((y) => y.rule)).toEqual(['operation-in-progress', 'carry-pending'])
    expect(x[0]!.want).toContain(`if the rebase is witness's own (${STEP0_SENTENCE}), run ${shellLine(['git', 'rebase', '--abort'])}, then re-run witness ship ${planId}`)
    expect(x[1]!.got).toContain(STEP0_SENTENCE)
    // silence is no proof: the rebase stands
    expect(operationInProgress(wt)).toBe('rebase-merge')
    expect(hasCarry(wt, planId)).toBe(true)
    // the human who knows witness started it follows the sentence, and the move then finishes
    g(wt, 'rebase', '--abort')
    expect(finishMove(repo.root, wt, planId)).toEqual({ ok: true, value: 'finished' })
    expectWork(wt)
    expect(hasCarry(wt, planId)).toBe(false)
  }, 240_000)

  it('HEAD detached or on another branch → carry-pending naming `git switch witness/<plan>`', async () => {
    const { repo, wt, planId, moveMain } = await movedPlan()
    putWork(wt)
    moveMain({ 'm.txt': 'main\n' })
    crashAt(repo, wt, planId, 'after-reset')
    const switchBack = shellLine(['git', 'switch', branchName(planId)])
    for (const [where, leave, got] of [
      ['detached', () => g(wt, 'switch', '-q', '--detach'), /HEAD is detached/],
      ['another branch', () => g(wt, 'switch', '-q', '-c', 'other'), new RegExp(`HEAD is on ${shellWord('other')}`)],
    ] as const) {
      leave()
      const r = finishMove(repo.root, wt, planId)
      expect(r.ok, where).toBe(false)
      const x = !r.ok ? r.violations : []
      expect(x.map((y) => y.rule), where).toEqual(['carry-pending'])
      expect(x[0]!.got, where).toMatch(got)
      expect(x[0]!.want, where).toContain(switchBack)
      // before anything is compared, applied or moved
      expect(porcelain(wt), where).toBe('')
      expect(hasCarry(wt, planId), where).toBe(true)
      g(wt, 'switch', '-q', branchName(planId))
    }
    // back on the plan's branch, the move finishes
    expect(finishMove(repo.root, wt, planId)).toEqual({ ok: true, value: 'finished' })
    expectWork(wt)
  }, 240_000)

  it('unmerged entries matching the carry\'s blobs → kept ref + textual-conflict; a session\'s own stash pop → carry-pending naming files (P43, P52)', async () => {
    // (a) the carry's own clash: the apply printed CONFLICT, and witness crashed before the carry moved
    // to a kept ref — stages 1 and 3 are <carry>^1's and <carry>'s blobs (P43)
    {
      const { repo, wt, planId, moveMain } = await movedPlan()
      put(wt, 'f.txt', 'a\nPLAN\nc\n')
      put(wt, 'g.txt', '1\n2\nPLAN-G\n')
      moveMain({ 'f.txt': 'a\nMAIN\nc\n' })
      const captured = captureCarry(wt, planId)
      expect(captured.ok && captured.value !== undefined).toBe(true)
      const carry = captured.ok ? captured.value! : ''
      expect(cleanTree(wt, planId).ok).toBe(true)
      g(wt, 'fetch', '-q', 'origin', 'main')
      g(wt, 'rebase', '-q', '--no-autostash', 'origin/main')
      expect(spawnSync('git', ['stash', 'apply', '--index', carry], { cwd: wt, encoding: 'utf8' }).status).toBe(1)
      expect(porcelain(wt)).toMatch(/^UU f\.txt$/m)
      const r = await repo.cli(['ship', planId], { env: fakeHarness() })
      expect(r.code).toBe(1)
      expect(r.stderr).toMatch(/textual-conflict/)
      expect(r.stderr).not.toMatch(/carry-pending|clash-unresolved/)
      expect(r.stderr).toContain(remedyLine(['git', 'add', '--', 'f.txt']))
      expect(r.stderr).toContain(`${keptPrefix(planId)}1`)
      expect(keptRefs(wt, planId).map((k) => k.files)).toEqual([['f.txt']])
      expect(hasCarry(wt, planId)).toBe(false)
      // the clash stays in the files; nothing reached the stash list, no gate ran, nothing recorded
      expect(porcelain(wt)).toMatch(/^UU f\.txt$/m)
      expect(read(wt, 'g.txt')).toBe('1\n2\nPLAN-G\n')
      expect(stashList(wt)).toBe('')
      expect(gateRuns(readStream(repo.root, planId), 'ship')).toHaveLength(0)
      expect(readStream(repo.root, planId).filter((e) => e.t === 'ship-outcome')).toHaveLength(0)
    }
    // (b) a session's own clash: witness crashed after the reset; the session then moves by hand and
    // applies a stash of its own made on the old base (its own `git stash pop`, here without touching
    // the stash list) — UU with no operation in progress, stage 3 not the carry's blob (P52)
    {
      const { repo, wt, planId, moveMain } = await movedPlan()
      put(wt, 'f.txt', 'a\nPLAN\nc\n')
      moveMain({ 'f.txt': 'a\nMAIN\nc\n' })
      crashAt(repo, wt, planId, 'after-reset')
      put(wt, 'f.txt', 'a\nSESSION\nc\n')
      const own = g(wt, 'stash', 'create')
      g(wt, 'reset', '-q', '--hard')
      g(wt, 'fetch', '-q', 'origin', 'main')
      expect(session(wt, 'rebase', '-q', 'origin/main').code).toBe(0)
      expect(spawnSync('git', ['stash', 'apply', own], { cwd: wt, encoding: 'utf8' }).status).toBe(1)
      expect(porcelain(wt)).toBe('UU f.txt')
      expect(operationInProgress(wt)).toBeUndefined()
      const r = finishMove(repo.root, wt, planId)
      expect(r.ok).toBe(false)
      const x = !r.ok ? r.violations : []
      expect(new Set(x.map((y) => y.rule))).toEqual(new Set(['carry-pending']))
      expect(x.map((y) => y.field)).toContain(shellWord('f.txt'))
      expect(x.find((y) => y.field === shellWord('f.txt'))!.want).toContain(remedyLine(['git', 'add', '--', 'f.txt']))
      // the session's clash is its own: no kept ref, the carry ref kept, the tree untouched
      expect(keptRefs(wt, planId)).toEqual([])
      expect(hasCarry(wt, planId)).toBe(true)
      expect(porcelain(wt)).toBe('UU f.txt')
      expect(stashList(wt)).toBe('')
    }
  }, 400_000)

  it('anything else → carry-pending printing `git stash show -p <ref>` beside `git diff <ref>^1 <ref>^2` and the restore steps; never resets', async () => {
    const { repo, wt, planId, moveMain } = await movedPlan()
    putWork(wt)
    moveMain({ 'm.txt': 'main\n' })
    crashAt(repo, wt, planId, 'after-reset')
    // after the crash the session edits a file of its own: the tree is neither clean nor the work
    put(wt, 'f.txt', 'a\nb\nc\nLATER\n')
    const before = { head: head(wt), status: porcelain(wt), f: read(wt, 'f.txt'), g: read(wt, 'g.txt'), h: read(wt, 'h.txt') }
    const r = finishMove(repo.root, wt, planId)
    expect(r.ok).toBe(false)
    const x = !r.ok ? r.violations : []
    expect(x.map((y) => y.rule)).toEqual(['carry-pending'])
    const ref = carryRef(planId)
    const want = x[0]!.want
    expect(want).toContain(shellLine(['git', 'stash', 'show', '-p', ref]))
    expect(want).toContain(shellLine(['git', 'diff', `${ref}^1`, `${ref}^2`]))
    expect(want).toContain(shellLine(['git', 'stash', 'apply', '--index', ref]))
    expect(want).toContain(shellLine(['git', 'stash', 'apply', ref]))
    expect(want).toContain('conflicts in index')
    expect(want).toContain(keptPrefix(planId))
    expect(want).toContain(`witness ship ${planId}`)
    // never resets: the tree, HEAD and the carry ref as they were
    expect({ head: head(wt), status: porcelain(wt), f: read(wt, 'f.txt'), g: read(wt, 'g.txt'), h: read(wt, 'h.txt') }).toEqual(before)
    expect(hasCarry(wt, planId)).toBe(true)
    expect(stashList(wt)).toBe('')
  }, 240_000)

  it('the worktree gone → carry-pending showing the ref, which is kept', async () => {
    const { repo, wt, planId, moveMain } = await movedPlan()
    putWork(wt)
    moveMain({ 'm.txt': 'main\n' })
    crashAt(repo, wt, planId, 'after-reset')
    const ref = carryRef(planId)
    const carried = g(repo.root, 'rev-parse', ref)
    rmSync(wt, { recursive: true, force: true })
    const r = await repo.cli(['ship', planId], { env: fakeHarness() })
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/carry-pending/)
    expect(r.stderr).toContain(shellLine(['git', 'stash', 'show', '-p', ref]))
    expect(r.stderr).toContain('is gone')
    // kept, unchanged, and still holding the work
    expect(g(repo.root, 'rev-parse', ref)).toBe(carried)
    expect(g(repo.root, 'diff', `${ref}^1`, ref)).toContain('+WORK-H')
    expect(readStream(repo.root, planId).filter((e) => e.t === 'ship-outcome')).toHaveLength(0)
  }, 240_000)

  it('runs before row 241\'s open-step refusal: a carry left while a step is open is finished (P41)', async () => {
    const { repo, wt, planId, moveMain } = await movedPlan()
    putWork(wt)
    moveMain({ 'm.txt': 'main\n' })
    crashAt(repo, wt, planId, 'after-reset')
    // the plan gains a step after the crash: row 241 refuses ship while it is open
    const TWO = { steps: [{ id: 's1', title: 'rotate tokens on refresh', criteria: ['ac-rotate'] }, { id: 's2', title: 'added later', criteria: ['ac-rotate'] }] }
    expect((await writePlan(repo, planId, TWO, '## Step: s1\nImplement rotation with TDD.\n\n## Step: s2\nAdded later.\n')).code).toBe(0)
    const r = await repo.cli(['ship', planId], { env: fakeHarness() })
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/steps-open/)
    expect(r.stderr).not.toMatch(/carry-pending|clash-unresolved/)
    expect(r.stdout).toMatch(/interrupted move is finished/)
    // the move finished first: the work is back and the carry ref gone, so the loop P41 found is closed
    expectWork(wt)
    expect(hasCarry(wt, planId)).toBe(false)
  }, 240_000)

  it('core.autocrlf=true, CRLF files: crash before the reset reads as the work already back (Review Focus)', async () => {
    const { repo, wt, planId, moveMain } = await movedPlan()
    repo.git('config', 'core.autocrlf', 'true')
    put(wt, 'g.txt', '1\r\nSTAGED\r\n3\r\n')
    g(wt, 'add', 'g.txt')
    put(wt, 'g.txt', '1\r\nSTAGED\r\nWORK\r\n')
    put(wt, 'h.txt', 'x\r\ny\r\nz\r\nWORK-H\r\n')
    const status = porcelain(wt)
    expect(status).toBe('MM g.txt\n M h.txt')
    moveMain({ 'm.txt': 'main\n' })
    const at = head(wt)
    crashAt(repo, wt, planId, 'after-capture')
    // the tree is dirty, so a re-apply was never possible: 'finished' here is the comparison's
    expect(finishMove(repo.root, wt, planId)).toEqual({ ok: true, value: 'finished' })
    expect(hasCarry(wt, planId)).toBe(false)
    expect(keptRefs(wt, planId)).toEqual([])
    // nothing written: the CRLF bytes, the index and HEAD as they were
    expect(porcelain(wt)).toBe(status)
    expect(head(wt)).toBe(at)
    expect(read(wt, 'g.txt')).toBe('1\r\nSTAGED\r\nWORK\r\n')
    expect(read(wt, 'h.txt')).toBe('x\r\ny\r\nz\r\nWORK-H\r\n')
    expect(staged(wt, 'g.txt')).toBe('1\nSTAGED\n3')
  }, 240_000)

  it('gitAtLeast reads 2.39.5 as old and 2.56.0.windows.1 as new; an old git refuses carry-pending with the manual steps', async () => {
    expect(gitAtLeast('git version 2.39.5', 2, 40)).toBe(false)
    expect(gitAtLeast('git version 2.56.0.windows.1', 2, 40)).toBe(true)
    expect(gitAtLeast('git version 2.40.0', 2, 40)).toBe(true)
    expect(gitAtLeast('git version 3.0.0', 2, 40)).toBe(true)
    expect(gitAtLeast('git version 1.99.9', 2, 40)).toBe(false)
    expect(gitAtLeast('git version 2.50.1 (Apple Git-155)', 2, 40)).toBe(true)
    expect(gitAtLeast('not a git', 2, 40)).toBe(false)
    if (process.platform === 'win32') return   // the old git is a shell script on PATH
    const old = oldGitDir('2.39.5')
    try {
      // a crash before the reset leaves the work in the tree: with no comparison, that is not clean
      {
        const { repo, wt, planId, moveMain } = await movedPlan()
        putWork(wt)
        moveMain({ 'm.txt': 'main\n' })
        crashAt(repo, wt, planId, 'after-capture')
        const before = { head: head(wt), status: porcelain(wt) }
        const env = fakeHarness()
        const r = shipChild(repo, planId, { ...env, PATH: `${old}${delimiter}${env.PATH}` })
        expect(r.status, r.stderr).toBe(2)
        expect(r.stderr).toMatch(/carry-pending/)
        expect(r.stderr).toContain('2.39.5')
        expect(r.stderr).toContain('older than 2.40')
        expect(r.stderr).toContain(shellLine(['git', 'stash', 'apply', '--index', carryRef(planId)]))
        expect(r.stderr).toContain(keptPrefix(planId))
        // never resets, the ref kept
        expect({ head: head(wt), status: porcelain(wt) }).toEqual(before)
        expectWork(wt)
        expect(hasCarry(wt, planId)).toBe(true)
      }
      // a clean tracked tree is re-applied without a comparison
      {
        const { repo, wt, planId, moveMain } = await movedPlan()
        putWork(wt)
        moveMain({ 'm.txt': 'main\n' })
        crashAt(repo, wt, planId, 'after-reset')
        const env = fakeHarness()
        const r = shipChild(repo, planId, { ...env, PATH: `${old}${delimiter}${env.PATH}` })
        expect(r.stderr).not.toMatch(/carry-pending|clash-unresolved/)
        expect(r.stdout).toMatch(/interrupted move is finished/)
        expect(hasCarry(wt, planId)).toBe(false)
        expectWork(wt)
      }
    } finally {
      rmSync(old, { recursive: true, force: true })
    }
  }, 400_000)
})
