import { describe, expect, it } from 'vitest'
import { stateFloor } from '../src/floor.js'
import { appendEntry, readStream } from '../src/journal.js'
import { version } from '../src/version.js'
import { seededRepo, tmpRepo } from './helpers.js'

// Deliberately far above any version witness will publish. A fixture written at a real
// version couples this file to package.json: the next bump makes the seeded repo's own
// stamps outrank it and the assertions invert for a reason that has nothing to do with
// the rule under test.
const line = (w: string | undefined, artifact: string) =>
  `${JSON.stringify({ v: 1, ...(w === undefined ? {} : { w }), t: 'status', artifact, from: 'a', to: 'b', cause: 'start' })}\n`

describe('every entry names the CLI that wrote it', () => {
  // The stamp is what makes the state self-describing: without it the floor would have
  // to be stored, and a stored floor is a second source of truth that can drift from
  // the entries it claims to summarise.
  it('stamps w on every appended entry', async () => {
    const repo = await seededRepo()
    appendEntry(repo.root, 'auth-hardening', { t: 'status', artifact: 'x', from: 'a', to: 'b', cause: 'start' })
    const last = readStream(repo.root, 'auth-hardening').at(-1)!
    expect(last.w).toBe(version())
  })

  // Ordering is part of the contract: `v` then `w` then the payload, so a human reading
  // raw jsonl sees schema and author before content.
  it('places w directly after v in the serialised line', async () => {
    const repo = await seededRepo()
    appendEntry(repo.root, 'auth-hardening', { t: 'status', artifact: 'x', from: 'a', to: 'b', cause: 'start' })
    const raw = repo.read('.witness/journal/auth-hardening.jsonl').trim().split('\n').at(-1)!
    expect(raw.startsWith(`{"v":1,"w":"${version()}"`)).toBe(true)
  })
})

describe('the floor is the highest version the state has seen', () => {
  // A repository whose whole history predates the stamp has no floor — and no floor is
  // silence, never zero. Treating "unstamped" as 0.0.0 would be a claim the state never
  // made, and it is the state of every repository in the field on the day this ships.
  it('is undefined when no entry carries a stamp', () => {
    const repo = tmpRepo()
    repo.write('.witness/journal/legacy.jsonl', line(undefined, 'x'))
    expect(stateFloor(repo.root)).toBeUndefined()
  })

  // Highest, not last: a downgrade writes a lower stamp after a higher one, and the floor
  // must not fall just because the most recent writer was older — that would ratify the
  // regression it exists to refuse.
  it('takes the maximum across streams, not the most recent entry', () => {
    const repo = tmpRepo()
    repo.write('.witness/journal/a.jsonl', line('99.9.0', 'x') + line('99.5.1', 'y'))
    repo.write('.witness/journal/b.jsonl', line('99.7.0', 'z'))
    expect(stateFloor(repo.root)).toEqual({ pin: '99.9.0', stream: 'a' })
  })

  // An unparseable stamp is "cannot compare", which is compareTriple's documented contract
  // and the rule both payload guards already follow: never invent a bound out of a value
  // you could not read.
  it('ignores an unparseable stamp rather than refusing on it', () => {
    const repo = tmpRepo()
    repo.write('.witness/journal/a.jsonl', line('garbage', 'x') + line('99.6.0', 'y'))
    expect(stateFloor(repo.root)?.pin).toBe('99.6.0')
  })

  // This runs on EVERY verb now, so a single unreadable line must not be able to brick the
  // whole CLI — including `floor` itself, the one verb that could unstick it. readStream's
  // strict parse is right for callers that need the entry; a bound derived from stamps is
  // not one of them.
  it('survives a corrupt line instead of bricking every verb', () => {
    const repo = tmpRepo()
    repo.write('.witness/journal/a.jsonl', '{not json at all\n' + line('99.4.0', 'y'))
    expect(stateFloor(repo.root)?.pin).toBe('99.4.0')
  })

  // A stream the running CLI wrote is a floor like any other: the common case is not a
  // hand-written fixture but a repository that has simply been used.
  it('reads the running CLI out of a repository it seeded', async () => {
    const repo = await seededRepo()
    expect(stateFloor(repo.root)?.pin).toBe(version())
  })
})
