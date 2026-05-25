import type { MimoModel } from "./types";
import { markKeyUnhealthy, pickBuiltinKey } from "./mimo-keys";

/**
 * MiMo (Xiaomi) chat client.
 *
 * Uses Xiaomi's OpenAI-compatible Singapore endpoint
 * (`https://token-plan-sgp.xiaomimimo.com/v1`). The endpoint is reachable
 * from Russia without a VPN, which is why the project switched away from
 * OpenRouter (Cloudflare blocks) and Google AI Studio (Russia geo-block).
 *
 * Built-in keys are injected at build time via Vite env vars so that
 * teachers/students don't have to sign up — they ship in the bundle.
 */

const BUILTIN_KEYS: string[] = [
  import.meta.env.VITE_MIMO_KEY_1 as string | undefined,
  import.meta.env.VITE_MIMO_KEY_2 as string | undefined,
  import.meta.env.VITE_MIMO_KEY_3 as string | undefined,
  import.meta.env.VITE_MIMO_KEY_4 as string | undefined,
  import.meta.env.VITE_MIMO_KEY_5 as string | undefined,
  import.meta.env.VITE_MIMO_KEY_6 as string | undefined,
  import.meta.env.VITE_MIMO_KEY_7 as string | undefined,
].filter((k): k is string => typeof k === "string" && k.length > 10);

export const HAS_BUILTIN_KEYS = BUILTIN_KEYS.length > 0;
export const DEFAULT_API_KEY = BUILTIN_KEYS[0] ?? "";

export const API_BASE = "https://token-plan-sgp.xiaomimimo.com/v1";
const CHAT_URL = `${API_BASE}/chat/completions`;
const MODELS_URL = `${API_BASE}/models`;

/**
 * Models exposed in the UI. Only chat-capable models are listed
 * (TTS variants are intentionally excluded).
 *
 * Source: Xiaomi MiMo token plan. 200M credits per account.
 */
export const FREE_MODELS: MimoModel[] = [
  {
    id: "mimo-v2.5-pro",
    label: "MiMo V2.5 Pro · флагман, мультимодал",
    vision: true,
    context: 128_000,
  },
  {
    id: "mimo-v2.5",
    label: "MiMo V2.5 · быстрый мультимодал",
    vision: true,
    context: 128_000,
  },
  {
    id: "mimo-v2-omni",
    label: "MiMo V2 Omni · текст+зрение",
    vision: true,
    context: 64_000,
  },
  {
    id: "mimo-v2-pro",
    label: "MiMo V2 Pro · текст, дешевле",
    vision: false,
    context: 64_000,
  },
];

export const DEFAULT_MODEL = "mimo-v2.5-pro";

/** Fallback chain used when a model fails with a transient error. */
const FALLBACK_CHAIN: Record<string, string[]> = {
  "mimo-v2.5-pro": ["mimo-v2.5", "mimo-v2-omni", "mimo-v2-pro"],
  "mimo-v2.5": ["mimo-v2.5-pro", "mimo-v2-omni", "mimo-v2-pro"],
  "mimo-v2-omni": ["mimo-v2.5", "mimo-v2.5-pro", "mimo-v2-pro"],
  "mimo-v2-pro": ["mimo-v2.5", "mimo-v2-omni", "mimo-v2.5-pro"],
};

// -- Rate-limit memory ------------------------------------------------------
// Models that hit 429 enter a short cool-down so we don't keep hammering.
const rateLimitedUntil = new Map<string, number>();

function markRateLimited(model: string, retryAfterSec?: number): void {
  const cooldownMs = (retryAfterSec ?? 30) * 1000;
  rateLimitedUntil.set(model, Date.now() + cooldownMs);
}

function isRateLimited(model: string): boolean {
  const until = rateLimitedUntil.get(model);
  if (!until) return false;
  if (Date.now() >= until) {
    rateLimitedUntil.delete(model);
    return false;
  }
  return true;
}

// -- Types ------------------------------------------------------------------

export type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "user";
      content: Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
    };

export interface ChatOptions {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  /** Max tokens to generate. Default 4096. */
  maxTokens?: number;
  temperature?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Retries on transient errors (default 3). */
  retries?: number;
  /** If true, request strict JSON output via OpenAI-style response_format. */
  responseJson?: boolean;
}

export class MimoError extends Error {
  status: number;
  fatal: boolean;
  constructor(message: string, status: number, fatal: boolean) {
    super(message);
    this.name = "MimoError";
    this.status = status;
    this.fatal = fatal;
  }
}

/** @deprecated use MimoError */
export const OpenRouterError = MimoError;

// -- Core request -----------------------------------------------------------

