import { describe, expect, it } from 'vitest'
import { approve, DESIGN_HTML, seededRepo, writeDesign, writePlan, writeSpec } from './helpers.js'
import { CONTROLS_NOTE } from '../src/design.js'
import { worktreePath } from '../src/worktree.js'

const PLAN_REL = 'plans/auth-refresh-plan-1.md'

async function planRepo() {
  const repo = await seededRepo()
  await writeSpec(repo, 'auth-refresh')
  approve(repo, 'auth-refresh')
  await writePlan(repo, 'auth-refresh-plan-1')
  repo.flipStatus('auth-refresh-plan-1', 'approved')
  return repo
}

async function uiRepo(html = DESIGN_HTML) {
  const repo = await seededRepo()
  await writeSpec(repo, 'booking-form', { ui: true, criteria: [{ id: 'ac-rotate', test: '@spec:booking-form' }] })
  approve(repo, 'booking-form')
  await writeDesign(repo, 'booking-form', html)
  return repo
}

describe('witness read', () => {
  it('prints a plan whole from inside the worktree — current canon, not a copy', async () => {
    const repo = await planRepo()
    await repo.cli(['start', 'auth-refresh-plan-1'])
    const wt = worktreePath(repo.root, 'auth-refresh-plan-1')
    // amend on main AFTER start — the read must see v2 though the wt carries no file
    repo.write(PLAN_REL, repo.read(PLAN_REL).replace('Implement rotation', 'Implement rotation AND REVOCATION'))
    repo.git('add', PLAN_REL)
    repo.git('commit', '-m', 'amend', '-m', 'Witness-State: 1')
    const r = await repo.cli(['read', 'auth-refresh-plan-1'], { cwd: wt })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('AND REVOCATION')
    expect(r.stdout).toContain('id: auth-refresh-plan-1')
  })

  it('reads a spec whole', async () => {
    const repo = await planRepo()
    const r = await repo.cli(['read', 'auth-refresh'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('## Behavior')
  })

  it('reads the design artifact for a ui spec', async () => {
    const repo = await uiRepo()
    const r = await repo.cli(['read', 'booking-form', '--design'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('id="save-bar"')
  })

  it('outlines a design by element id with line ranges', async () => {
    const repo = await uiRepo()
    const r = await repo.cli(['read', 'booking-form', '--design', '--outline'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('outline[3]{anchor,lines}:')
    expect(r.stdout).toContain('save-bar')
    expect(r.stdout).toMatch(/\d+-\d+/)
  })

  it('outlines a markdown artifact by heading, over the same lines --lines slices', async () => {
    const repo = await planRepo()
    const r = await repo.cli(['read', 'auth-refresh-plan-1', '--outline'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('## Step: s1')
    const range = /## Step: s1,(\d+)-(\d+)/.exec(r.stdout)
    expect(range).toBeTruthy()
    const slice = await repo.cli(['read', 'auth-refresh-plan-1', '--lines', `${range![1]}-${range![2]}`])
    expect(slice.code).toBe(0)
    expect(slice.stdout).toContain('## Step: s1')
    expect(slice.stdout).toContain('Implement rotation with TDD.')
  })

  it('slices by line range', async () => {
    const repo = await planRepo()
    const r = await repo.cli(['read', 'auth-refresh-plan-1', '--lines', '1-3'])
    expect(r.code).toBe(0)
    expect(r.stdout.trimEnd().split('\n')).toHaveLength(3)
    expect(r.stdout.startsWith('---')).toBe(true)   // serialized doc opens with frontmatter
  })

  it('refuses an unknown id, a spec with no design, and a bad range', async () => {
    const repo = await seededRepo()
    await writeSpec(repo, 'auth-refresh')
    const unknown = await repo.cli(['read', 'nope'])
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('unknown-id')
    const noDesign = await repo.cli(['read', 'auth-refresh', '--design'])
    expect(noDesign.code).toBe(2)
    expect(noDesign.stderr).toContain('no-design')
    const bad = await repo.cli(['read', 'auth-refresh', '--lines', '9-3'])
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('bad-range')
    const junk = await repo.cli(['read', 'auth-refresh', '--lines', 'top'])
    expect(junk.code).toBe(2)
    expect(junk.stderr).toContain('bad-range')
    // a start past the last line prints nothing at all — refuse instead of answering with
    // silence, and name the line count so the retry is computable
    const past = await repo.cli(['read', 'auth-refresh', '--lines', '9000-9001'])
    expect(past.code).toBe(2)
    expect(past.stderr).toContain('bad-range')
  })

  it("a look's outline lists its controls after the anchors, and names what markup cannot show (issue #73)", async () => {
    const repo = await uiRepo(DESIGN_HTML.replace('<button>Save</button>',
      '<select id="reason"><option>Unsafe code</option><option>Other</option></select><button>Save</button>'))
    const r = await repo.cli(['read', 'booking-form', '--design', '--outline'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('controls[1]{anchor,line,kind,holds}:\n  reason,6,select,Unsafe code | Other')
    expect(r.stdout).toContain(`controls-note: ${CONTROLS_NOTE}`)
    expect(r.stdout.indexOf('outline[')).toBeLessThan(r.stdout.indexOf('controls['))
  })

  it('a look with no controls still prints the table and the note; a markdown outline has neither (issue #73)', async () => {
    expect((await (await uiRepo()).cli(['read', 'booking-form', '--design', '--outline'])).stdout).toContain('controls[0]{anchor,line,kind,holds}:')
    expect((await (await planRepo()).cli(['read', 'auth-refresh-plan-1', '--outline'])).stdout).not.toContain('controls-note:')
  })
})

const LIMITS = {
  decisions: [{ id: 'd1', text: 'Rotation is server-side' }],
  constraints: [{ id: 'c1', text: 'No new dependencies' }],
  non_goals: [{ id: 'n1', text: 'No SSO changes' }],
}
async function decisionsRepo() {
  const repo = await seededRepo()
  await repo.cli(['recap', '--amend', '--file', repo.writeRecap(LIMITS)])
  await writeSpec(repo, 'auth-refresh', { carries: ['d1'] })
  return repo
}

describe('witness read --decisions (row 198)', () => {
  it("--decisions prints what a spec carries with its effort's limits", async () => {
    const repo = await decisionsRepo()
    const r = await repo.cli(['read', 'auth-refresh', '--decisions'])
    expect(r.code).toBe(0)
    expect(r.stdout.split('\n')).toEqual([
      'carried-by: auth-hardening',
      'decisions[1]{id,text}:', '  d1,Rotation is server-side',
      'constraints[1]{id,text}:', '  c1,No new dependencies',
      'non_goals[1]{id,text}:', '  n1,No SSO changes',
    ])
  })

  it('--decisions on an effort prints its whole recap', async () => {
    const repo = await decisionsRepo()
    const r = await repo.cli(['read', 'auth-hardening', '--decisions'])
    expect(r.code).toBe(0)
    const lines = r.stdout.split('\n')
    expect(lines[0]).toBe('effort: auth-hardening · feature')
    expect(lines).toContain('goals[1]{id,text}:')
    expect(lines).toContain('  g1,Refresh tokens rotate before expiry')
    expect(lines.some((l) => l.startsWith('slices['))).toBe(true)
  })

  it('--decisions is its own mode', async () => {
    const repo = await decisionsRepo()
    const mixed = await repo.cli(['read', 'auth-refresh', '--decisions', '--outline'])
    expect(mixed.code).toBe(2)
    expect(mixed.stderr).toContain('exclusive')
    expect((await repo.cli(['read', 'auth-refresh', '--outline'])).stdout).not.toContain('decisions[')
    const whole = (await repo.cli(['read', 'auth-refresh'])).stdout.split('\n')
    expect((await repo.cli(['read', 'auth-refresh', '--lines', '1-3'])).stdout.split('\n')).toEqual(whole.slice(0, 3))
    approve(repo, 'auth-refresh')
    await writePlan(repo, 'auth-refresh-plan-1')
    const plan = await repo.cli(['read', 'auth-refresh-plan-1', '--decisions'])
    expect(plan.code).toBe(2)
    expect(plan.stderr).toContain('not-a-spec')
    const nope = await repo.cli(['read', 'nope', '--decisions'])
    expect(nope.code).toBe(2)
    expect(nope.stderr).toContain('unknown-id')
    repo.setMeta('auth-refresh', { summary: 'hand edited' })
    expect((await repo.cli(['read', 'auth-refresh', '--decisions'])).stdout)
      .toMatch(/^carried-by: none — no journaled write made this content/)
  })
})
