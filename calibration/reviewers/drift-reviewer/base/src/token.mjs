const ROTATE_WINDOW_MS = 5 * 60 * 1000;

export function needsRotation(token, now = Date.now()) {
  return token.expiresAt - now < ROTATE_WINDOW_MS;
}

export async function refresh(token, store, now = Date.now()) {
  if (!needsRotation(token, now)) return token;
  try {
    const next = await store.issue(token.sessionId);
    await store.invalidate(token.id);
    return next;
  } catch (err) {
    const e = new Error(`rotation failed: ${err.message}`);
    e.status = 401;
    throw e;
  }
}
