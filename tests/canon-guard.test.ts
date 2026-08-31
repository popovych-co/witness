import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonGuard } from '../plugin/hooks/canon-guard.mjs';

function witnessRepo(config = 'schema: 1\n'): string {
  const dir = mkdtempSync(join(tmpdir(), 'canonguard-'));
  writeFileSync(join(dir, 'witness.config.yaml'), config);
  for (const d of ['specs', 'plans', 'src']) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}

describe('canonGuard — Claude Code input shape', () => {
  it('blocks Edit/Write/MultiEdit on canon paths and names the relative path', () => {
    const repo = witnessRepo();
    const r = canonGuard({ tool: 'Edit', input: { file_path: join(repo, 'specs', 'a.md') }, cwd: repo });
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain('specs/a.md');
    expect(r?.reason).toContain('witness CLI (write / design / adopt)');
    expect(canonGuard({ tool: 'Write', input: { file_path: join(repo, 'plans', 'p.md') }, cwd: repo })?.block).toBe(true);
    expect(canonGuard({ tool: 'MultiEdit', input: { file_path: join(repo, 'specs', 'sub', 'd.md') }, cwd: repo })?.block).toBe(true);
  });

  it('allows non-canon paths, prefix look-alikes and non-witness repos', () => {
    const repo = witnessRepo();
    mkdirSync(join(repo, 'specsy'), { recursive: true });
    expect(canonGuard({ tool: 'Edit', input: { file_path: join(repo, 'src', 'x.ts') }, cwd: repo })).toBeUndefined();
    expect(canonGuard({ tool: 'Edit', input: { file_path: join(repo, 'specsy', 'x.md') }, cwd: repo })).toBeUndefined();
    const plain = mkdtempSync(join(tmpdir(), 'plain-'));
    mkdirSync(join(plain, 'specs'), { recursive: true });
    expect(canonGuard({ tool: 'Edit', input: { file_path: join(plain, 'specs', 'a.md') }, cwd: plain })).toBeUndefined();
  });
});

describe('canonGuard — Pi input shape', () => {
  it('blocks write/edit on `path`, the key pi actually sends', () => {
    const repo = witnessRepo();
    expect(canonGuard({ tool: 'write', input: { path: join(repo, 'specs', 'a.md') }, cwd: repo })?.block).toBe(true);
    expect(canonGuard({ tool: 'edit', input: { path: 'plans/p.md' }, cwd: repo })?.block).toBe(true);
    expect(canonGuard({ tool: 'write', input: { path: join(repo, 'src', 'x.ts') }, cwd: repo })).toBeUndefined();
  });

  it('blocks lowercase bash the same way as Bash', () => {
    const repo = witnessRepo();
    expect(canonGuard({ tool: 'bash', input: { command: 'echo hi > specs/a.md' }, cwd: repo })?.block).toBe(true);
    expect(canonGuard({ tool: 'bash', input: { command: 'cat specs/a.md' }, cwd: repo })).toBeUndefined();
  });
});

describe('canonGuard — configured canon roots', () => {
  it('follows flow-style and block-style paths:, releasing the defaults', () => {
    const flow = witnessRepo('schema: 1\npaths: { specs: docs/specs, plans: docs/plans }\n');
    mkdirSync(join(flow, 'docs', 'specs'), { recursive: true });
    expect(canonGuard({ tool: 'Edit', input: { file_path: join(flow, 'docs', 'specs', 'a.md') }, cwd: flow })?.block).toBe(true);
    expect(canonGuard({ tool: 'Edit', input: { file_path: join(flow, 'specs', 'a.md') }, cwd: flow })).toBeUndefined();

    const block = witnessRepo('schema: 1\npaths:\n  specs: docs/specs\n  plans: docs/plans\n');
    mkdirSync(join(block, 'docs', 'specs'), { recursive: true });
    expect(canonGuard({ tool: 'Write', input: { file_path: join(block, 'docs', 'specs', 'a.md') }, cwd: block })?.block).toBe(true);
  });
});

