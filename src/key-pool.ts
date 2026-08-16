/**
 * Key pool management for Tavily API keys stored in Cloudflare KV.
 *
 * KV schema: key = Tavily API key (e.g. "tvly-xxx"),
 * value = JSON string of KeyState (see below).
 *
 * Design follows tavily-hikari:
 * - The request hot path does NOT estimate/deduct credits. Key health comes
 *   from real upstream signals: HTTP 432 = quota exhausted (skip until next
 *   UTC month), HTTP 429 = transient cooldown (Retry-After), 401/403 = invalid.
 * - Keys are selected by least-recently-used (LRU) among healthy keys.
 * - Tavily /usage is only synced in the background for display purposes.
 */

export type KeyStatus = "active" | "exhausted";

export interface KeyState {
  status: KeyStatus;
  /** Unix seconds of the last time this key was picked. LRU ordering key. */
  lastUsedAt: number;
  /** Unix seconds when status changed to exhausted. Basis for monthly reset. */
  statusChangedAt: number;
  /** Unix seconds until which the key is cooled down (429 Retry-After). */
  cooldownUntil: number;
  /** Unix seconds when the key was added to the pool. */
  addedAt: number;
  /** Short management note set when the key was added. */
  note: string;
  /** Display-only credit limit, synced in the background. */
  creditLimit: number;
  /** Display-only remaining credit, synced in the background. */
  creditRemaining: number;
  /** Unix seconds of the last successful /usage sync. */
  creditSyncedAt: number;
}

export interface KeyInfo extends KeyState {
  apiKey: string;
  /** Masked display form, e.g. "tvly-1234...abcd". */
  mask: string;
}

