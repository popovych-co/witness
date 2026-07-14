import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slug.mjs';

test('lowercases and hyphenates', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});
