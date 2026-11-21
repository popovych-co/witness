import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import '../src/gates/index.js'
import { captureCarry, carryRef, cleanTree, keptRefs, operationInProgress, reapply, remedyLine } from '../src/carry.js'
import { clashLeft } from '../src/clash.js'
import { readStream } from '../src/journal.js'
import { gateRuns } from '../src/rounds.js'
import { rebaseIfMoved, recordPushed } from '../src/ship.js'
import { shellLine, shellWord } from '../src/toon.js'
import { branchName } from '../src/worktree.js'
import { addOrigin, shippableRepo } from './helpers.js'

// Row 243 (design §4.1.1 steps 1–2 and 4–7, §4.1.3, §4.1.5; issue #86). When the base moves, ship
// carries the plan's uncommitted work itself: it captures it (`git stash create`, into a witness-only
// ref), cleans the tree (`git reset --hard`), rebases with `--no-autostash`, and puts the work back
// with `git stash apply --index <carry>`. A clash re-applying it stays in the files (UU), the carry is
// kept under refs/witness/kept/<plan>/<n>, ship refuses `textual-conflict` (exit 1), and nothing ever
// lands on git's shared stash list. Probes P1, P2, P13–P15, P19, P25, P26 (grill/p86a, p86c, p86d,
// p86e), with their final assertions inverted to the fixed behaviour.

const g = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\n$/, '')
const tryG = (cwd: string, ...args: string[]): boolean => {
  try { g(cwd, ...args); return true } catch { return false }
}
const read = (wt: string, f: string): string => readFileSync(join(wt, f), 'utf8')
const put = (wt: string, f: string, body: string): void => writeFileSync(join(wt, f), body)
const porcelain = (wt: string): string => g(wt, 'status', '--porcelain')
const stashList = (wt: string): string => g(wt, 'stash', 'list')
const head = (wt: string): string => g(wt, 'rev-parse', 'HEAD')
const hasCarry = (wt: string, planId: string): boolean => tryG(wt, 'show-ref', '--verify', '--quiet', carryRef(planId))
// The staged and the worktree version of a file, as git holds them.
const staged = (wt: string, f: string): string => g(wt, 'show', `:${f}`)

