import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsRotation } from '../src/token.mjs';

test('rotates only inside the five-minute window @spec:auth-refresh', () => {
  const now = 1_000_000;
  assert.equal(needsRotation({ expiresAt: now + 4 * 60 * 1000 }, now), true);
  assert.equal(needsRotation({ expiresAt: now + 6 * 60 * 1000 }, now), false);
});
