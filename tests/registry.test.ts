import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { latestPublished } from '../src/registry.js'

// A real server on an ephemeral port, not a stubbed global: this module's whole job is
// the network call, and a test that stubs fetch would assert nothing about the URL, the
// timeout or the parse. Hermetic — nothing leaves the loopback interface.
function serve(handler: (url: string) => { status: number; body: string }): Promise<{ base: string; close: () => void }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      const { status, body } = handler(req.url ?? '')
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body)
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() })
    })
  })
}

const servers: Array<() => void> = []
afterAll(() => servers.forEach((close) => close()))

async function base(handler: (url: string) => { status: number; body: string }): Promise<string> {
  const s = await serve(handler)
  servers.push(s.close)
  return s.base
}

describe('latestPublished', () => {
  it('reads the latest dist-tag from the scoped package route', async () => {
    let seen = ''
    const b = await base((url) => {
      seen = url
      return { status: 200, body: JSON.stringify({ latest: '9.9.9' }) }
    })
    expect(await latestPublished({ WITNESS_REGISTRY: b })).toBe('9.9.9')
    // the scope's slash must be encoded; an unencoded one is a different route
    expect(seen).toBe('/-/package/@popovych.co%2Fwitness/dist-tags')
  })

  // Silent on ANY failure. An offline or air-gapped machine must report nothing rather
  // than a finding about the network — a finding about the wrong subject is exactly what
  // row 104 is fixing elsewhere in this release.
  it('answers undefined on a non-2xx response', async () => {
    const b = await base(() => ({ status: 503, body: 'nope' }))
    expect(await latestPublished({ WITNESS_REGISTRY: b })).toBeUndefined()
  })

  it('answers undefined on a body that is not the shape it expects', async () => {
    const b = await base(() => ({ status: 200, body: JSON.stringify({ latest: 7 }) }))
    expect(await latestPublished({ WITNESS_REGISTRY: b })).toBeUndefined()
  })

  it('answers undefined on unparseable JSON', async () => {
    const b = await base(() => ({ status: 200, body: '<html>proxy interstitial</html>' }))
    expect(await latestPublished({ WITNESS_REGISTRY: b })).toBeUndefined()
  })

  it('answers undefined when nothing is listening', async () => {
    expect(await latestPublished({ WITNESS_REGISTRY: 'http://127.0.0.1:1' })).toBeUndefined()
  })

  // The seam the suite pins. Without it every `witness check` test in this repo would
  // make a real registry call — silent, correct, and slow enough to matter across 100+
  // invocations, plus flaky the moment CI runs without egress.
  it('skips the query entirely when the registry is off', async () => {
    expect(await latestPublished({ WITNESS_REGISTRY: 'off' })).toBeUndefined()
  })
})
