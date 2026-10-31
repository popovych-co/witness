import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  HARNESSES, STAGE_SKILLS, handoffLine, loadHarness, relayLine,
  resolveDriver, resolveJudge, resolveSkills, skillPins, skillsVisibility, validatePin,
} from '../src/harness.js'
import { toolsFor } from '../src/reviewer.js'

const hx = (name: string) => {
  const r = loadHarness(name)
  if (!r.ok) throw new Error(JSON.stringify(r.violations))
  return r.value
}

describe('harness registry', () => {
  it('ships a descriptor for every supported harness', () => {
    expect([...HARNESSES]).toEqual(['claude-code', 'pi'])
    for (const name of HARNESSES) {
      const h = hx(name)
      expect(h.name).toBe(name)
      expect(h.launch).not.toBe('')
      expect(h.payload.length).toBeGreaterThan(0)
    }
  })

  it('refuses an unknown harness with the valid list', () => {
    const r = loadHarness('pikachu')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.violations[0]).toMatchObject({ rule: 'unknown-harness', got: 'pikachu', want: 'claude-code | pi' })
  })
})

describe('the session lane — resolveDriver, detection first', () => {
  it('WITNESS_HARNESS is dead — row 90: configuration has one home', () => {
    const r = resolveDriver({ WITNESS_HARNESS: 'pi' }, undefined)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toMatchObject({ harness: { name: 'claude-code' }, source: 'default' })
    const detected = resolveDriver({ WITNESS_HARNESS: 'claude-code', PI_CODING_AGENT: 'true' }, undefined)
    if (detected.ok) expect(detected.value.source).toBe('detected')
  })

  it('PI_CODING_AGENT outranks CLAUDECODE, which outranks config', () => {
    expect(resolveDriver({ PI_CODING_AGENT: 'true', CLAUDECODE: '1' }, 'claude-code').ok).toBe(true)
    const pi = resolveDriver({ PI_CODING_AGENT: 'true', CLAUDECODE: '1' }, 'claude-code')
    expect(pi.ok && pi.value.harness.name).toBe('pi')
    const cc = resolveDriver({ CLAUDECODE: '1' }, 'pi')
    expect(cc.ok && cc.value.harness.name).toBe('claude-code')
    expect(cc.ok && cc.value.source).toBe('detected')
  })

  // presence, not value: CLAUDECODE=1 is not a documented contract
  it('detects on presence even when the value is empty', () => {
    const r = resolveDriver({ CLAUDECODE: '' }, undefined)
    expect(r.ok && r.value.harness.name).toBe('claude-code')
  })

  it('falls back to config, then to claude-code', () => {
    const cfg = resolveDriver({}, 'pi')
    expect(cfg.ok && cfg.value.harness.name).toBe('pi')
    expect(cfg.ok && cfg.value.source).toBe('config')
    const def = resolveDriver({}, undefined)
    expect(def.ok && def.value.harness.name).toBe('claude-code')
    expect(def.ok && def.value.source).toBe('default')
  })

  // B2's shape: a config-authority default in a fresh repo emits a runnable-LOOKING,
  // unrunnable handoff behind a warning that gets scrolled past
  it('refuses an unknown value on whichever rung supplied it', () => {
    const cfg = resolveDriver({}, 'nope')
    expect(cfg.ok).toBe(false)
    if (!cfg.ok) expect(cfg.violations[0]).toMatchObject({ field: 'harness', rule: 'unknown-harness' })
  })

  // the config rung is NOT consulted when detection already answered, so a typo in a
  // key nothing reads must not brick every verb (witness check reports it instead)
  it('ignores an unreadable config value when a detection rung answered', () => {
    const r = resolveDriver({ CLAUDECODE: '1' }, 'nope')
    expect(r.ok && r.value.harness.name).toBe('claude-code')
  })
})

