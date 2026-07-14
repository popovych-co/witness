const ROTATE_WINDOW_MS = 5 * 60 * 1000;

export function needsRotation(token, now = Date.now()) {
  return token.expiresAt - now < ROTATE_WINDOW_MS;
}

export async function refresh(token, store, now = Date.now()) {
  return token;
}