const USAGE_BASE = "https://api.tavily.com/usage";

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function monthStartUtcSecs(now: number): number {
  const d = new Date(now * 1000);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export function defaultState(): KeyState {
  return {
    status: "active",
    lastUsedAt: 0,
    statusChangedAt: 0,
    cooldownUntil: 0,
    addedAt: 0,
    note: "",
    creditLimit: 0,
    creditRemaining: 0,
    creditSyncedAt: 0,
  };
}

export function maskKey(apiKey: string): string {
  if (apiKey.length <= 12) return `${apiKey.slice(0, 4)}...`;
  return `${apiKey.slice(0, 7)}...${apiKey.slice(-4)}`;
}

function parseState(value: string | null): KeyState {
  if (!value) return defaultState();
  try {
    const raw = JSON.parse(value) as Partial<KeyState>;
    const base = defaultState();
    return {
      ...base,
      ...raw,
      status: raw.status === "exhausted" ? "exhausted" : "active",
    };
  } catch {
    // Legacy values were plain numbers (remaining credit). Treat as active.
    const legacy = Number(value);
    return { ...defaultState(), creditRemaining: Number.isFinite(legacy) ? Math.max(0, legacy) : 0 };
  }
}

function serializeState(state: KeyState): string {
  return JSON.stringify(state);
}

/**
 * Query the Tavily /usage endpoint to get remaining credits for a key.
 * Returns { limit, remaining }; remaining is capped at >= 0.
 */
export async function queryUsage(
  apiKey: string
): Promise<{ limit: number; remaining: number }> {
  const res = await fetch(USAGE_BASE, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tavily API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    key: { usage: number; limit: number | null };
    account: { plan_limit: number; plan_usage: number };
  };

  const limit = data.key.limit ?? data.account.plan_limit ?? 0;
  const usage = data.key.usage;
  return { limit, remaining: Math.max(0, limit - usage) };
}

/**
 * Lazy monthly reset (tavily-hikari reset_monthly): any key marked exhausted
 * in a previous UTC month is restored to active.
 */
export async function resetMonthly(kv: KVNamespace): Promise<void> {
  const now = nowSecs();
  const monthStart = monthStartUtcSecs(now);

  const list = await kv.list();
  for (const item of list.keys) {
    const state = parseState(await kv.get(item.name));
    if (state.status === "exhausted" && state.statusChangedAt > 0 && state.statusChangedAt < monthStart) {
      state.status = "active";
      state.statusChangedAt = now;
      await kv.put(item.name, serializeState(state));
    }
  }
}

/**
 * Pick the least-recently-used healthy key. Returns null if none available.
 * Resets monthly-exhausted keys lazily before selecting.
 */
export async function pickBestKey(kv: KVNamespace): Promise<string | null> {
  await resetMonthly(kv);

  const now = nowSecs();
  let best: { name: string; state: KeyState } | null = null;

  const list = await kv.list();
  for (const item of list.keys) {
    const state = parseState(await kv.get(item.name));
    if (state.status !== "active") continue;
    if (state.cooldownUntil > now) continue;
    if (best === null || state.lastUsedAt < best.state.lastUsedAt) {
      best = { name: item.name, state };
    }
  }

  if (!best) return null;

  best.state.lastUsedAt = now;
  await kv.put(best.name, serializeState(best.state));
  return best.name;
}

/**
 * Mark a key exhausted (HTTP 432 / 401 / 403). It is skipped for the rest of
 * the current UTC month and auto-recovers on the next monthly reset.
 */
export async function markExhausted(kv: KVNamespace, apiKey: string): Promise<void> {
  const state = parseState(await kv.get(apiKey));
  state.status = "exhausted";
  state.statusChangedAt = nowSecs();
  await kv.put(apiKey, serializeState(state));
}

/**
 * Set a transient cooldown (HTTP 429) until the given Unix seconds.
 */
export async function setCooldown(kv: KVNamespace, apiKey: string, cooldownUntil: number): Promise<void> {
  const state = parseState(await kv.get(apiKey));
  state.cooldownUntil = Math.max(state.cooldownUntil, cooldownUntil);
  await kv.put(apiKey, serializeState(state));
}

/**
 * Add or restore a key in KV. Queries Tavily for current remaining credit.
 * The optional `note` is a short management comment shown in the admin panel.
 */
export async function addKey(kv: KVNamespace, apiKey: string, note = ""): Promise<KeyInfo> {
  const { limit, remaining } = await queryUsage(apiKey);
  const now = nowSecs();
  const state: KeyState = {
    status: "active",
    lastUsedAt: now,
    statusChangedAt: now,
    cooldownUntil: 0,
    addedAt: now,
    note: note.trim().slice(0, 200),
    creditLimit: limit,
    creditRemaining: remaining,
    creditSyncedAt: now,
  };
  await kv.put(apiKey, serializeState(state));
  return { apiKey, mask: maskKey(apiKey), ...state };
}

/**
 * Delete a key from KV.
 */
export async function deleteKey(kv: KVNamespace, apiKey: string): Promise<void> {
  await kv.delete(apiKey);
}

/**
 * List all keys from KV with their cached state (no Tavily API call).
 */
export async function listKeys(kv: KVNamespace): Promise<KeyInfo[]> {
  const keys: KeyInfo[] = [];
  let cursor: string | undefined;

  do {
    const result = await kv.list({ cursor });
    for (const item of result.keys) {
      const state = parseState(await kv.get(item.name));
      keys.push({ apiKey: item.name, mask: maskKey(item.name), ...state });
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  return keys;
}

/**
 * Sync a single key's usage/credit from Tavily (display fields only).
 * On HTTP 432 the key is also marked exhausted.
 * Errors are swallowed so one bad key cannot break the whole sync run.
 */
export async function syncKeyUsage(kv: KVNamespace, apiKey: string): Promise<void> {
  const state = parseState(await kv.get(apiKey));
  try {
    const { limit, remaining } = await queryUsage(apiKey);
    state.creditLimit = limit;
    state.creditRemaining = remaining;
    state.creditSyncedAt = nowSecs();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Tavily API error 432/.test(message)) {
      state.status = "exhausted";
      state.statusChangedAt = nowSecs();
    }
    // Other failures (429/5xx/network) leave cached values untouched.
  }
  await kv.put(apiKey, serializeState(state));
}

/**
 * Sync usage for all keys. Returns how many keys were updated.
 * Used by the background scheduled handler and the admin "sync now" action.
 */
export async function syncAllUsage(kv: KVNamespace): Promise<number> {
  const keys = await listKeys(kv);
  for (const key of keys) {
    await syncKeyUsage(kv, key.apiKey);
  }
  return keys.length;
}