describe('the judgment lane — resolveJudge, declaration first', () => {
  // Row 105. A repo declaring `harness: pi`, gated from a Claude Code session, spawned
  // claude reviewers, and nothing refused. A
  // committed key binds every teammate's gates, on the same argument that puts
  // gates.model in committed config: the evidence trail is comparable across machines.
  it('a declaration outranks the ambient session', () => {
    const r = resolveJudge({ CLAUDECODE: '1' }, 'pi')
    expect(r.ok && r.value.harness.name).toBe('pi')
    expect(r.ok && r.value.source).toBe('config')
  })

  // The residual, stated so it is not mistaken for a bug: an UNDECLARED repo is still
  // judged by whatever terminal is open. Declaration is what the row makes able to win;
  // it does not make declaration mandatory, and `init` writes the key only under --agent.
  it('falls to detection, then to claude-code, when nothing is declared', () => {
    const detected = resolveJudge({ PI_CODING_AGENT: 'true' }, undefined)
    expect(detected.ok && detected.value.harness.name).toBe('pi')
    expect(detected.ok && detected.value.source).toBe('detected')
    const def = resolveJudge({}, undefined)
    expect(def.ok && def.value.harness.name).toBe('claude-code')
    expect(def.ok && def.value.source).toBe('default')
  })

  // The two lanes disagree on exactly one input, and that is the whole release.
  it('the two lanes answer differently on a declared repo in a foreign session', () => {
    const env = { CLAUDECODE: '1' }
    const declared = 'pi'
    expect(resolveJudge(env, declared).ok && resolveJudge(env, declared).value.harness.name).toBe('pi')
    expect(resolveDriver(env, declared).ok && resolveDriver(env, declared).value.harness.name).toBe('claude-code')
  })

  // The typo is no longer invisible to judgment: the config rung is rung ONE here, so it
  // refuses rather than being skipped. `check` reports it as a finding either way.
  it('refuses an unreadable declaration even when a detection rung could have answered', () => {
    const r = resolveJudge({ CLAUDECODE: '1' }, 'nope')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations[0]).toMatchObject({ field: 'harness', rule: 'unknown-harness' })
  })
})

describe('handoff and relay rendering', () => {
  it('renders the Claude Code handoff exactly as today', () => {
    expect(handoffLine(hx('claude-code'), '/w/repo', undefined))
      .toBe("cd '/w/repo' && claude '/witness'")
    expect(handoffLine(hx('claude-code'), '/w/repo', 'claude-opus-5'))
      .toBe("cd '/w/repo' && claude --model claude-opus-5 '/witness'")
  })

  // Revision 9: the provider is the harness's own default, never a config key. Pi's
  // real default is `google`, so a bare `--model claude-opus-5` resolves wrong or not
  // at all — which is why the flag is a renderer and not a string.
  it('qualifies the Pi model flag with the harness default provider', () => {
    expect(handoffLine(hx('pi'), '/w/repo', 'claude-opus-5'))
      .toBe("cd '/w/repo' && pi --model anthropic/claude-opus-5 '/witness'")
    expect(handoffLine(hx('pi'), '/w/repo', undefined))
      .toBe("cd '/w/repo' && pi '/witness'")
  })

  it('names the harness relay command', () => {
    expect(relayLine(hx('claude-code'))).toBe('/clear then /witness')
    expect(relayLine(hx('pi'))).toBe('/new then /witness')
  })
})

describe('skills visibility', () => {
  const seed = (dir: string) => {
    for (const s of STAGE_SKILLS) {
      mkdirSync(join(dir, s), { recursive: true })
      writeFileSync(join(dir, s, 'SKILL.md'), '---\nname: x\n---\n')
    }
  }

  it('reports global, project-only and absent', () => {
    const home = mkdtempSync(join(tmpdir(), 'hxhome-'))
    const root = mkdtempSync(join(tmpdir(), 'hxroot-'))
    expect(skillsVisibility({ HOME: home }, root, hx('pi'))).toBe('absent')
    seed(join(root, '.pi', 'skills'))
    expect(skillsVisibility({ HOME: home }, root, hx('pi'))).toBe('project-only')
    seed(join(home, '.pi', 'agent', 'skills'))
    expect(skillsVisibility({ HOME: home }, root, hx('pi'))).toBe('global')
  })

  it('resolveSkills returns the directory it resolved, so the pin reader can find it', () => {
    const home = mkdtempSync(join(tmpdir(), 'skhome-'))
    const root = mkdtempSync(join(tmpdir(), 'skroot-'))
    for (const s of STAGE_SKILLS) {
      mkdirSync(join(root, '.pi', 'skills', s), { recursive: true })
      writeFileSync(join(root, '.pi', 'skills', s, 'SKILL.md'),
        '---\nname: x\n---\nWITNESS="${WITNESS_BIN:-npx -y @popovych.co/witness@0.1.0}"\n')
    }
    const r = resolveSkills({ HOME: home }, root, hx('pi'))
    expect(r.scope).toBe('project-only')
    expect(r.dir).toBe(join(root, '.pi', 'skills'))
    expect(skillPins(r.dir!)).toContainEqual({ skill: 'witness-plan', pin: '0.1.0' })
  })

  it('names the six shipped stage skills', () => {
    expect([...STAGE_SKILLS].sort()).toEqual([
      'witness-brainstorm', 'witness-decompose', 'witness-design',
      'witness-implement', 'witness-plan', 'witness-ship',
    ])
  })
})