// Row 133. The old Bash branch blocked when a state path and a writeish token CO-OCCURRED
// anywhere in the command string, which biased toward false positives — failing CLOSED on
// ambiguity, against the file's own stated contract. Measured against the reporter's
// commands: `grep "Do not touch" <plan>` blocked because \btouch\b matched inside the SEARCH
// STRING, so the diagnosis was blocked by the words being searched FOR.
describe('canonGuard — Bash blocks mutations, not mentions', () => {
  const docsRepo = () =>
    witnessRepo('schema: 1\npaths: { specs: docs/specs, plans: docs/plans, designs: docs/designs }\n');
  const bash = (command: string, cwd: string) => canonGuard({ tool: 'Bash', input: { command }, cwd });

  it('allows every measured false positive', () => {
    const repo = docsRepo();
    for (const cmd of [
      'wc -l docs/plans/p1.md',
      'grep "Do not touch" docs/plans/p1.md',
      "cat > /tmp/issue.md <<'EOF'\nsee docs/plans/p1.md\nEOF",
      'grep -n foo docs/plans/p1.md > /tmp/out.txt',
      'git log --oneline -- docs/plans/p1.md',
      'cat docs/plans/p1.md',
      'diff docs/plans/p1.md docs/plans/p2.md',
      'cp docs/plans/p1.md /tmp/x.md',            // copying canon OUT is a read
      'npm test 2>&1 | grep docs/plans/p1.md',
    ]) expect(bash(cmd, repo), cmd).toBeUndefined();
  });

  it('still blocks every mutation the co-occurrence guard caught', () => {
    const repo = docsRepo();
    for (const cmd of [
      'echo hi > docs/plans/p1.md',
      'echo hi >> docs/plans/p1.md',
      "sed -i '' s/a/b/ docs/plans/p1.md",
      'cp /tmp/x.md docs/plans/p1.md',
      'rm docs/plans/p1.md',
      'rm -rf docs/specs',
      'mv docs/plans/p1.md /tmp/x',               // the source is destroyed
      'touch docs/plans/p2.md',
      'truncate -s 0 docs/plans/p1.md',
      'dd of=docs/plans/p1.md',
      'cat x | tee docs/plans/p1.md',
      'git rm docs/plans/p1.md',
      'git mv docs/plans/p1.md docs/plans/p2.md',
      'npm test 2> docs/plans/p1.md',
    ]) expect(bash(cmd, repo)?.block, cmd).toBe(true);
  });

  // The regression the blank-then-match shape invites: matching targets against the BLANKED
  // text would let a quoted path fall open, and quoted paths are how agents usually spell
  // them. Targets are resolved from the ORIGINAL command through preserved offsets.
  it('blocks a quoted mutation target — quoting hides nothing', () => {
    const repo = docsRepo();
    for (const cmd of [
      'echo hi > "docs/plans/p1.md"',
      "sed -i '' 's/a/b/' \"docs/plans/p1.md\"",
      "tee 'docs/plans/p1.md'",
      'sed -i.bak s/a/b/ docs/plans/p1.md',
      'sed --in-place s/a/b/ docs/plans/p1.md',
    ]) expect(bash(cmd, repo)?.block, cmd).toBe(true);
  });

  it('resolves a target through the filesystem, not through its spelling', () => {
    const repo = docsRepo();
    expect(bash(`echo hi > ${join(repo, 'docs', 'plans', 'p1.md')}`, repo)?.block).toBe(true);
    expect(bash('echo hi > ./docs/plans/p1.md', repo)?.block).toBe(true);
    expect(bash('echo hi > ../docs/plans/p1.md', join(repo, 'src'))?.block).toBe(true);
    // a look-alike outside the repo is not this repo's canon
    expect(bash('echo hi > /tmp/docs/plans/p1.md', repo)).toBeUndefined();
    expect(bash('echo hi > docs/plansy/p1.md', repo)).toBeUndefined();
  });

  it('names the resolved target and what mutates it', () => {
    const repo = docsRepo();
    const r = bash("sed -i '' s/a/b/ docs/plans/p1.md", repo);
    expect(r?.reason).toContain('docs/plans/p1.md');
    expect(r?.reason).toContain('sed');
    expect(bash('echo hi > docs/plans/p1.md', repo)?.reason).toContain('redirect');
  });

  // Quote-stripping is not shell parsing, and the guard is friction rather than the
  // guarantee (D31) — so these fall OPEN by construction, and the only contract is that
  // nothing throws.
  it('falls open on what it cannot parse, and never throws', () => {
    const repo = docsRepo();
    for (const cmd of [
      "$(printf '>') docs/plans/p.md",
      'eval "echo hi > docs/plans/p1.md"',
      'echo hi > "docs/plans/p1.md',                    // unterminated quote
      'P=docs/plans/p1.md; echo hi > "$P"',
      "cat <<EOF\nnot a real heredoc terminator\n",
      // a `cd` inside the command moves the base a relative target resolves against, and
      // emulating shell state is what this guard refuses to do
      'cd src && echo hi > ../docs/plans/p1.md',
    ]) expect(() => bash(cmd, repo), cmd).not.toThrow();
  });
});

