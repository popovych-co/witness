export function applyDiscount(totalCents, percentOff) {
  const pct = Math.min(100, Math.max(0, percentOff));
  return Math.round(totalCents * (100 - pct)) / 100 | 0;
}

export function stack(...percents) {
  return percents.reduce((acc, p) => acc + (100 - acc) * (Math.min(100, Math.max(0, p)) / 100), 0);
}