describe('reviewer contract', () => {
  const claude = hx('claude-code')
  const pi = hx('pi')

  it('claude-code spawns claude -p json with model flag and thinking as env budget', () => {
    const s = claude.reviewer.spawn({ provider: undefined, model: 'claude-fable-5', thinking: 'low' })
    expect(s.cmd).toBe('claude')
    expect(s.args).toEqual(['-p', '--output-format', 'json', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--tools', '', '--model', 'claude-fable-5'])
    expect(s.env).toEqual({ MAX_THINKING_TOKENS: '4096' })
    const off = claude.reviewer.spawn({ provider: undefined, model: 'claude-fable-5', thinking: 'off' })
    expect(off.env).toEqual({})
    const sessionDefault = claude.reviewer.spawn(undefined)
    expect(sessionDefault.args).toEqual(['-p', '--output-format', 'json', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--tools', ''])
  })

  it('pi spawns hermetic print mode with pinned thinking and provider-qualified model', () => {
    const s = pi.reviewer.spawn({ provider: 'google', model: 'gemini-3.6-pro', thinking: 'low' })
    expect(s.cmd).toBe('pi')
    expect(s.args).toEqual(['-p', '--mode', 'json', '--no-session', '--no-extensions',
      '--no-skills', '--no-context-files', '--no-tools', '--thinking', 'low', '--model', 'google/gemini-3.6-pro'])
    const bare = pi.reviewer.spawn({ provider: undefined, model: 'claude-fable-5', thinking: 'off' })
    expect(bare.args).toContain('anthropic/claude-fable-5')
    expect(bare.args).toContain('off')
    const sessionDefault = pi.reviewer.spawn(undefined)
    expect(sessionDefault.args).not.toContain('--model')
    expect(sessionDefault.args).toContain('--thinking')
  })

  it('pi renders declared extensions as -e paths INSIDE the hermetic flag set — row 89', () => {
    const s = pi.reviewer.spawn({ provider: undefined, model: 'claude-fable-5', thinking: 'off' },
      ['/home/u/.pi/agent/npm/node_modules/pi-claude-oauth-adapter'])
    expect(s.args).toEqual(['-p', '--mode', 'json', '--no-session', '--no-extensions',
      '-e', '/home/u/.pi/agent/npm/node_modules/pi-claude-oauth-adapter',
      '--no-skills', '--no-context-files', '--no-tools', '--thinking', 'off', '--model', 'anthropic/claude-fable-5'])
    // claude-code accepts and ignores the param — the key is machine config, pi-only in effect
    const c = hx('claude-code').reviewer.spawn(undefined, ['/anything'])
    expect(c.args).not.toContain('-e')
  })

  it('a reviewer is spawned with no tools, or read-only ones (issue #73)', () => {
    const pin = { provider: undefined, model: 'claude-fable-5', thinking: 'off' as const }
    expect(claude.reviewer.spawn(pin, [], 'read').args)
      .toEqual(['-p', '--output-format', 'json', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--tools', 'Read,Grep,Glob', '--model', 'claude-fable-5'])
    const p = pi.reviewer.spawn(pin, [], 'read').args
    expect(p.slice(p.indexOf('--tools'), p.indexOf('--tools') + 2)).toEqual(['--tools', 'read,grep,find,ls'])
    expect(p).not.toContain('--no-tools')
  })

  it('toolsFor gives read only to content named by path (issue #73)', () => {
    expect(toolsFor({ kind: 'screens', captures: [] })).toBe('read')
    expect(toolsFor({ kind: 'tree', root: '/r', files: [] })).toBe('none')
    expect(toolsFor({ kind: 'docs', docs: [] })).toBe('none')
    expect(toolsFor({ kind: 'design', artifact: { ids: [] }, spec: { id: 's', body: '' } })).toBe('none')
  })

  it('pi maps the extra-usage 400 to the extensions remedy, other provider errors unchanged', () => {
    const end = (errorMessage: string) => JSON.stringify({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [], stopReason: 'error', errorMessage }],
    })
    const oauth = pi.reviewer.parseEnvelope(end('400 {"type":"error","error":{"message":"Third-party apps now draw from your extra usage, not your plan limits."}}'))
    expect(oauth.ok).toBe(false)
    if (!oauth.ok) expect(oauth.violations[0]!.want).toContain('.witness/config.local.yaml')
    const other = pi.reviewer.parseEnvelope(end('529 overloaded'))
    if (!other.ok) expect(other.violations[0]!.want).toContain('check auth and billing')
  })

  it('claude-code parses the {result} envelope and pi parses the agent_end event stream', () => {
    const c = claude.reviewer.parseEnvelope(JSON.stringify({ type: 'result', result: 'VERDICT' }))
    expect(c.ok).toBe(true)
    if (c.ok) expect(c.value.text).toBe('VERDICT')
    const stream = [
      JSON.stringify({ type: 'turn_end', message: { role: 'assistant' } }),
      JSON.stringify({ type: 'agent_end', messages: [
        { role: 'user', content: [{ type: 'text', text: 'prompt' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'VERDICT' }], stopReason: 'stop' },
      ] }),
      JSON.stringify({ type: 'agent_settled' }),
    ].join('\n')
    const p = pi.reviewer.parseEnvelope(stream)
    expect(p.ok).toBe(true)
    if (p.ok) expect(p.value.text).toBe('VERDICT')
  })

  it('pi surfaces in-stream provider errors as reviewer-invocation refusals', () => {
    const stream = JSON.stringify({ type: 'agent_end', messages: [
      { role: 'assistant', content: [], stopReason: 'error', errorMessage: '400 third-party billing blocked' },
    ] })
    const r = pi.reviewer.parseEnvelope(stream)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.violations[0]!.rule).toBe('reviewer-invocation')
      expect(r.violations[0]!.got).toContain('billing')
    }
    const empty = pi.reviewer.parseEnvelope('not json at all')
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.violations[0]!.rule).toBe('envelope-unparseable')
  })

  it('validatePin refuses provider-qualified pins on claude-code and passes them on pi', () => {
    const bad = validatePin(claude, 'gates.model', 'google/gemini-3.6-pro')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.violations[0]!.rule).toBe('provider-unrunnable')
    expect(validatePin(claude, 'gates.model', 'claude-fable-5:high').ok).toBe(true)
    expect(validatePin(pi, 'gates.model', 'google/gemini-3.6-pro:low').ok).toBe(true)
  })
})

