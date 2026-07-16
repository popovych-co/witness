import { createServer } from 'node:http';

// promo codes with a bounded number of uses — redeeming decrements
const codes = new Map([
  ['SPRING20', { discount: 20, remaining: 3 }],
  ['WELCOME10', { discount: 10, remaining: 1 }],
]);

export function createRedeemServer() {
  return createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/redeem') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const { code } = JSON.parse(body || '{}');
      const entry = codes.get(code);
      if (!entry) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown code' }));
        return;
      }
      if (entry.remaining === 0) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'code exhausted' }));
        return;
      }
      entry.remaining -= 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, discount: entry.discount }));
    });
  });
}