async function chatOnce(opts: ChatOptions): Promise<string> {
  const {
    apiKey,
    model,
    messages,
    maxTokens = 4096,
    temperature = 0.2,
    signal,
    responseJson,
  } = opts;
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: false,
  };
  if (responseJson) {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  const text = await res.text();
  if (!res.ok) {
    // Fatal client errors stop the fallback chain.
    const fatal =
      res.status === 400 ||
      res.status === 401 ||
      res.status === 403 ||
      res.status === 404;
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after")) || undefined;
      markRateLimited(model, retryAfter);
    }
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      markKeyUnhealthy(apiKey, 5 * 60_000);
    }
    throw new MimoError(
      `MiMo HTTP ${res.status}: ${text.slice(0, 200)}`,
      res.status,
      fatal,
    );
  }

  let data: { choices?: Array<{ message?: { content?: string } }> };
  try {
    data = JSON.parse(text);
  } catch {
    throw new MimoError(
      `MiMo: non-JSON response: ${text.slice(0, 120)}`,
      res.status,
      false,
    );
  }
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new MimoError("MiMo: empty completion", res.status, false);
  }
  return content;
}

/**
 * High-level chat call with automatic key rotation and model fallback.
 * Returns the assistant's text content.
 */
export async function chat(opts: ChatOptions): Promise<string> {
  const chain = [opts.model, ...(FALLBACK_CHAIN[opts.model] ?? [])];
  let lastErr: unknown;
  for (let mi = 0; mi < chain.length; mi++) {
    const model = chain[mi];
    if (isRateLimited(model)) continue;
    const retries = opts.retries ?? 3;
    for (let attempt = 0; attempt < retries; attempt++) {
      const apiKey = pickKey(opts.apiKey);
      if (!apiKey) {
        throw new MimoError("MiMo: API key is empty", 401, true);
      }
      try {
        return await chatOnce({ ...opts, model, apiKey });
      } catch (e) {
        lastErr = e;
        if (e instanceof MimoError && e.fatal) {
          // Fatal client error: stop the whole chain.
          throw e;
        }
        const name = (e as { name?: string })?.name;
        if (name === "AbortError") throw e;
        // Otherwise retry / next key / next model.
        if (attempt < retries - 1) {
          await sleep(400 * (attempt + 1));
        }
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new MimoError("MiMo: all attempts failed", 0, false);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Pick a usable key. If user passed a long override, use that; else rotate built-ins. */
export function pickKey(userKey?: string | null): string {
  return pickBuiltinKey(BUILTIN_KEYS, userKey);
}

// -- JSON parsing helper (used by planners) ---------------------------------

/**
 * Robust JSON parser: tolerates markdown fences, surrounding prose,
 * and trailing commas. Throws if no JSON object/array can be recovered.
 */
export function parseJsonLoose<T = unknown>(raw: string): T {
  let s = raw.trim();
  // Strip markdown fences ```json ... ```
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  }
  // Direct parse fast path.
  try {
    return JSON.parse(s) as T;
  } catch {
    /* fall through */
  }
  // Find first {...} or [...] block.
  const startObj = s.indexOf("{");
  const startArr = s.indexOf("[");
  const starts = [startObj, startArr].filter((i) => i >= 0);
  if (starts.length === 0) {
    throw new Error("no JSON found in response");
  }
  const start = Math.min(...starts);
  const opener = s[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error("unterminated JSON block in response");
  const chunk = s.slice(start, end + 1);
  return JSON.parse(chunk) as T;
}

// -- Key validation --------------------------------------------------------

/** Check whether a MiMo key is usable. Tries a tiny chat call. */
export async function validateApiKey(
  key: string,
  signal?: AbortSignal,
): Promise<{ ok: true; label?: string } | { ok: false; error: string }> {
  if (!key || key.trim().length < 10) {
    return { ok: false, error: "ключ слишком короткий" };
  }
  try {
    // Try /models first (cheap), fall back to a 1-token chat ping.
    const res = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${key.trim()}` },
      signal,
    });
    const text = await res.text();
    if (res.status === 401) return { ok: false, error: "неверный ключ (401)" };
    if (res.status === 403) return { ok: false, error: "ключ заблокирован (403)" };
    if (res.ok) {
      return { ok: true, label: "ключ принят · MiMo" };
    }
    // Some endpoints don't expose /models — try a minimal completion.
    if (res.status === 404 || res.status === 405) {
      const probe = await fetch(CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key.trim()}`,
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
        signal,
      });
      if (probe.ok) return { ok: true, label: "ключ принят · MiMo" };
      if (probe.status === 401) return { ok: false, error: "неверный ключ (401)" };
      const t = await probe.text();
      return { ok: false, error: `HTTP ${probe.status}: ${t.slice(0, 120)}` };
    }
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 120)}` };
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError")
      return { ok: false, error: "отменено" };
    return { ok: false, error: (e as Error).message || "сеть недоступна" };
  }
}
