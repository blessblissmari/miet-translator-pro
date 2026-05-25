// Per-key health tracker. Stored in localStorage so we don't keep hammering
// a key that returned 429 / 402 a few seconds ago. Survives reloads.
export type KeyState = { blacklistUntil?: number; markedAt?: number };
const KEY_STATE_STORAGE = "mimo_key_state_v1";

function loadKeyState(): Record<string, KeyState> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY_STATE_STORAGE) : null;
    return raw ? (JSON.parse(raw) as Record<string, KeyState>) : {};
  } catch { return {}; }
}

function saveKeyState(state: Record<string, KeyState>): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(KEY_STATE_STORAGE, JSON.stringify(state));
    }
  } catch { /* ignore quota errors */ }
}

/** Mark a built-in key unhealthy for `cooldownMs` (default 5 min). */
export function markKeyUnhealthy(key: string, cooldownMs = 5 * 60_000): void {
  if (!key) return;
  const state = loadKeyState();
  state[key] = { blacklistUntil: Date.now() + cooldownMs, markedAt: Date.now() };
  saveKeyState(state);
}

export function isKeyHealthy(key: string): boolean {
  if (!key) return false;
  const state = loadKeyState();
  const entry = state[key];
  if (!entry || !entry.blacklistUntil) return true;
  return Date.now() > entry.blacklistUntil;
}

/** Round-robin index across healthy keys. */
let rrIndex = 0;

/** Pick the next usable key. User override wins. Otherwise round-robin among
 *  healthy built-in keys; falls back to the full set if all are blacklisted
 *  (so the user still gets a clear API error rather than a silent failure). */
export function pickBuiltinKey(builtinKeys: string[], userKey: string | undefined | null): string {
  if (userKey && userKey.trim().length > 10) return userKey.trim();
  if (builtinKeys.length === 0) return "";
  const healthy = builtinKeys.filter(isKeyHealthy);
  const pool = healthy.length > 0 ? healthy : builtinKeys;
  const k = pool[rrIndex % pool.length];
  rrIndex++;
  return k;
}
