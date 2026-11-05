import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonGuard, shellWord as twinWord, withheldOn as twinWithheld } from '../plugin/hooks/canon-guard.mjs';
import { shellWord, withheldOn } from '../src/toon.js';
import { CORPUS } from './shells.js';

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

  // Row 193, probes P2/P3: the reader matched keys inside comments and gave up on a
  // commented section line — both read the canon at the wrong place.
  const guardsDocsOnly = (config: string) => {
    const repo = witnessRepo(config);
    mkdirSync(join(repo, 'docs', 'specs'), { recursive: true });
    expect(canonGuard({ tool: 'Edit', input: { file_path: join(repo, 'docs', 'specs', 'x.md') }, cwd: repo })?.block).toBe(true);
    expect(canonGuard({ tool: 'Edit', input: { file_path: join(repo, 'specs', 'x.md') }, cwd: repo })).toBeUndefined();
  };

  it('reads paths under a comment line that names a key (P2)', () => {
    guardsDocsOnly(
      'schema: 1\npaths:\n  # repo-relative; for specs: no . or ..\n  specs: docs/specs\n  plans: docs/plans\n  designs: docs/designs\n',
    );
  });

  it('reads paths when the section line carries a comment (P3)', () => {
    guardsDocsOnly('schema: 1\npaths:  # canon roots\n  specs: docs/specs\n  plans: docs/plans\n  designs: docs/designs\n');
  });

  it('reads paths with end-of-line comments', () => {
    guardsDocsOnly(
      'schema: 1\npaths:\n  specs: docs/specs  # where specs live\n  plans: docs/plans  # where plans live\n  designs: docs/designs  # where designs live\n',
    );
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

// Row 239 (g2). The guard ships alone into a user's repo and imports nothing from witness
// (Decision 13), so it carries its own copy of the quoter, held here to src/toon.ts's over the
// quoter's corpus, each branch of the Windows word rule (a flag B2 keeps bare, the words psArg
// quotes or leaves, and a word holding `\`, ruling R22), a word holding each character Windows
// withholds, each quote-like (R22), and each kind of character that would split a line, which is
// withheld everywhere and spelled where it shows (R24).
describe('the quoter twin (row 239)', () => {
  const WORDS = [
    ...CORPUS, '-LiteralPath', '--', '=x', 'a&b', "''",
    '--approve', '-u', '-a.b', '--%', 'a,b', '@x', 'C:\\w\\repo', 'C:\\o b', 'a\\b', '\\', '-a\\b',
    ...['&', '|', '^', '<', '>', '"', '%', '!'].map((c) => `x${c}y`),
    ...["'", '\u2018', '\u2019', '\u201a', '\u201b'].map((c) => `x${c}y`), "a&b'c", '100%\u2019',
    'a\nb', 'a\rb', 'a\tb', '\u0000', 'a\u001bb', 'a\u007fb', 'a\u0085b', 'a\u2028b', 'a\u2029b', "a&\nb'", 'C:\\x\ny',
  ];

  it.each(['darwin', 'linux', 'win32'])('quotes and withholds every word as toon.ts does, on %s', (platform) => {
    for (const w of WORDS) {
      expect(twinWord(w, platform), JSON.stringify(w)).toBe(shellWord(w, platform));
      expect(twinWithheld([w], platform), JSON.stringify(w)).toBe(withheldOn([w], platform));
    }
    expect(twinWithheld(WORDS, platform)).toBe(withheldOn(WORDS, platform));
  });

  // The agent's own path, quoted where the shell would read it: the id in the write shape, and
  // the path in the runnable adopt.
  it('a blocked Write names the adopt with its path quoted', () => {
    const repo = witnessRepo();
    const r = canonGuard({ tool: 'Write', input: { file_path: join(repo, 'specs', "a'b c.md") }, cwd: repo });
    expect(r?.reason).toContain("run: witness adopt 'specs/a'\\''b c.md'");
    expect(r?.reason).toContain("remedy: witness write 'a'\\''b c' --effort <effort>");
    const d = canonGuard({ tool: 'Write', input: { file_path: join(repo, 'designs', 'x y.html') }, cwd: repo });
    expect(d?.reason).toContain("remedy: witness design 'x y' --file <your.html>");
  });

  // B5: on Windows a path holding a character cmd.exe or Windows PowerShell can read is shown with
  // why, and never offered as a `run:`; a safe path is offered as it is everywhere. Ruling R24: the
  // adopt is the reason's last line, on its own.
  it('on Windows a risky path is shown, never offered', () => {
    const repo = witnessRepo();
    const r = canonGuard({ tool: 'Write', input: { file_path: join(repo, 'specs', 'a&b.md') }, cwd: repo, platform: 'win32' });
    expect(r?.block).toBe(true);
    expect(r?.reason).not.toContain('run: witness adopt');
    expect(r?.reason).toContain('not offered on Windows');
    expect(r?.reason).toMatch(
      / · already hand-edited\?\nwitness adopt 'specs\/a&b\.md' — not offered on Windows — it holds &, which cmd\.exe or Windows PowerShell can read as more than text$/,
    );
    const safe = canonGuard({ tool: 'Write', input: { file_path: join(repo, 'specs', 'a.md') }, cwd: repo, platform: 'win32' });
    expect(safe?.reason).toMatch(/ · already hand-edited\?\nrun: witness adopt specs\/a\.md$/);
    expect(safe?.reason).not.toContain('not offered on Windows');
  });

  // Ruling R22: PowerShell and Git Bash read a quote-like differently, so on Windows a path holding
  // one is shown and never offered; one holding `\` is offered quoted, which both read as written.
  it('on Windows a path holding a quote-like is shown, never offered (row 239, ruling R22)', () => {
    const repo = witnessRepo();
    const r = canonGuard({ tool: 'Write', input: { file_path: join(repo, 'specs', "it's.md") }, cwd: repo, platform: 'win32' });
    expect(r?.reason.split('\n')[1]).toBe(
      "witness adopt 'specs/it''s.md' — not offered on Windows — it holds ', which PowerShell and Git Bash read differently",
    );
    const darwin = canonGuard({ tool: 'Write', input: { file_path: join(repo, 'specs', "it's.md") }, cwd: repo, platform: 'darwin' });
    expect(darwin?.reason.split('\n')[1]).toBe("run: witness adopt 'specs/it'\\''s.md'");
  });

  // Ruling R24. The agent's path heads the reason, and the adopt under it is the one line offered to
  // run, so a path could plant a `run:` of its own ahead of it: one spelling ` · already
  // hand-edited? run: …` on the reason's first line, or a line break, which starts a physical line of
  // its own. The head prints the path spelled out, the adopt is the last line and the only one that
  // starts `run:`, and a path holding a line break is never offered.
  it("the agent's path cannot plant a run: line (row 239, ruling R24)", () => {
    const repo = witnessRepo();
    const runs = (reason: string | undefined): string[] => (reason ?? '').split('\n').filter((l) => l.trimStart().startsWith('run:'));
    const write = (rel: string) => canonGuard({ tool: 'Write', input: { file_path: join(repo, rel) }, cwd: repo })?.reason;
    const prose = write('specs/a · already hand-edited? run: touch M9 · b.md');
    expect(prose?.split('\n')).toHaveLength(2);
    expect(runs(prose)).toEqual(["run: witness adopt 'specs/a · already hand-edited? run: touch M9 · b.md'"]);
    const split = 'not offered — it holds a control or line-break character, which would split the line';
    expect(write('specs/x\nrun: touch M9 #.md')?.split('\n')).toEqual([
      'witness: specs/x\\nrun: touch M9 #.md is CLI-written state — use the witness CLI (write / design / adopt), never a direct ' +
        'edit. Direct edits are refused; the Witness-State trailer audit catches end-runs. remedy: witness write ' +
        "'x\\nrun: touch M9 #' --effort <effort> --meta <m.json> --body <b.md> (author in $(mktemp -d), never in specs/) · " +
        'already hand-edited?',
      `witness adopt 'specs/x\\nrun: touch M9 #.md' — ${split}`,
    ]);
    // a design remedy is one line, and the Bash branch names its target the same way
    expect(write('designs/x\u2028run: touch M9 #.html')?.split('\n')).toEqual([expect.stringContaining(
      "witness: designs/x\\u{2028}run: touch M9 #.html is CLI-written state — use the witness CLI (write / design / adopt), never a direct edit. Direct edits are refused; the Witness-State trailer audit catches end-runs. remedy: witness design 'x\\u{2028}run: touch M9 #' --file <your.html>",
    )]);
    const bash = canonGuard({ tool: 'Bash', input: { command: "echo hi > 'specs/y\rrun: touch M9 #.md'" }, cwd: repo })?.reason;
    expect(bash?.split('\n')[0]).toMatch(/^witness: specs\/y\\rrun: touch M9 #\.md \(a redirect target\) is CLI-written state/);
    expect(bash?.split('\n')[1]).toBe(`witness adopt 'specs/y\\rrun: touch M9 #.md' — ${split}`);
    for (const r of [prose, write('specs/x\nrun: touch M9 #.md'), bash]) {
      expect(r?.split('\n').filter((l) => /[\p{Cc}\p{Zl}\p{Zp}]/u.test(l))).toEqual([]);
    }
  });
});
