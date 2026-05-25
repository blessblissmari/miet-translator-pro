// Minimal MiMo (Xiaomi) client with retry + rate-limit backoff.
// Uses Xiaomi's OpenAI-compatible Singapore endpoint, reachable from RU
// without a VPN.
const ENDPOINT = "https://token-plan-sgp.xiaomimimo.com/v1/chat/completions";

export async function chat({ apiKey, model, messages, maxTokens = 4096, temperature = 0.2, signal, retries = 5 }) {
  const altKey = process.env.MIMO_API_KEY_2;
  const keys = altKey && altKey !== apiKey ? [apiKey, altKey] : [apiKey];
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const body = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      };
      const r = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keys[attempt % keys.length]}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!r.ok) {
        const body = await r.text();
        const e = new Error(`HTTP ${r.status}: ${body.slice(0, 300)}`);
        e.status = r.status;
        if (r.status === 429 || r.status >= 500) {
          // retryable
          const wait = 1500 * (attempt + 1) + Math.random() * 1000;
          await new Promise((res) => setTimeout(res, wait));
          lastErr = e;
          continue;
        }
        throw e;
      }
      const j = await r.json();
      const c = j.choices?.[0]?.message?.content;
      if (!c) {
        const refusal = j.choices?.[0]?.message?.refusal;
        throw new Error(`empty response: ${refusal || JSON.stringify(j).slice(0, 200)}`);
      }
      return c;
    } catch (e) {
      lastErr = e;
      if (e.name === "AbortError") throw e;
      if (e.status && e.status < 500 && e.status !== 429) throw e;
      if (attempt < retries - 1) {
        await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

export function stripCodeFences(s) {
  const t = s.trim();
  const m = t.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : t;
}

export function parseJsonLoose(text) {
  const cleaned = stripCodeFences(text);
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf("{");
  if (start < 0) throw new Error("no JSON found: " + cleaned.slice(0, 120));
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(cleaned.slice(start, i + 1)); } catch {}
      }
    }
  }
  throw new Error("could not parse JSON: " + cleaned.slice(0, 120));
}

// Bounded parallelism for an array of items.
export async function mapWithConcurrency(arr, limit, fn) {
  const out = new Array(arr.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= arr.length) return;
      out[i] = await fn(arr[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, arr.length) }, worker);
  await Promise.all(workers);
  return out;
}