describe('canonGuard — fail open', () => {
  it('returns undefined for unknown tools, missing input and garbage', () => {
    const repo = witnessRepo();
    expect(canonGuard({ tool: 'Glob', input: { pattern: 'specs/**' }, cwd: repo })).toBeUndefined();
    expect(canonGuard({ tool: 'Write', input: undefined, cwd: repo })).toBeUndefined();
    expect(canonGuard({ tool: 'Write', input: { file_path: 42 }, cwd: repo })).toBeUndefined();
    expect(canonGuard({ tool: '', input: {}, cwd: '' })).toBeUndefined();
  });
});

// D146. D133 made the reason name the path and what writes it; this completes it to the
// remedy contract gate stops already honor (D121) — a shape where no id is resolvable, a
// fully runnable `adopt` for an edit already made.
describe('canonGuard — the refusal names the way back in', () => {
  it('a blocked spec edit names the write shape and a runnable adopt', () => {
    const repo = witnessRepo();
    const r = canonGuard({ tool: 'Edit', input: { file_path: join(repo, 'specs', 'auth-refresh.md') }, cwd: repo });
    expect(r?.block).toBe(true);
    expect(r?.reason).toContain('witness write auth-refresh --effort');
    expect(r?.reason).toContain('witness adopt specs/auth-refresh.md');
  });

  it('a blocked plan edit names the plans dir it must not author in', () => {
    const repo = witnessRepo();
    const r = canonGuard({ tool: 'Write', input: { file_path: join(repo, 'plans', 'auth-refresh-plan-1.md') }, cwd: repo });
    expect(r?.reason).toContain('witness write auth-refresh-plan-1 --effort');
    expect(r?.reason).toContain('never in plans/');
  });

  it('a blocked design edit names the design verb, never write', () => {
    const repo = witnessRepo();
    const r = canonGuard({ tool: 'Write', input: { file_path: join(repo, 'designs', 'report-view.html') }, cwd: repo });
    expect(r?.reason).toContain('witness design report-view');
    expect(r?.reason).not.toContain('witness write');
  });

  // The remedy resolves the canon roots the same way the block does, so a relocated
  // designs/ still gets the design verb rather than the write shape.
  it('follows relocated canon roots', () => {
    const repo = witnessRepo('schema: 1\npaths: { designs: docs/designs }\n');
    const r = canonGuard({ tool: 'Write', input: { file_path: join(repo, 'docs', 'designs', 'x.html') }, cwd: repo });
    expect(r?.reason).toContain('witness design x');
  });

  it('names the resolved target for a blocked bash mutation too', () => {
    const repo = witnessRepo();
    const r = canonGuard({ tool: 'Bash', input: { command: 'echo hi > specs/a.md' }, cwd: repo });
    expect(r?.reason).toContain('specs/a.md (a redirect target)');
    expect(r?.reason).toContain('witness adopt specs/a.md');
  });
});