// A hook in the test repo's own hooks dir (shared by its worktrees), so a step of the move meets a
// state the test sets at exactly that moment: `git rebase` runs pre-rebase before it moves anything.
// core.hooksPath is pinned in the repo's own config first: `--git-path hooks/…` honours a global
// core.hooksPath, which would put the hook in the user's own hooks dir, run by every rebase in every
// repo (tests/gitio.test.ts pins it for the same reason).
function hook(wt: string, name: string, body: string): void {
  const hooks = join(resolve(wt, g(wt, 'rev-parse', '--git-common-dir')), 'hooks')
  g(wt, 'config', 'core.hooksPath', hooks)
  const path = join(hooks, name)
  expect(resolve(wt, g(wt, 'rev-parse', '--git-path', `hooks/${name}`))).toBe(path)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

// shippableRepo with an origin and two plain files in the plan's base: f.txt and g.txt are committed
// on main and the plan's branch rebased onto it by the test (its tree is clean then). `moveMain`
// commits on main and pushes, as another flow's merge lands; the plan's worktree is not told.
async function movedPlan() {
  const seed = await shippableRepo()
  const { repo, wt, planId } = seed
  addOrigin(repo)
  // the markers the tests read are git's default style, whatever a global merge.conflictStyle says
  repo.git('config', 'merge.conflictStyle', 'merge')
  repo.write('f.txt', 'a\nb\nc\n')
  repo.write('g.txt', '1\n2\n3\n')
  repo.git('add', 'f.txt', 'g.txt')
  repo.git('commit', '-m', 'f and g')
  repo.git('push', 'origin', 'main')
  expect(porcelain(wt)).toBe('')
  g(wt, 'fetch', '-q', 'origin', 'main')
  g(wt, 'rebase', '-q', 'origin/main')
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
  const run = { planId, hasPr: false, env: {} }
  return { ...seed, moveMain, onMain, run }
}

// P1/P2's shape: the plan edits line 2 of f.txt, uncommitted, and main edits the same line. The plan
// also edits g.txt (no clash) and holds an untracked file the move never touches.
async function movedClash() {
  const p = await movedPlan()
  put(p.wt, 'f.txt', 'a\nPLAN\nc\n')
  put(p.wt, 'g.txt', '1\n2\nPLAN-G\n')
  put(p.wt, 'u.txt', 'untracked\n')
  p.moveMain({ 'f.txt': 'a\nMAIN\nc\n' })
  return p
}

// S1-8. The German test proves its point only with a git that has a German catalog (Homebrew's;
// Apple's has none): without one, git prints English whatever LANGUAGE says.
function gitSpeaksGerman(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'witness-de-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  const env = { ...process.env, LANGUAGE: 'de', LANG: 'de_DE.UTF-8' }
  delete env.LC_ALL
  delete env.LC_MESSAGES
  // in a repository, so git's answer is the rebase's own: English "no rebase in progress", else translated
  const r = spawnSync('git', ['rebase', '--abort'], { cwd: dir, env, encoding: 'utf8' })
  const out = `${r.stdout}${r.stderr}`
  return r.status !== 0 && out !== '' && !/no rebase in progress/.test(out)
}
const GERMAN = gitSpeaksGerman()

describe('ship carries the plan\'s work itself when the base moves (row 243, #86)', () => {
  it('a clash re-applying the carry stays in the files: textual-conflict, UU kept, kept ref, no stash entry (P1, P2)', async () => {
    const { repo, wt, planId, onMain } = await movedClash()
    const r = await repo.cli(['ship', planId])
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/textual-conflict/)
    expect(g(wt, 'status', '--porcelain')).toMatch(/^UU f\.txt$/m)
    expect(stashList(wt)).toBe('')
    expect(keptRefs(wt, planId).map((k) => k.files)).toEqual([['f.txt']])
    expect(gateRuns(readStream(repo.root, planId), 'ship')).toHaveLength(0)
    // the markers are git's own stash-apply labels, both sides in them
    expect(read(wt, 'f.txt')).toMatch(/^<{7} Updated upstream\nMAIN\n={7}\nPLAN\n>{7} Stashed changes$/m)
    // the rest of the work is back, the untracked file untouched, and the carry ref gone (kept instead)
    expect(read(wt, 'g.txt')).toBe('1\n2\nPLAN-G\n')
    expect(read(wt, 'u.txt')).toBe('untracked\n')
    expect(hasCarry(wt, planId)).toBe(false)
    expect(onMain()).toBe(true)
    // the file's own row with its remedy, then the backup and the steps after it
    expect(r.stderr).toContain(remedyLine(['git', 'add', '--', 'f.txt']))
    expect(r.stderr).toContain(`refs/witness/kept/${planId}/1`)
    expect(r.stderr).toContain('witness turn')
    expect(r.stderr).toContain(`witness ship ${planId}`)
    // ship records nothing for the session's own work (§4.1.3's table)
    expect(readStream(repo.root, planId).filter((e) => e.t === 'ship-outcome')).toHaveLength(0)
  }, 180_000)

  it('staged-only work survives the move (reset --hard, not checkout -- .) (P13)', async () => {
    const { wt, repo, planId, moveMain, onMain, run } = await movedPlan()
    put(wt, 'g.txt', '1\nSTAGED\n3\n')
    g(wt, 'add', 'g.txt')
    expect(porcelain(wt)).toBe('M  g.txt')
    moveMain({ 'm.txt': 'main\n' })
    expect(rebaseIfMoved(wt, repo.root, 'main', run)).toEqual({ ok: true, value: 'rebased' })
    expect(onMain()).toBe(true)
    expect(porcelain(wt)).toBe('M  g.txt')
    expect(staged(wt, 'g.txt')).toBe('1\nSTAGED\n3')
    expect(stashList(wt)).toBe('')
    expect(hasCarry(wt, planId)).toBe(false)
  }, 180_000)

  it('with rebase.autoStash=true nothing reaches the stash list (P15)', async () => {
    const { wt, repo, planId, run } = await movedClash()
    g(wt, 'config', 'rebase.autoStash', 'true')
    // P15's shape: a staged change beside the clash
    g(wt, 'add', 'g.txt')
    const r = rebaseIfMoved(wt, repo.root, 'main', run)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.violations.map((x) => x.rule)).toContain('textual-conflict')
    expect(stashList(wt)).toBe('')
    expect(porcelain(wt)).toMatch(/^UU f\.txt$/m)
    expect(keptRefs(wt, planId)).toHaveLength(1)
  }, 180_000)

  it('an intent-to-add entry refuses carry-refused before anything moves, naming git add and git reset (P14)', async () => {
    const { wt, repo, planId, moveMain } = await movedPlan()
    put(wt, 'g.txt', '1\n2\nWORK\n')
    put(wt, 'ita.txt', 'intent\n')
    g(wt, 'add', '-N', 'ita.txt')
    moveMain({ 'm.txt': 'main\n' })
    const before = { head: head(wt), status: porcelain(wt) }
    const r = await repo.cli(['ship', planId])
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/carry-refused/)
    expect(r.stderr).toContain(remedyLine(['git', 'add', '--', 'ita.txt']))
    expect(r.stderr).toContain(remedyLine(['git', 'reset', '--', 'ita.txt']))
    // nothing moved: HEAD, the tree and the files as they were; no carry ref, no stash entry
    expect(head(wt)).toBe(before.head)
    expect(porcelain(wt)).toBe(before.status)
    expect(read(wt, 'g.txt')).toBe('1\n2\nWORK\n')
    expect(read(wt, 'ita.txt')).toBe('intent\n')
    expect(hasCarry(wt, planId)).toBe(false)
    expect(stashList(wt)).toBe('')
    expect(gateRuns(readStream(repo.root, planId), 'ship')).toHaveLength(0)
  }, 180_000)

  it('a clean move: applied --index, carry ref deleted, outcome rebased', async () => {
    const { wt, repo, planId, moveMain, onMain, run } = await movedPlan()
    put(wt, 'g.txt', '1\nSTAGED\n3\n')
    g(wt, 'add', 'g.txt')
    put(wt, 'g.txt', '1\nSTAGED\nWORK\n')
    put(wt, 'f.txt', 'a\nb\nc\nd\n')
    expect(porcelain(wt)).toBe(' M f.txt\nMM g.txt')
    moveMain({ 'm.txt': 'main\n' })
    expect(rebaseIfMoved(wt, repo.root, 'main', run)).toEqual({ ok: true, value: 'rebased' })
    expect(onMain()).toBe(true)
    // both halves back exactly: the staged version staged, the worktree version on disk
    expect(porcelain(wt)).toBe(' M f.txt\nMM g.txt')
    expect(staged(wt, 'g.txt')).toBe('1\nSTAGED\n3')
    expect(read(wt, 'g.txt')).toBe('1\nSTAGED\nWORK\n')
    expect(read(wt, 'f.txt')).toBe('a\nb\nc\nd\n')
    expect(read(wt, 'm.txt')).toBe('main\n')
    expect(hasCarry(wt, planId)).toBe(false)
    expect(keptRefs(wt, planId)).toEqual([])
    expect(stashList(wt)).toBe('')
    // witness's own rebase is told from a session's by its reflog action
    expect(g(wt, 'reflog', '-n', '20', '--format=%gs', 'HEAD')).toMatch(/^witness-carry \(start\)/m)
  }, 180_000)

  it('"conflicts in index" falls back to a plain apply, and that copy is kept like a clash backup (P25)', async () => {
    const { wt, repo, planId, moveMain, run } = await movedPlan()
    // a staged-only version: staged STAGED, the worktree back at the base's line
    put(wt, 'f.txt', 'a\nSTAGED\nc\n')
    g(wt, 'add', 'f.txt')
    put(wt, 'f.txt', 'a\nb\nc\n')
    put(wt, 'g.txt', '1\n2\nWORK\n')
    moveMain({ 'f.txt': 'a\nMAIN\nc\n' })
    expect(rebaseIfMoved(wt, repo.root, 'main', run)).toEqual({ ok: true, value: 'rebased' })
    // the plain apply put the worktree side back; the staged-only version survives in the kept ref
    expect(read(wt, 'f.txt')).toBe('a\nMAIN\nc\n')
    expect(read(wt, 'g.txt')).toBe('1\n2\nWORK\n')
    const kept = keptRefs(wt, planId)
    expect(kept.map((k) => k.files)).toEqual([['f.txt']])
    expect(g(wt, 'diff', `${kept[0]!.ref}^1`, `${kept[0]!.ref}^2`)).toContain('+STAGED')
    expect(hasCarry(wt, planId)).toBe(false)
    expect(stashList(wt)).toBe('')
    // the guard reads the listed file, finds no labels, and the move proceeds
    expect(clashLeft(wt, planId, 'main')).toBeUndefined()
  }, 180_000)

  it('a replay conflict aborts, puts the work back, and refuses textual-conflict with the replay steps naming the files (P26)', async () => {
    const { wt, repo, planId, moveMain, run } = await movedPlan()
    // the plan's own commit edits line 2 of f.txt; main edits the same line
    put(wt, 'f.txt', 'a\nPLAN-COMMIT\nc\n')
    g(wt, 'commit', '-qam', 'plan edits f')
    put(wt, 'g.txt', '1\nSTAGED\n3\n')
    g(wt, 'add', 'g.txt')
    put(wt, 'g.txt', '1\nSTAGED\nWORK\n')
    moveMain({ 'f.txt': 'a\nMAIN\nc\n' })
    const before = head(wt)
    const r = rebaseIfMoved(wt, repo.root, 'main', run)
    expect(r.ok).toBe(false)
    const x = !r.ok ? r.violations : []
    expect(x.map((y) => y.rule)).toEqual(['textual-conflict'])
    expect(x[0]!.got).toContain(shellWord('f.txt'))
    // §4.1.3's four replay steps
    expect(x[0]!.want).toMatch(/commit the uncommitted work first/)
    expect(x[0]!.want).toContain(shellLine(['git', 'rebase', 'origin/main']))
    expect(x[0]!.want).toContain(remedyLine(['git', 'add', '--', 'f.txt']))
    expect(x[0]!.want).toContain(shellLine(['git', 'rebase', '--continue']))
    expect(x[0]!.want).toContain('witness turn')
    expect(x[0]!.want).toContain(`witness ship ${planId}`)
    // aborted: HEAD where it was, no operation, the work back in both halves, nothing kept or stashed
    expect(head(wt)).toBe(before)
    expect(operationInProgress(wt)).toBeUndefined()
    expect(porcelain(wt)).toBe('MM g.txt')
    expect(staged(wt, 'g.txt')).toBe('1\nSTAGED\n3')
    expect(read(wt, 'g.txt')).toBe('1\nSTAGED\nWORK\n')
    expect(hasCarry(wt, planId)).toBe(false)
    expect(keptRefs(wt, planId)).toEqual([])
    expect(stashList(wt)).toBe('')
  }, 180_000)

  // Design §4.1.1 step 6 and §4.1.5 (the first build's finding): in a witness worktree's sparse
  // checkout `git rebase` silently replaces such a file with the base's bytes and exits 0, so git
  // never gets to refuse it in its own words — the carry refuses before anything moves.
  it('an untracked file in the way refuses rebase-refused before anything moves, naming it; its bytes and the work stay', async () => {
    const { wt, repo, planId, moveMain, run } = await movedPlan()
    put(wt, 'g.txt', '1\n2\nWORK\n')
    put(wt, 'n.txt', 'the session\'s own\n')
    put(wt, 'd', 'a file where main makes a directory\n')
    moveMain({ 'n.txt': 'main\n', 'd/x.txt': 'main\n' })
    const before = { head: head(wt), status: porcelain(wt) }
    const r = rebaseIfMoved(wt, repo.root, 'main', run)
    expect(r.ok).toBe(false)
    const x = !r.ok ? r.violations : []
    expect(x.map((y) => [y.field, y.rule])).toEqual([[shellWord('d'), 'rebase-refused'], [shellWord('n.txt'), 'rebase-refused']])
    expect(read(wt, 'n.txt')).toBe('the session\'s own\n')
    expect(read(wt, 'd')).toBe('a file where main makes a directory\n')
    expect(head(wt)).toBe(before.head)
    expect(porcelain(wt)).toBe(before.status)
    expect(read(wt, 'g.txt')).toBe('1\n2\nWORK\n')
    expect(hasCarry(wt, planId)).toBe(false)
  }, 180_000)

  it('a sparse worktree\'s untracked file that the base adds is refused under core.ignorecase without regard to case (S1-2)', async () => {
    const { wt, repo, planId, moveMain, run } = await movedPlan()
    g(wt, 'config', 'core.ignorecase', 'true')
    put(wt, 'NOTES.md', 'the session\'s notes\n')
    moveMain({ 'notes.md': 'main\'s notes\n' })
    const before = head(wt)
    const r = rebaseIfMoved(wt, repo.root, 'main', run)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.violations.map((y) => [y.field, y.rule])).toEqual([[shellWord('NOTES.md'), 'rebase-refused']])
    expect(read(wt, 'NOTES.md')).toBe('the session\'s notes\n')
    expect(head(wt)).toBe(before)
    expect(hasCarry(wt, planId)).toBe(false)
  }, 180_000)

  it('a rebase git refuses (not a conflict) refuses rebase-refused in git\'s words; the work is put back', async () => {
    const { wt, repo, planId, moveMain, run } = await movedPlan()
    hook(wt, 'pre-rebase', 'echo "the hook says no" >&2\nexit 1')
    put(wt, 'g.txt', '1\nSTAGED\n3\n')
    g(wt, 'add', 'g.txt')
    put(wt, 'g.txt', '1\nSTAGED\nWORK\n')
    moveMain({ 'm.txt': 'main\n' })
    const before = head(wt)
    const r = rebaseIfMoved(wt, repo.root, 'main', run)
    expect(r.ok).toBe(false)
    const x = !r.ok ? r.violations : []
    expect(x.map((y) => y.rule)).toEqual(['rebase-refused'])
    expect(x[0]!.got).toMatch(/the hook says no|pre-rebase hook refused/)
    expect(head(wt)).toBe(before)
    expect(porcelain(wt)).toBe('MM g.txt')
    expect(staged(wt, 'g.txt')).toBe('1\nSTAGED\n3')
    expect(read(wt, 'g.txt')).toBe('1\nSTAGED\nWORK\n')
    expect(hasCarry(wt, planId)).toBe(false)
    expect(stashList(wt)).toBe('')
  }, 180_000)

  it('an operation in progress refuses operation-in-progress naming its --continue/--abort, and is never aborted (P19)', async () => {
    const { wt, repo, planId, moveMain, run } = await movedPlan()
    moveMain({ 'm.txt': 'main\n' })
    const refusedOver = (verb: string): void => {
      const at = head(wt)
      const op = operationInProgress(wt)
      expect(op).toBeDefined()
      const r = rebaseIfMoved(wt, repo.root, 'main', run)
      expect(r.ok).toBe(false)
      const x = !r.ok ? r.violations : []
      expect(x.map((y) => y.rule)).toEqual(['operation-in-progress'])
      expect(x[0]!.want).toContain(shellLine(['git', verb, '--continue']))
      expect(x[0]!.want).toContain(shellLine(['git', verb, '--abort']))
      expect(x[0]!.want).toContain(`witness ship ${planId}`)
      // never aborted, never applied into: the session's operation stands as it was
      expect(operationInProgress(wt)).toBe(op)
      expect(head(wt)).toBe(at)
      expect(hasCarry(wt, planId)).toBe(false)
    }
    // a session's own rebase, stopped by a failing --exec
    expect(tryG(wt, 'rebase', '--force-rebase', '--exec', 'false', 'HEAD~1')).toBe(false)
    refusedOver('rebase')
    g(wt, 'rebase', '--abort')
    // a session's own merge, not yet committed
    g(wt, 'branch', 'side')
    g(wt, 'checkout', '-q', 'side')
    put(wt, 's.txt', 'side\n')
    g(wt, 'add', 's.txt')
    g(wt, 'commit', '-qm', 'side')
    g(wt, 'checkout', '-q', '-')
    g(wt, 'merge', '--no-ff', '--no-commit', 'side')
    refusedOver('merge')
    g(wt, 'merge', '--abort')
    // a session's own `git am`, stopped on a patch that does not apply
    put(wt, 'f.txt', 'x\ny\nz\n')
    g(wt, 'commit', '-qam', 'rewrite f')
    const patch = g(wt, 'format-patch', '-1', '--stdout', 'HEAD')
    g(wt, 'reset', '-q', '--hard', 'HEAD~1')
    put(wt, 'f.txt', 'q\nr\ns\n')
    g(wt, 'commit', '-qam', 'diverge f')
    const am = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'am'], { cwd: wt, input: patch, encoding: 'utf8' })
    expect(am.status).not.toBe(0)
    refusedOver('am')
    g(wt, 'am', '--abort')
    expect(stashList(wt)).toBe('')
  }, 180_000)

  it('a session\'s rebase that starts under witness\'s own is never aborted: operation-in-progress, the work kept in the carry ref (P19)', async () => {
    const { wt, repo, planId, moveMain, run } = await movedPlan()
    // a session starts its own rebase as witness's begins (after step 2 and its re-check), and the
    // hook then refuses witness's: the session's rebase is what stands in the worktree afterwards
    hook(wt, 'pre-rebase', 'unset GIT_REFLOG_ACTION\ngit rebase --no-verify --force-rebase --exec false HEAD~1 >/dev/null 2>&1\nexit 1')
    put(wt, 'g.txt', '1\n2\nWORK\n')
    moveMain({ 'm.txt': 'main\n' })
    const r = rebaseIfMoved(wt, repo.root, 'main', run)
    expect(r.ok).toBe(false)
    const x = !r.ok ? r.violations : []
    expect(x.map((y) => y.rule)).toEqual(['operation-in-progress', 'carry-pending'])
    expect(x[0]!.want).toContain(shellLine(['git', 'rebase', '--continue']))
    // the reflog positively shows the session's rebase (its own `rebase (start)`): no row invites a
    // human to abort it as witness's, and the carry's cell names the session
    expect(x.some((y) => y.want.includes('its reflog cannot tell') || y.got.includes('its reflog cannot tell'))).toBe(false)
    expect(x[1]!.got).toMatch(/a session started/)
    // never aborted: the session's rebase still stands, its own entries the newest in HEAD's reflog
    expect(operationInProgress(wt)).toBe('rebase-merge')
    expect(g(wt, 'reflog', '-n', '1', '--format=%gs', 'HEAD')).toMatch(/^rebase \(/)
    expect(g(wt, 'reflog', '-n', '5', '--format=%gs', 'HEAD')).not.toMatch(/abort/)
    // nothing applied into it; the work waits in the carry ref
    expect(read(wt, 'g.txt')).toBe('1\n2\n3\n')
    expect(hasCarry(wt, planId)).toBe(true)
    expect(g(wt, 'diff', `${carryRef(planId)}^1`, carryRef(planId))).toContain('+WORK')
    expect(stashList(wt)).toBe('')
  }, 180_000)

  it('with no HEAD reflog (core.logAllRefUpdates=false) a session\'s rebase reads as the session\'s: never aborted, the step-0 sentence named', async () => {
    const { wt, repo, planId, moveMain, run } = await movedPlan()
    // a repo that keeps no HEAD reflog: silence, where witness's own rebase would have written its (start)
    g(wt, 'config', 'core.logAllRefUpdates', 'false')
    const headLog = resolve(wt, g(wt, 'rev-parse', '--git-path', 'logs/HEAD'))
    rmSync(headLog, { force: true })
    hook(wt, 'pre-rebase', 'unset GIT_REFLOG_ACTION\ngit rebase --no-verify --force-rebase --exec false HEAD~1 >/dev/null 2>&1\nexit 1')
    put(wt, 'g.txt', '1\n2\nWORK\n')
    moveMain({ 'm.txt': 'main\n' })
    expect(existsSync(headLog)).toBe(false)
    const r = rebaseIfMoved(wt, repo.root, 'main', run)
    expect(r.ok).toBe(false)
    const x = !r.ok ? r.violations : []
    expect(x.map((y) => y.rule)).toEqual(['operation-in-progress', 'carry-pending'])
    expect(x[0]!.want).toContain(`if the rebase is witness's own (its reflog cannot tell), run ${shellLine(['git', 'rebase', '--abort'])}, then re-run witness ship ${planId}`)
    // the carry's cell hedges too: the rebase may be witness's own
    expect(x[1]!.got).toContain('witness\'s own or a session\'s, its reflog cannot tell')
    // never aborted: the session's rebase stands; the work waits in the carry ref
    expect(operationInProgress(wt)).toBe('rebase-merge')
    expect(read(wt, 'g.txt')).toBe('1\n2\n3\n')
    expect(hasCarry(wt, planId)).toBe(true)
    expect(stashList(wt)).toBe('')
    // and HEAD still keeps no reflog of its own: there was none to read as proof
    expect(existsSync(headLog)).toBe(false)
  }, 180_000)

  it('a session\'s merge begun during the lease\'s fetch refuses operation-in-progress before anything moves; the reset never ends it', async () => {
    const { wt, repo, planId, moveMain, run } = await movedPlan()
    const branch = branchName(planId)
    // a PR branch witness pushed, so the lease fetches it; the tracking ref lags, so the fetch updates it
    g(wt, 'push', '-q', '-u', 'origin', branch)
    recordPushed(wt, planId, head(wt))
    g(wt, 'update-ref', `refs/remotes/origin/${branch}`, 'HEAD~1')
    g(wt, 'branch', 'side')
    g(wt, 'checkout', '-q', 'side')
    put(wt, 's.txt', 'side\n')
    g(wt, 'add', 's.txt')
    g(wt, 'commit', '-qm', 'side')
    g(wt, 'checkout', '-q', '-')
    put(wt, 'g.txt', '1\n2\nWORK\n')
    moveMain({ 'm.txt': 'main\n' })
    // as the lease's fetch moves the PR branch's tracking ref, a session starts its own merge
    const marker = join(wt, '..', `${planId}-merge-begun`)
    hook(wt, 'reference-transaction', [
      '[ "$1" = committed ] || exit 0',
      `grep -q ' refs/remotes/origin/${branch}$' || exit 0`,
      `[ -e '${marker}' ] && exit 0`,
      `: > '${marker}'`,
      'unset GIT_REFLOG_ACTION',
      'git merge --no-ff --no-commit side >/dev/null 2>&1',
      'exit 0',
    ].join('\n'))
    const before = head(wt)
    const r = rebaseIfMoved(wt, repo.root, 'main', run)
    expect(existsSync(marker)).toBe(true)
    expect(r.ok).toBe(false)
    const x = !r.ok ? r.violations : []
    expect(x.map((y) => y.rule)).toEqual(['operation-in-progress'])
    expect(x[0]!.want).toContain(shellLine(['git', 'merge', '--abort']))
    // nothing moved: the session's merge stands with its state, the work in the tree, no carry taken
    expect(operationInProgress(wt)).toBe('MERGE_HEAD')
    expect(head(wt)).toBe(before)
    expect(read(wt, 'g.txt')).toBe('1\n2\nWORK\n')
    expect(read(wt, 's.txt')).toBe('side\n')
    expect(hasCarry(wt, planId)).toBe(false)
    expect(stashList(wt)).toBe('')
  }, 180_000)

  it('a held index.lock refuses index-locked with the lock as got, and keeps the carry ref (S1-3)', async () => {
    const { wt, repo, planId, moveMain, run } = await movedPlan()
    // the lock appears once the work is captured and the tree clean: as the rebase starts
    hook(wt, 'pre-rebase', ': > "$(git rev-parse --git-path index.lock)"')
    put(wt, 'g.txt', '1\nSTAGED\n3\n')
    g(wt, 'add', 'g.txt')
    put(wt, 'g.txt', '1\nSTAGED\nWORK\n')
    moveMain({ 'm.txt': 'main\n' })
    const r = rebaseIfMoved(wt, repo.root, 'main', run)
    expect(r.ok).toBe(false)
    const x = !r.ok ? r.violations : []
    expect(x.map((y) => y.rule)).toEqual(['index-locked'])
    const lock = resolve(wt, g(wt, 'rev-parse', '--git-path', 'index.lock'))
    expect(realpathSync(x[0]!.got)).toBe(realpathSync(lock))
    expect(x[0]!.want).toContain(shellWord(x[0]!.got))
    expect(x[0]!.want).toContain(carryRef(planId))
    // the work is kept in the carry ref, both halves
    expect(hasCarry(wt, planId)).toBe(true)
    expect(g(wt, 'diff', `${carryRef(planId)}^1`, `${carryRef(planId)}^2`)).toContain('+STAGED')
    expect(g(wt, 'diff', `${carryRef(planId)}^1`, carryRef(planId))).toContain('+WORK')
    expect(stashList(wt)).toBe('')
  }, 180_000)

  it('a held carry-ref lock after a clean apply reads index-locked: ship exits 3, the carry ref kept, never clash-unresolved (S1-3, S1-6)', async () => {
    const { wt, repo, planId, moveMain } = await movedPlan()
    hook(wt, 'pre-rebase', `: > "$(git rev-parse --git-path ${carryRef(planId)}).lock"`)
    put(wt, 'g.txt', '1\nSTAGED\n3\n')
    g(wt, 'add', 'g.txt')
    put(wt, 'g.txt', '1\nSTAGED\nWORK\n')
    moveMain({ 'm.txt': 'main\n' })
    const r = await repo.cli(['ship', planId])
    expect(r.code).toBe(3)
    expect(r.stderr).toMatch(/index-locked/)
    expect(r.stderr).toContain(`${carryRef(planId)}.lock`)
    expect(r.stderr).not.toMatch(/clash-unresolved/)
    // the work is back in the tree; the ref that could not be dropped is kept, and no gate ran
    expect(porcelain(wt)).toBe('MM g.txt')
    expect(hasCarry(wt, planId)).toBe(true)
    expect(gateRuns(readStream(repo.root, planId), 'ship')).toHaveLength(0)
  }, 180_000)

  it('a failed carry-ref drop after a clean apply that is no lock refuses carry-pending, exit 2, never clash-unresolved (S1-6)', async () => {
    const { wt, repo, planId, moveMain } = await movedPlan()
    // the carry ref moves under the move: its drop, checked against the carry, fails
    hook(wt, 'pre-rebase', `git update-ref ${carryRef(planId)} HEAD`)
    put(wt, 'g.txt', '1\n2\nWORK\n')
    moveMain({ 'm.txt': 'main\n' })
    const r = await repo.cli(['ship', planId])
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/carry-pending/)
    expect(r.stderr).not.toMatch(/clash-unresolved/)
    expect(read(wt, 'g.txt')).toBe('1\n2\nWORK\n')
    expect(hasCarry(wt, planId)).toBe(true)
    expect(gateRuns(readStream(repo.root, planId), 'ship')).toHaveLength(0)
  }, 180_000)

  it('reapply never writes the carry over an untracked file where the carry or its index writes one (S1-1)', async () => {
    const { wt, planId } = await movedPlan()
    put(wt, 'n.txt', 'the plan\'s new file\n')
    g(wt, 'add', 'n.txt')
    put(wt, 'f.txt', 'a\nWORK\nc\n')
    const captured = captureCarry(wt, planId)
    expect(captured.ok && typeof captured.value).toBe('string')
    const carry = captured.ok ? captured.value! : ''
    expect(cleanTree(wt, planId)).toEqual({ ok: true, value: undefined })
    expect(existsSync(join(wt, 'n.txt'))).toBe(false)
    // a session writes its own n.txt where the carry's index adds one (step 0 meets this after a crash)
    put(wt, 'n.txt', 'the session\'s own\n')
    const put1 = reapply(wt, planId, carry)
    expect(put1.kind).toBe('refused')
    expect(put1.kind === 'refused' && put1.out).toContain(shellWord('n.txt'))
    expect(read(wt, 'n.txt')).toBe('the session\'s own\n')
    expect(read(wt, 'f.txt')).toBe('a\nb\nc\n')
    expect(hasCarry(wt, planId)).toBe(true)
    // with the file moved aside, the same carry goes back whole
    g(wt, 'clean', '-q', '-f', '--', 'n.txt')
    expect(reapply(wt, planId, carry)).toEqual({ kind: 'clean' })
    expect(staged(wt, 'n.txt')).toBe('the plan\'s new file')
    expect(read(wt, 'f.txt')).toBe('a\nWORK\nc\n')
    expect(hasCarry(wt, planId)).toBe(false)
  }, 180_000)

  // S1-8: skipped where this git has no German catalog (Apple's git), since there it prints English
  // whatever LANGUAGE says and the test would prove nothing.
  it.skipIf(!GERMAN)('under LANG=de_DE.UTF-8 and LANGUAGE=de the clash still reads as a clash (Review Focus)', async () => {
    const { repo, wt, planId } = await movedClash()
    const saved = { LANGUAGE: process.env.LANGUAGE, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_MESSAGES: process.env.LC_MESSAGES }
    process.env.LANGUAGE = 'de'
    process.env.LANG = 'de_DE.UTF-8'
    delete process.env.LC_ALL
    delete process.env.LC_MESSAGES
    try {
      const r = await repo.cli(['ship', planId])
      expect(r.code).toBe(1)
      expect(r.stderr).toMatch(/textual-conflict/)
    } finally {
      for (const [k, val] of Object.entries(saved)) {
        if (val === undefined) delete process.env[k]
        else process.env[k] = val
      }
    }
    expect(porcelain(wt)).toMatch(/^UU f\.txt$/m)
    expect(stashList(wt)).toBe('')
    expect(keptRefs(wt, planId).map((k) => k.files)).toEqual([['f.txt']])
  }, 180_000)
})
