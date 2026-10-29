import { beforeEach } from 'vitest'
import { scenariosMade, trailsSince } from './helpers.js'

// A test that fails while fake reviewers ran prints their trails: a gate run turns the fake's own
// stderr into a refusal row (cut to 200 characters) or nothing at all, so a barrier that never
// filled or a count off by one would otherwise fail with no account of the calls behind it.
beforeEach((ctx) => {
  const from = scenariosMade.length
  ctx.onTestFailed(() => {
    const trails = trailsSince(from)
    if (trails) console.error(trails)
  })
})
