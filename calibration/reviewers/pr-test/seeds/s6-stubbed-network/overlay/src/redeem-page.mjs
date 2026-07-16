export function redeemPageHtml() {
  return `<!doctype html>
<main>
  <form id="redeem">
    <input id="code" name="code" aria-label="Promo code" />
    <button type="submit">Apply</button>
  </form>
  <p id="result" role="status"></p>
  <script>
    document.getElementById('redeem').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = document.getElementById('code').value;
      const res = await fetch('/api/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      document.getElementById('result').textContent =
        data.ok ? data.discount + '% off applied' : data.error;
    });
  </script>
</main>`;
}
