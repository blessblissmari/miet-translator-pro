import { useState } from "react";
import {
  FREE_MODELS,
  validateApiKey,
  HAS_BUILTIN_KEYS,
} from "../lib/openrouter";
import { HAS_BUILTIN_MINERU } from "../lib/mineru";

interface SettingsPanelProps {
  apiKey: string;
  overrideKey: string;
  hasKey: boolean;
  model: string;
  onKeyChange: (key: string) => void;
  onModelChange: (model: string) => void;
  // MinerU integration
  mineruEnabled: boolean;
  mineruMode: "cloud" | "local";
  mineruToken: string;
  mineruModelVersion: "pipeline" | "vlm" | "auto";
  mineruLocalEndpoint: string;
  mineruLocalBackend: "pipeline" | "vlm-transformers";
  onMineruEnabledChange: (v: boolean) => void;
  onMineruModeChange: (v: "cloud" | "local") => void;
  onMineruTokenChange: (v: string) => void;
  onMineruModelVersionChange: (v: "pipeline" | "vlm" | "auto") => void;
  onMineruLocalEndpointChange: (v: string) => void;
  onMineruLocalBackendChange: (v: "pipeline" | "vlm-transformers") => void;
}

export function SettingsPanel({
  apiKey,
  overrideKey,
  hasKey,
  model,
  onKeyChange,
  onModelChange,
  mineruEnabled,
  mineruMode,
  mineruToken,
  mineruModelVersion,
  mineruLocalEndpoint,
  mineruLocalBackend,
  onMineruEnabledChange,
  onMineruModeChange,
  onMineruTokenChange,
  onMineruModelVersionChange,
  onMineruLocalEndpointChange,
  onMineruLocalBackendChange,
}: SettingsPanelProps) {
  const [localHealth, setLocalHealth] = useState<
    null | { ok: true; version?: string; backend?: string } | { ok: false; error: string }
  >(null);
  const [checking, setChecking] = useState(false);

  async function checkLocal() {
    setChecking(true);
    setLocalHealth(null);
    try {
      const { checkLocalBridge } = await import("../lib/mineru");
      const r = await checkLocalBridge(mineruLocalEndpoint);
      if (r && r.ok) {
        setLocalHealth({ ok: true, version: r.mineru_version, backend: r.backend });
      } else {
        setLocalHealth({ ok: false, error: "Сервер не отвечает или CORS блокирует запрос" });
      }
    } catch (e) {
      setLocalHealth({ ok: false, error: (e as Error).message });
    } finally {
      setChecking(false);
    }
  }
  const [keyCheck, setKeyCheck] = useState<{
    status: "idle" | "checking" | "ok" | "fail";
    msg?: string;
  }>({ status: "idle" });

  async function handleCheckKey() {
    if (!apiKey) {
      setKeyCheck({ status: "fail", msg: "пустой ключ" });
      return;
    }
    setKeyCheck({ status: "checking" });
    const r = await validateApiKey(apiKey);
    setKeyCheck(
      r.ok ? { status: "ok", msg: r.label } : { status: "fail", msg: r.error },
    );
  }

  return (
    <section className="settings">
      <div className={`key-row ${hasKey ? "key-ok" : "key-missing"}`}>
        <label>
          <strong>OpenRouter API key</strong>
          <input
            type="password"
            value={overrideKey}
            onChange={(e) => onKeyChange(e.target.value)}
            placeholder="sk-or-v1-…"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <p className="muted small">
          {overrideKey ? (
            "Ключ сохранён в браузере (localStorage). Ни на GitHub, ни куда-то ещё он не уходит — только прямо в openrouter.ai."
          ) : HAS_BUILTIN_KEYS ? (
            <>
              ✓ Встроенные ключи OpenRouter доступны (с автоматической ротацией). Поле выше —
              необязательное переопределение своим. Бесплатный ключ можно получить на{" "}
              <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
                openrouter.ai/keys
              </a>
              .
            </>
          ) : (
            <>
              Без ключа перевод работать не будет. Бесплатный ключ можно получить на{" "}
              <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
                openrouter.ai/keys
              </a>
              . Он хранится только в этом браузере.
            </>
          )}
        </p>
        <div className="key-check-row">
          <button
            className="ghost"
            onClick={handleCheckKey}
            disabled={!hasKey || keyCheck.status === "checking"}
          >
            {keyCheck.status === "checking" ? "Проверка…" : "Проверить ключ"}
          </button>
          {keyCheck.status === "ok" && (
            <span className="key-check-ok">✓ {keyCheck.msg}</span>
          )}
          {keyCheck.status === "fail" && (
            <span className="key-check-fail">✗ {keyCheck.msg}</span>
          )}
        </div>
      </div>
      <label>
        Модель{" "}
        <select value={model} onChange={(e) => onModelChange(e.target.value)}>
          {FREE_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      {/* ── MinerU (optional alternative PDF parser) ── */}
      <div className="mineru-row" style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border, #2a2a2a)" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={mineruEnabled}
            onChange={(e) => onMineruEnabledChange(e.target.checked)}
          />
          <strong>Использовать MinerU как парсер</strong>
        </label>
        <p className="muted small">
          MinerU — облачный парсер от OpenDataLab. Лучше встроенного pdf.js на
          сканированных PDF, формулах и многоколоночной вёрстке. Получи токен на{" "}
          <a href="https://mineru.net" target="_blank" rel="noreferrer">
            mineru.net
          </a>
          .
        </p>
        {mineruEnabled && (
          <>
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
              <span>Режим:</span>
              <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                <input
                  type="radio"
                  name="mineru-mode"
                  value="local"
                  checked={mineruMode === "local"}
                  onChange={() => onMineruModeChange("local")}
                />
                Локальный
              </label>
              <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                <input
                  type="radio"
                  name="mineru-mode"
                  value="cloud"
                  checked={mineruMode === "cloud"}
                  onChange={() => onMineruModeChange("cloud")}
                />
                Облачный
              </label>
            </div>

            {mineruMode === "local" ? (
              <>
                <p className="muted small" style={{ marginTop: 8 }}>
                  Запусти бэкенд у себя:{" "}
                  <code>pip install -r server/requirements.txt &amp;&amp; python server/main.py</code>
                  . Файлы не покидают твою машину.
                </p>
                <label>
                  <span>Endpoint</span>
                  <input
                    type="url"
                    value={mineruLocalEndpoint}
                    onChange={(e) => onMineruLocalEndpointChange(e.target.value)}
                    placeholder="http://localhost:8765"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <label>
                  Backend{" "}
                  <select
                    value={mineruLocalBackend}
                    onChange={(e) =>
                      onMineruLocalBackendChange(e.target.value as "pipeline" | "vlm-transformers")
                    }
                  >
                    <option value="pipeline">pipeline (CPU)</option>
                    <option value="vlm-transformers">vlm-transformers (GPU, лучше)</option>
                  </select>
                </label>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                  <button type="button" className="ghost" onClick={checkLocal} disabled={checking}>
                    {checking ? "Проверяю…" : "Проверить соединение"}
                  </button>
                  {localHealth?.ok === true && (
                    <span style={{ color: "var(--ok, #2ecc71)" }}>
                      ✓ {localHealth.version || "ok"}
                      {localHealth.backend ? ` · ${localHealth.backend}` : ""}
                    </span>
                  )}
                  {localHealth?.ok === false && (
                    <span style={{ color: "var(--err, #e74c3c)" }}>✗ {localHealth.error}</span>
                  )}
                </div>
              </>
            ) : (
              <>
                <label>
                  <span>MinerU API token</span>
                  <input
                    type="password"
                    value={mineruToken}
                    onChange={(e) => onMineruTokenChange(e.target.value)}
                    placeholder="eyJ…"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                {HAS_BUILTIN_MINERU && !mineruToken && (
                  <p className="muted small">
                    ✓ Встроенный токен доступен. Поле выше — переопределить своим (необязательно).
                  </p>
                )}
                <label>
                  Модель MinerU{" "}
                  <select
                    value={mineruModelVersion}
                    onChange={(e) =>
                      onMineruModelVersionChange(e.target.value as "pipeline" | "vlm" | "auto")
                    }
                  >
                    <option value="vlm">vlm (лучшее качество, медленнее)</option>
                    <option value="pipeline">pipeline (быстро)</option>
                    <option value="auto">auto</option>
                  </select>
                </label>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
