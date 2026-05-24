import type { OpenRouterModel } from "./types";

/** No API key is embedded. Users must provide their own OpenRouter key in the
 *  UI. The key is stored in localStorage of the user's browser only — never
 *  sent to the repo or to any server other than openrouter.ai. */
export const DEFAULT_API_KEY = "";

export const FREE_MODELS: OpenRouterModel[] = [
  // Vision-capable: handles printed text, scans, and handwriting.
  { id: "google/gemma-4-26b-a4b-it:free",        label: "Gemma 4 26B — vision (рекомендуется, академический русский)", vision: true,  context: 262144 },
  { id: "nvidia/nemotron-nano-12b-v2-vl:free",   label: "Nemotron Nano 12B VL — vision (Nvidia, без рейт-лимитов Google)", vision: true, context: 128000 },
  { id: "google/gemma-3-27b-it:free",            label: "Gemma 3 27B — vision (часто rate-limited)",                  vision: true,  context: 131072 },
  { id: "google/gemma-3-12b-it:free",            label: "Gemma 3 12B — vision (быстрее, тот же лимит)",                vision: true,  context: 32768  },
  // Text-only: faster + reliable for printed PDFs without need for image OCR.
  { id: "openai/gpt-oss-120b:free",              label: "GPT-OSS 120B — только текст, очень стабильна",                vision: false, context: 131072 },
  { id: "z-ai/glm-4.5-air:free",                 label: "GLM 4.5 Air — только текст, стабильна",                       vision: false, context: 131072 },
];

export const DEFAULT_MODEL = FREE_MODELS[0].id;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
}

export interface ChatOptions {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  responseJson?: boolean;
  signal?: AbortSignal;
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Error class so we can surface fatal HTTP statuses (no point retrying 401/403/400). */
export class OpenRouterError extends Error {
  status: number;
  fatal: boolean;
  bodyExcerpt: string;
  constructor(status: number, bodyExcerpt: string, fatal: boolean) {
    const friendly =
      status === 401 ? "ключ OpenRouter недействителен (401). Проверь его на https://openrouter.ai/keys" :
      status === 402 ? "у ключа OpenRouter нет квоты/баланса (402). Создай новый бесплатный ключ или пополни." :
      status === 403 ? "доступ запрещён (403). Возможно модель недоступна для этого ключа." :
      status === 404 ? "модель не найдена (404). Выбери другую в Настройках." :
      status === 400 ? `неверный запрос (400): ${bodyExcerpt}` :
      status === 429 ? `слишком много запросов (429): ${bodyExcerpt}` :
      status >= 500 ? `сервер OpenRouter (${status}): ${bodyExcerpt}` :
      `HTTP ${status}: ${bodyExcerpt}`;
    super(friendly);
    this.name = "OpenRouterError";
    this.status = status;
    this.fatal = fatal;
    this.bodyExcerpt = bodyExcerpt;
  }
}

function describeError(e: unknown): string {
  if (!e) return "неизвестная ошибка (no error object)";
  if (e instanceof Error) return e.message || e.name || String(e);
  if (typeof e === "string") return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

/** Models to try after the primary one if it's persistently rate-limited.
 *  Pick fallbacks of the matching capability tier. */
function fallbackChain(primary: string, hasImage: boolean): string[] {
  const chain: string[] = [primary];
  if (hasImage) {
    // Need vision-capable models
    if (!chain.includes("google/gemma-4-26b-a4b-it:free")) chain.push("google/gemma-4-26b-a4b-it:free");
    if (!chain.includes("nvidia/nemotron-nano-12b-v2-vl:free")) chain.push("nvidia/nemotron-nano-12b-v2-vl:free");
    if (!chain.includes("google/gemma-3-27b-it:free")) chain.push("google/gemma-3-27b-it:free");
  } else {
    if (!chain.includes("openai/gpt-oss-120b:free")) chain.push("openai/gpt-oss-120b:free");
    if (!chain.includes("z-ai/glm-4.5-air:free")) chain.push("z-ai/glm-4.5-air:free");
    if (!chain.includes("google/gemma-4-26b-a4b-it:free")) chain.push("google/gemma-4-26b-a4b-it:free");
  }
  return chain;
}

function messagesHaveImage(messages: ChatMessage[]): boolean {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const part of m.content) if (part.type === "image_url") return true;
    }
  }
  return false;
}

export async function chat(opts: ChatOptions): Promise<string> {
  if (!opts.apiKey) throw new Error("Нет ключа OpenRouter. Открой Настройки и вставь ключ с https://openrouter.ai/keys");

  const hasImage = messagesHaveImage(opts.messages);
  const chain = fallbackChain(opts.model, hasImage);

  let lastErr: unknown = new Error("no attempts made");
  for (let mi = 0; mi < chain.length; mi++) {
    const model = chain[mi];
    try {
      return await chatOnce({ ...opts, model });
    } catch (e) {
      lastErr = e;
      // Only fall through to next model on rate-limit / server error / no-completion.
      // Fatal client errors (400/401/402/403/404) should stop the chain.
      if (e instanceof OpenRouterError && e.fatal) throw e;
      if ((e as { name?: string })?.name === "AbortError") throw e;
      // Otherwise: try the next model in the chain
      continue;
    }
  }
  throw new Error(`OpenRouter не ответил после ретраев и фолбэков: ${describeError(lastErr)}`);
}