describe('worker contract', () => {
  const claude = hx('claude-code')
  const pi = hx('pi')

  it('claude-code passes the prompt as argv and bypasses its permission gate', () => {
    const s = claude.worker.spawn('IMPLEMENT THIS')
    expect(s.cmd).toBe('claude')
    expect(s.args).toEqual(['-p', 'IMPLEMENT THIS', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'])
  })

  // pi has no --dangerously-skip-permissions equivalent: its built-in tools are not
  // approval-gated, and --approve governs trusting project-local files, a different
  // axis. The worker therefore needs no bypass flag. Row 214: it streams its events, and its
  // session is kept, in drive's own folder.
  it('pi passes the prompt as argv with a transcript folder and no bypass flag', () => {
    const s = pi.worker.spawn('IMPLEMENT THIS')
    expect(s.cmd).toBe('pi')
    expect(s.args).toEqual(['-p', 'IMPLEMENT THIS', '--mode', 'json'])
    expect(pi.worker.spawn('IMPLEMENT THIS', undefined, '/s').args).toEqual(['-p', 'IMPLEMENT THIS', '--mode', 'json', '--session-dir', '/s'])
    expect(s.args).not.toContain('--no-session')
    expect(s.args.some((a) => a.includes('dangerously'))).toBe(false)
  })

  // D2: a folder of drive's own in pi's session store, one per repo, so `pi -c` in the repo stays
  // the human's; always absolute, or it would resolve inside the session's worktree (P17).
  it("pi keeps drive's sessions in a folder of their own (issue #64)", () => {
    expect(pi.worker.transcripts?.({ HOME: '/h' }, '/r/fewhats.com'))
      .toMatch(/^\/h\/\.pi\/agent\/sessions\/witness-drive\/fewhats\.com-[0-9a-f]{8}$/)
    expect(pi.worker.transcripts?.({ HOME: '/h', PI_CODING_AGENT_DIR: '/a' }, '/r/x')).toMatch(/^\/a\/sessions\/witness-drive\//)
    const bare = pi.worker.transcripts?.({ HOME: '', USERPROFILE: '' }, '/r/x') ?? ''
    expect(isAbsolute(bare)).toBe(true)
    expect(bare.startsWith(homedir())).toBe(true)
    expect(claude.worker.transcripts).toBeUndefined()
  })
})

describe('thinking-aware handoff rendering', () => {
  const claude = hx('claude-code')
  const pi = hx('pi')

  it('handoff renders the thinking suffix natively on pi', () => {
    expect(handoffLine(pi, '/wt', 'claude-fable-5:low'))
      .toBe("cd '/wt' && pi --model anthropic/claude-fable-5:low '/witness'")
    expect(handoffLine(pi, '/wt', 'google/gemini-3.6-pro'))
      .toBe("cd '/wt' && pi --model google/gemini-3.6-pro '/witness'")
  })

  it('handoff renders non-off thinking as MAX_THINKING_TOKENS on claude-code', () => {
    expect(handoffLine(claude, '/wt', 'claude-fable-5:medium'))
      .toBe("cd '/wt' && MAX_THINKING_TOKENS=8192 claude --model claude-fable-5 '/witness'")
    expect(handoffLine(claude, '/wt', 'claude-fable-5'))
      .toBe("cd '/wt' && claude --model claude-fable-5 '/witness'")
    expect(handoffLine(claude, '/wt', undefined))
      .toBe("cd '/wt' && claude '/witness'")
  })
})

describe('claude envelope errors (B4)', () => {
  it('claude: an is_error envelope is an invocation failure, not a verdict', () => {
    const h = loadHarness('claude-code')
    const r = h.ok && h.value.reviewer.parseEnvelope(JSON.stringify({ type: 'result', is_error: true, result: 'boom' }))
    expect(r && !r.ok && [r.violations[0]!.rule, r.violations[0]!.got]).toEqual(['reviewer-invocation', 'boom'])
  })
})

describe('the session facet (row 191 §4.1)', () => {
  it('names the variable each harness puts on every shell command', () => {
    expect(hx('claude-code').session).toBe('CLAUDE_CODE_SESSION_ID')
    expect(hx('pi').session).toBe('PI_SESSION_ID')
  })

  // The reading is trusted only when its session matches the harness's own variable. A
  // variable spelled anywhere but the registry is a second answer to which one that is.
  it('names session variables only in the registry', () => {
    const src = join(import.meta.dirname, '..', 'src')
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const p = join(dir, name)
      return statSync(p).isDirectory() ? walk(p) : [p]
    })
    const files = walk(src).filter((f) => f.endsWith('.ts'))
    expect(files).toContain(join(src, 'harness.ts'))
    const hits = files
      .filter((f) => f !== join(src, 'harness.ts'))
      .filter((f) => /CLAUDE_CODE_SESSION_ID|PI_SESSION_ID/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(src.length + 1))
    expect(hits).toEqual([])
  })
})
