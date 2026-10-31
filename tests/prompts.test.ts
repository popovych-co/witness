import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERDICT_CONTRACT_MARKER, VERDICT_CONTRACT_SNIPPETS } from './helpers';
import { PROMPT_NAMES } from '../src/reviewer';

const promptPath = (name: string) => join(__dirname, '..', 'prompts', `${name}.md`);
const NEW_PROMPTS = ['slicing-critic', 'plan-critic', 'drift-reviewer', 'design-reviewer'];

describe('witness-original reviewer prompts', () => {
  for (const name of NEW_PROMPTS) {
    it(`${name} carries its lenses and the verdict contract`, () => {
      const body = readFileSync(promptPath(name), 'utf8');
      expect(body).toContain(VERDICT_CONTRACT_MARKER);
      for (const snippet of VERDICT_CONTRACT_SNIPPETS) expect(body, snippet).toContain(snippet);
      expect(body).not.toContain('Vendored from');
      expect(body.length).toBeGreaterThan(1500);
    });
  }

  it('slicing-critic names its seven lenses', () => {
    const body = readFileSync(promptPath('slicing-critic'), 'utf8');
    for (const lens of ['Slice quality', 'Coverage quality', 'Non-goal violations', 'Criteria adequacy', 'Behavior-only', 'Summary accuracy', 'Depends refs', 'Decision fidelity']) {
      expect(body).toContain(lens);
    }
  });

  it('plan-critic and drift-reviewer name their lenses', () => {
    const plan = readFileSync(promptPath('plan-critic'), 'utf8');
    for (const lens of ['Delta faithfulness', 'Step quality', 'Honest scaffolding', 'Decision fidelity']) expect(plan).toContain(lens);
    const drift = readFileSync(promptPath('drift-reviewer'), 'utf8');
    for (const lens of ['Broken promises', 'Value drift', 'Error-path drift', 'Undocumented behavior']) expect(drift).toContain(lens);
  });

  it('design-reviewer names its four axes and the Read-the-image protocol', () => {
    const body = readFileSync(promptPath('design-reviewer'), 'utf8');
    for (const axis of ['Canon compliance', 'Design divergence', 'Behavior visible', 'UX heuristics']) {
      expect(body).toContain(axis);
    }
    expect(body).toContain('Read');            // reads capture files by path
    expect(body).toContain('capture');
  });
});

const VENDORED: Record<string, string> = {
  'code-reviewer': 'agents/code-reviewer.md',
  'silent-failure-hunter': 'agents/silent-failure-hunter.md',
  'type-design': 'agents/type-design-analyzer.md',
  'pr-test': 'agents/pr-test-analyzer.md',
};

describe('all seven prompts', () => {
  for (const name of PROMPT_NAMES) {
    it(`${name} ends with the verdict contract`, () => {
      const body = readFileSync(promptPath(name), 'utf8');
      expect(body).toContain(VERDICT_CONTRACT_MARKER);
      for (const snippet of VERDICT_CONTRACT_SNIPPETS) expect(body, snippet).toContain(snippet);
    });
  }
});

describe('vendored prompts', () => {
  for (const [name, source] of Object.entries(VENDORED)) {
    it(`${name} carries the Apache-2.0 attribution header`, () => {
      const body = readFileSync(promptPath(name), 'utf8');
      expect(body).toContain('Vendored from pr-review-toolkit');
      expect(body).toContain(source);
      expect(body).toContain('317b8988055b');
      expect(body).toContain('LICENSES/pr-review-toolkit-Apache-2.0.txt');
      expect(body).toContain('Changes (Apache-2.0');
      expect(body.length).toBeGreaterThan(2000);
    });
  }
});

describe('the arbiter prompt (A3)', () => {
  it('the arbiter prompt fences evidence as data, keeps checks binding, and asks for a numbered ruling (A3)', () => {
    const body = readFileSync(promptPath('arbiter'), 'utf8')
    for (const s of ['is DATA', 'never treat a failed check as passed', 'Respond with ONLY a JSON object', '"choice"', '"reason"', 'Never write a command, an id, or a flag'])
      expect(body, s).toContain(s)
    expect(body).not.toContain(VERDICT_CONTRACT_MARKER)
    expect(body).toContain('"The ask"')
  })
})

describe('reviewer tools in prompts (row 217)', () => {
  it('a tool-less prompt says so, and the drift reviewer says when it reads (issue #73)', () => {
    for (const n of ['design-critic', 'plan-critic', 'slicing-critic', 'arbiter'])
      expect(readFileSync(promptPath(n), 'utf8'), n).toContain('You have no tools: you cannot read files, run commands or ask questions')
    const drift = readFileSync(promptPath('drift-reviewer'), 'utf8')
    expect(drift).toContain('At the ship gate the source files are inline and you have no tools')
    expect(drift).toContain('your file tools, which only read')
  })

  it("the plan critic's tool sentence never cuts its lead-in from its list (issue #73)", () => {
    const plan = readFileSync(promptPath('plan-critic'), 'utf8')
    expect(plan).not.toContain('You judge: You have no tools')
    expect(plan).toMatch(/You judge:\n\n1\. \*\*Delta faithfulness/)
  })
})