async function chatOnce(opts: ChatOptions): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 4096,
  };
  if (opts.responseJson) body.response_format = { type: "json_object" };

  let lastErr: unknown = new Error("no attempts made");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
          "HTTP-Referer": typeof window !== "undefined" ? window.location.origin : "",
          "X-Title": "MIET Translator",
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });

      // Read body once, regardless of status, so we always have something to surface.
      const rawText = await res.text().catch(() => "");

      if (!res.ok) {
        // Fatal statuses: don't retry, surface immediately.
        const fatal = res.status === 400 || res.status === 401 || res.status === 402 ||
                      res.status === 403 || res.status === 404;
        const err = new OpenRouterError(res.status, rawText.slice(0, 400), fatal);
        if (fatal) throw err;
        // Retryable (429 / 5xx). Honor Retry-After when present (seconds or HTTP-date).
        lastErr = err;
        const ra = parseRetryAfter(res.headers.get("retry-after"));
        const fallback = Math.min(60_000, 2000 * Math.pow(2, attempt));
        const wait = ra ?? fallback;
        await sleep(wait);
        continue;
      }

      let data: unknown;
      try { data = JSON.parse(rawText); }
      catch { throw new Error(`OpenRouter ответил не-JSON: ${rawText.slice(0, 200)}`); }

      const d = data as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
      if (d?.error?.message) throw new Error(`OpenRouter API: ${d.error.message}`);
      const content: string | undefined = d?.choices?.[0]?.message?.content;
      if (!content) throw new Error(`Пустой ответ от модели: ${rawText.slice(0, 200)}`);
      return content;
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") throw e;
      if (e instanceof OpenRouterError && e.fatal) throw e;
      lastErr = e;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`OpenRouter не ответил после ретраев: ${describeError(lastErr)}`);
}

/** Extract a JSON object from a possibly-fenced LLM response. */
export function parseJsonLoose<T>(raw: string): T {
  let s = raw.trim();
  // Strip ``` fences
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Find first { ... last }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return JSON.parse(s) as T;
}



/**
 * Parse a Retry-After header into milliseconds. Header may be:
 *   - a delay in seconds: "30"
 *   - an HTTP-date: "Wed, 21 Oct 2026 07:28:00 GMT"
 * Returns null on parse failure or unreasonable values (>5 min, treat as 5 min).
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const sec = parseInt(trimmed, 10);
    if (!Number.isFinite(sec) || sec < 0) return null;
    return Math.min(sec * 1000, 5 * 60 * 1000);
  }
  const dt = Date.parse(trimmed);
  if (!Number.isFinite(dt)) return null;
  const ms = dt - Date.now();
  if (ms <= 0) return 0;
  return Math.min(ms, 5 * 60 * 1000);
}

export interface KeyValidation {
  ok: boolean;
  /** When ok=true: short human label like "free $0.00 / unlimited" */
  label?: string;
  /** When ok=false: the message to display to the user */
  error?: string;
}

/**
 * Validate an OpenRouter key with a tiny GET to /api/v1/key.
 * Used by the Settings UI's "Проверить ключ" button so users can confirm a
 * pasted key works before kicking off a long-running translation.
 */
export async function validateApiKey(apiKey: string, signal?: AbortSignal): Promise<KeyValidation> {
  if (!apiKey || !apiKey.trim()) return { ok: false, error: "пустой ключ" };
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": typeof window !== "undefined" ? window.location.origin : "",
        "X-Title": "MIET Translator",
      },
      signal,
    });
    const text = await res.text().catch(() => "");
    if (res.status === 401) return { ok: false, error: "ключ недействителен (401). Создай новый на openrouter.ai/keys" };
    if (res.status === 403) return { ok: false, error: "ключ заблокирован (403)" };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 120)}` };
    let data: unknown;
    try { data = JSON.parse(text); } catch { return { ok: true, label: "ключ принят" }; }
    const d = data as { data?: { label?: string; usage?: number; limit?: number | null; is_free_tier?: boolean } };
    const info = d?.data ?? {};
    const tier = info.is_free_tier ? "free" : "paid";
    const used = typeof info.usage === "number" ? `$${info.usage.toFixed(2)}` : "?";
    const limit = info.limit == null ? "∞" : `$${Number(info.limit).toFixed(2)}`;
    return { ok: true, label: `${tier} · потрачено ${used} / лимит ${limit}` };
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") return { ok: false, error: "отменено" };
    return { ok: false, error: (e as Error).message || "сеть недоступна" };
  }
}
