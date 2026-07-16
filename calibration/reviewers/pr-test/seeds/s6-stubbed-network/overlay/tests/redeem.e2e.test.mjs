import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { redeemPageHtml } from '../src/redeem-page.mjs';

let browser;
let page;

before(async () => {
  browser = await puppeteer.launch({ headless: 'new' });
  page = await browser.newPage();
  // keep the test hermetic: answer the redeem API inline instead of running a server
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().endsWith('/api/redeem')) {
      const { code } = JSON.parse(req.postData() || '{}');
      if (code === 'SPRING20') {
        req.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, discount: 20 }),
        });
      } else {
        req.respond({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'unknown code' }),
        });
      }
      return;
    }
    req.continue();
  });
});

after(async () => {
  await browser.close();
});

test('valid code applies its discount in the browser @spec:promo-redeem', async () => {
  await page.setContent(redeemPageHtml());
  await page.type('#code', 'SPRING20');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => document.getElementById('result').textContent !== '');
  const text = await page.$eval('#result', (el) => el.textContent);
  assert.equal(text, '20% off applied');
});

test('unknown code surfaces the API error @spec:promo-redeem', async () => {
  await page.setContent(redeemPageHtml());
  await page.type('#code', 'BOGUS');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => document.getElementById('result').textContent !== '');
  const text = await page.$eval('#result', (el) => el.textContent);
  assert.equal(text, 'unknown code');
});
