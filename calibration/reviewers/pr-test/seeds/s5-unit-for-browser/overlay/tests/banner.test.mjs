import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderBanner, mountBanner } from '../src/banner.mjs';

// minimal DOM/storage doubles — enough surface for banner.mjs
function fakeElement(tag) {
  const classes = new Set();
  return {
    tagName: tag,
    textContent: '',
    attrs: {},
    children: [],
    listeners: {},
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); for (const c of v.split(' ')) classes.add(c); },
    classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    append(...kids) { this.children.push(...kids); },
  };
}

beforeEach(() => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  globalThis.document = {
    createElement: fakeElement,
    body: { mounted: [], prepend(el) { this.mounted.unshift(el); } },
  };
});

test('banner renders message and a dismiss control @spec:promo-banner', () => {
  const el = renderBanner('Spring sale');
  const text = el.children.find((c) => c.className.includes('promo-banner__text'));
  const button = el.children.find((c) => c.className.includes('promo-banner__dismiss'));
  assert.equal(text.textContent, 'Spring sale');
  assert.equal(button.attrs['aria-label'], 'Dismiss');
});

test('dismiss hides the banner and persists the choice @spec:promo-banner', () => {
  const el = renderBanner('Spring sale');
  const button = el.children.find((c) => c.className.includes('promo-banner__dismiss'));
  button.listeners.click();
  assert.ok(el.classList.contains('promo-banner--hidden'));
  assert.equal(localStorage.getItem('promo-dismissed'), '1');
});

test('undismissed banner mounts at the top of the page @spec:promo-banner', () => {
  const el = mountBanner('Spring sale');
  assert.equal(document.body.mounted[0], el);
  assert.ok(el.children.some((c) => c.className.includes('promo-banner__text')));
});

test('dismissed banner never remounts @spec:promo-banner', () => {
  localStorage.setItem('promo-dismissed', '1');
  assert.equal(mountBanner('Spring sale'), null);
  assert.equal(document.body.mounted.length, 0);
});
