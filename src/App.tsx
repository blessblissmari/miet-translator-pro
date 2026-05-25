import { useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import { saveAs } from "file-saver";
import { planSlides, planDoc } from "./lib/planner";
import { buildPptx } from "./lib/pptxBuild";
import { buildDocx } from "./lib/docxBuild";
import { FREE_MODELS, DEFAULT_MODEL, DEFAULT_API_KEY } from "./lib/mimo";
import { DEFAULT_MINERU_TOKEN } from "./lib/mineru";
import { expandInputs, type IntakeFile } from "./lib/intake";
import { extractAny, suggestKind } from "./lib/extractAny";
import { SlidesPreview, DocPreview } from "./components/Preview";
import { SwipeDeck } from "./components/SwipeDeck";
import { SettingsPanel } from "./components/SettingsPanel";
import { QueueSidebar } from "./components/QueueSidebar";
import { OriginalPreview } from "./components/OriginalPreview";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useLocalStorage } from "./hooks/useLocalStorage";
import type { QueueItem, Kind } from "./types/queue";
import "./App.css";

interface UnsortedItem extends IntakeFile {
  id: string;
}

export default function App() {
  /* ─── Settings ─────────────────────────── */
  const [overrideKey, setOverrideKey] = useLocalStorage<string>("mimo_key", "");
  const apiKey = overrideKey.trim() || DEFAULT_API_KEY;
  const hasKey = !!apiKey;
  const [model, setModel] = useLocalStorage<string>("mimo_model", DEFAULT_MODEL);

  // One-time migration from the legacy OpenRouter storage keys.
  // We used to store the API key under "openrouter_key" and the selected
  // model under "openrouter_model"; the project has since moved to MiMo.
  useEffect(() => {
    try {
      const legacyKey = localStorage.getItem("openrouter_key");
      if (legacyKey && !overrideKey) {
        // Don't copy old OpenRouter sk-or-… keys — they won't validate
        // against MiMo. Just drop them so the user pastes a fresh one.
        localStorage.removeItem("openrouter_key");
      }
      const legacyModel = localStorage.getItem("openrouter_model");
      if (legacyModel) {
        localStorage.removeItem("openrouter_model");
      }
    } catch {
      /* ignore */
    }
    // If current model id doesn't look like a MiMo model, reset it.
    const looksLikeMimo = model?.startsWith("mimo-");
    if (!looksLikeMimo) {
      setModel(DEFAULT_MODEL);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [showSettings, setShowSettings] = useState(!apiKey);

  // MinerU (alternative PDF parser) — opt-in. Two modes:
  //   - "local": talks to the FastAPI bridge in server/main.py (recommended)
  //   - "cloud": uses mineru.net's API, requires a token
  const [mineruEnabled, setMineruEnabled] = useLocalStorage<boolean>("mineru_enabled", false);
  const [mineruMode, setMineruMode] = useLocalStorage<"cloud" | "local">("mineru_mode", "local");
  const [mineruTokenOverride, setMineruToken] = useLocalStorage<string>("mineru_token", "");
  const mineruToken = mineruTokenOverride.trim() || DEFAULT_MINERU_TOKEN;
  const [mineruModelVersion, setMineruModelVersion] = useLocalStorage<
    "pipeline" | "vlm" | "auto"
  >("mineru_model_version", "vlm");
  const [mineruLocalEndpoint, setMineruLocalEndpoint] = useLocalStorage<string>(
    "mineru_local_endpoint",
    "http://localhost:8765",
  );
  const [mineruLocalBackend, setMineruLocalBackend] = useLocalStorage<
    "pipeline" | "vlm-transformers"
  >("mineru_local_backend", "pipeline");

  /* ─── Queue state ──────────────────────── */
  const [unsorted, setUnsorted] = useState<UnsortedItem[]>([]);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const visionCapable = FREE_MODELS.find((m) => m.id === model)?.vision ?? false;

  const updateItem = (id: string, patch: Partial<QueueItem>) =>
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));

  /* ─── File handling ────────────────────── */
  async function handleFiles(files: FileList | File[]) {
    const arr = Array.from(files);
    const inputs = await expandInputs(arr);
    if (inputs.length === 0) {
      alert("В выбранных файлах не нашлось поддерживаемых документов.");
      return;
    }
    const newItems: UnsortedItem[] = inputs.map((p) => ({
      ...p,
      id: `${p.path}_${Math.random().toString(36).slice(2, 7)}`,
    }));
    setUnsorted((prev) => [...prev, ...newItems]);
  }

  function commitToQueue(unsortedItem: UnsortedItem, kind: Kind) {
    setUnsorted((prev) => prev.filter((u) => u.id !== unsortedItem.id));
    const queueItem: QueueItem = {
      id: unsortedItem.id,
      path: unsortedItem.path,
      blob: unsortedItem.blob,
      kind,
      status: "queued",
      progress: null,
    };
    setItems((prev) => [...prev, queueItem]);
    if (!selectedId) setSelectedId(queueItem.id);
  }

  function undoFromQueue(id: string) {
    const it = items.find((x) => x.id === id);
    if (!it) return;
    setItems((prev) => prev.filter((x) => x.id !== id));
    setUnsorted((prev) => [{ id: it.id, path: it.path, blob: it.blob }, ...prev]);
  }

  function skipUnsorted(id: string) {
    setUnsorted((prev) => prev.filter((u) => u.id !== id));
  }

  async function autoSortAll() {
    const todo = [...unsorted];
    for (const u of todo) {
      const k = await suggestKind(u.path, u.blob);
      commitToQueue(u, k);
    }
  }

  /* ─── Processing ───────────────────────── */
  async function processItem(it: QueueItem) {
    const signal = abortRef.current?.signal;
    const startedAt = Date.now();
    try {
      updateItem(it.id, {
        status: "extracting",
        message: "Извлечение содержимого…",
        progress: null,
        startedAt,
        elapsedMs: undefined,
        error: undefined,
      });
      // Build MinerU options based on selected mode
      let mineruExtractOpts: Parameters<typeof extractAny>[3] = undefined;
      if (mineruEnabled) {
        if (mineruMode === "local" && mineruLocalEndpoint) {
          mineruExtractOpts = {
            mineruLocal: {
              endpoint: mineruLocalEndpoint,
              backend: mineruLocalBackend,
              onProgress: (msg) => updateItem(it.id, { message: msg }),
              signal,
            },
          };
        } else if (mineruMode === "cloud" && mineruToken) {
          mineruExtractOpts = {
            mineru: {
              token: mineruToken,
              modelVersion: mineruModelVersion,
              onProgress: (msg) => updateItem(it.id, { message: msg }),
              signal,
            },
          };
        }
      }
      const extracted = await extractAny(
        it.blob,
        it.path.split("/").pop() || it.path,
        (p, t) => updateItem(it.id, { progress: { done: p, total: t } }),
        mineruExtractOpts,
      );
      if (signal?.aborted) throw new Error("aborted");

      updateItem(it.id, {
        status: "translating",
        message: `Перевод (${it.kind === "presentation" ? "презентация" : "документ"})…`,
        progress: { done: 0, total: extracted.pages.length },
      });

      const opts = {
        apiKey,
        model,
        visionCapable,
        signal,
        onLog: (m: string) => updateItem(it.id, { message: m }),
        onProgress: (d: number, t: number) => updateItem(it.id, { progress: { done: d, total: t } }),
      };

      if (it.kind === "presentation") {
        const slides = await planSlides(extracted, opts);
        if (signal?.aborted) throw new Error("aborted");
        updateItem(it.id, { status: "building", message: "Сборка PPTX…", slides });
        const blob = await buildPptx(slides);
        const name = (it.path.replace(/\.[^./]+$/, "").split("/").pop() || "result") + "_MIET_ru.pptx";
        updateItem(it.id, {
          status: "done",
          message: `Готово: ${name}`,
          resultBlob: blob,
          resultName: name,
          progress: null,
          elapsedMs: Date.now() - startedAt,
        });
      } else {
        const doc = await planDoc(extracted, opts);
        if (signal?.aborted) throw new Error("aborted");
        updateItem(it.id, { status: "building", message: "Сборка DOCX…", doc });
        const blob = await buildDocx(doc);
        const name = (it.path.replace(/\.[^./]+$/, "").split("/").pop() || "result") + "_ru.docx";
        updateItem(it.id, {
          status: "done",
          message: `Готово: ${name}`,
          resultBlob: blob,
          resultName: name,
          progress: null,
          elapsedMs: Date.now() - startedAt,
        });
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "aborted") {
        updateItem(it.id, { status: "queued", message: "Отменено", progress: null, elapsedMs: undefined });
      } else {
        console.error(e);
        updateItem(it.id, {
          status: "error",
          error: msg,
          message: `Ошибка: ${msg}`,
          progress: null,
          elapsedMs: Date.now() - startedAt,
        });
      }
    }
  }

  async function runAll() {
    if (running) return;
    abortRef.current = new AbortController();
    setRunning(true);
    setPaused(false);
    try {
      const queue = items.filter((it) => it.status === "queued" || it.status === "error");
      // ТЗ §2.2: сначала DOCX (documents), потом PPTX (presentations).
      const sorted = [
        ...queue.filter((it) => it.kind === "document"),
        ...queue.filter((it) => it.kind === "presentation"),
      ];
      for (const it of sorted) {
        // honour pause without aborting the current item
        while (pausedRef.current && !abortRef.current?.signal.aborted) {
          await new Promise((r) => setTimeout(r, 200));
        }
        if (abortRef.current?.signal.aborted) break;
        await processItem(it);
      }
    } finally {
      setRunning(false);
      setPaused(false);
      abortRef.current = null;
    }
  }

  function cancelAll() {
    abortRef.current?.abort();
    setPaused(false);
  }

  function togglePause() {
    setPaused((p) => !p);
  }

  function clearAll() {
    if (running) return;
    setItems([]);
    setUnsorted([]);
    setSelectedId(null);
  }

  async function downloadAll() {
    const done = items.filter((it) => it.status === "done" && it.resultBlob && it.resultName);
    const errored = items.filter((it) => it.status === "error");
    const skipped = items.filter(
      (it) => it.status !== "done" && it.status !== "error",
    );

    // Build human-readable report + machine log
    const formatMs = (ms?: number) =>
      ms == null ? "—" : ms < 1000 ? `${ms} мс` : `${(ms / 1000).toFixed(1)} с`;

    const report: string[] = [
      "# MIET Translator — отчёт",
      "",
      `Дата: ${new Date().toISOString()}`,
      `Всего файлов: ${items.length}`,
      `Готово: ${done.length}`,
      `С ошибками: ${errored.length}`,
      `В очереди / пропущено: ${skipped.length}`,
      "",
      "## Готовые файлы",
      "",
    ];
    for (const it of done) {
      report.push(
        `- ✅ \`${it.path}\` → \`${it.resultName}\` (${it.kind === "document" ? "DOCX" : "PPTX"}, ${formatMs(it.elapsedMs)})`,
      );
    }
    if (errored.length) {
      report.push("", "## Ошибки", "");
      for (const it of errored) {
        report.push(`- ❌ \`${it.path}\` — ${it.error || "неизвестная ошибка"}`);
      }
    }
    if (skipped.length) {
      report.push("", "## Не обработано", "");
      for (const it of skipped) {
        report.push(`- ⏭ \`${it.path}\` (статус: ${it.status})`);
      }
    }

    const log: string[] = items.map(
      (it) =>
        `[${it.path}] kind=${it.kind} status=${it.status} elapsed=${formatMs(it.elapsedMs)} msg=${it.message || ""} err=${it.error || ""}`,
    );

    // If exactly one done file and no errors → save raw file (familiar UX).
    if (done.length === 1 && errored.length === 0 && skipped.length === 0) {
      saveAs(done[0].resultBlob!, done[0].resultName!);
      return;
    }
    if (done.length === 0 && errored.length === 0) return;

    const zip = new JSZip();
    for (const it of done) zip.file(it.resultName!, it.resultBlob!);
    zip.file("report.md", report.join("\n"));
    zip.file("log.txt", log.join("\n"));
    const blob = await zip.generateAsync({ type: "blob" });
    saveAs(blob, "miet-translator-results.zip");
  }

  function downloadOne(it: QueueItem) {
    if (it.resultBlob && it.resultName) saveAs(it.resultBlob, it.resultName);
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((it) => it.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  function retryItem(id: string) {
    setItems((prev) =>
      prev.map((it) =>
        it.id === id
          ? { ...it, status: "queued" as const, error: undefined, message: "В очереди (повторить)", progress: null, elapsedMs: undefined }
          : it,
      ),
    );
    if (!running) void runAll();
  }

  function changeKind(id: string, kind: Kind) {
    updateItem(id, { kind });
  }

  /* ─── Drag-drop on body ────────────────── */
  const dropRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = dropRef.current;
    if (!el) return;
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      el.classList.add("drag-over");
    };
    const onDragLeave = () => el.classList.remove("drag-over");
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      el.classList.remove("drag-over");
      const dt = e.dataTransfer;
      if (!dt) return;
      const dtItems = Array.from(dt.items || []);
      const entries = dtItems.map((it) => it.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
      if (entries.length > 0 && entries.some((en) => en.isDirectory)) {
        readEntries(entries).then((files) => handleFiles(files));
      } else {
        handleFiles(dt.files);
      }
    };
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("dragleave", onDragLeave);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("dragleave", onDragLeave);
      el.removeEventListener("drop", onDrop);
    };
  }, []);

  const selected = items.find((it) => it.id === selectedId) || null;

  return (
    <ErrorBoundary>
      <div className="app">
        <header className="topbar">
          <h1>MIET Translator</h1>
          <div className="topbar-right">
            {!hasKey && (
              <span className="key-warning" onClick={() => setShowSettings(true)}>
                ⚠ Нужен ключ MiMo
              </span>
            )}
            <button className="ghost" onClick={() => setShowSettings((s) => !s)}>
              {showSettings ? "Скрыть настройки" : "Настройки"}
            </button>
          </div>
        </header>

        {showSettings && (
          <SettingsPanel
            apiKey={apiKey}
            overrideKey={overrideKey}
            hasKey={hasKey}
            model={model}
            onKeyChange={setOverrideKey}
            onModelChange={setModel}
            mineruEnabled={mineruEnabled}
            mineruMode={mineruMode}
            mineruToken={mineruTokenOverride}
            mineruModelVersion={mineruModelVersion}
            mineruLocalEndpoint={mineruLocalEndpoint}
            mineruLocalBackend={mineruLocalBackend}
            onMineruEnabledChange={setMineruEnabled}
            onMineruModeChange={setMineruMode}
            onMineruTokenChange={setMineruToken}
            onMineruModelVersionChange={setMineruModelVersion}
            onMineruLocalEndpointChange={setMineruLocalEndpoint}
            onMineruLocalBackendChange={setMineruLocalBackend}
          />
        )}

        <div className="main">
          <QueueSidebar
            items={items}
            selectedId={selectedId}
            running={running}
            paused={paused}
            hasKey={hasKey}
            onSelect={setSelectedId}
            onRemove={removeItem}
            onRetry={retryItem}
            onChangeKind={changeKind}
            onDownloadOne={downloadOne}
            onRunAll={runAll}
            onCancelAll={cancelAll}
            onTogglePause={togglePause}
            onDownloadAll={downloadAll}
            onClearAll={clearAll}
            onFilesSelected={handleFiles}
            dropRef={dropRef}
          />

          <section className="viewer">
            {unsorted.length > 0 ? (
              <SwipeDeck
                items={unsorted}
                onDecide={(id, kind) => {
                  const u = unsorted.find((x) => x.id === id);
                  if (u) commitToQueue(u, kind);
                }}
                onUndo={(id) => undoFromQueue(id)}
                onAutoSortAll={autoSortAll}
                onSkip={skipUnsorted}
              />
            ) : !selected ? (
              <div className="empty">
                <p>Выбери файл слева, чтобы увидеть оригинал и результат рядом.</p>
              </div>
            ) : (
              <div className="side-by-side">
                <div className="pane">
                  <div className="pane-header">Оригинал · {selected.path.split("/").pop()}</div>
                  <OriginalPreview blob={selected.blob} path={selected.path} />
                </div>
                <div className="pane">
                  <div className="pane-header">
                    Результат · {selected.kind === "presentation" ? "PPTX (MIET)" : "DOCX"}
                  </div>
                  {selected.slides ? (
                    <SlidesPreview slides={selected.slides} />
                  ) : selected.doc ? (
                    <DocPreview doc={selected.doc} />
                  ) : (
                    <div className="preview-pane empty">{selected.message || "Ещё не обработано"}</div>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </ErrorBoundary>
  );
}

async function readEntries(entries: FileSystemEntry[]): Promise<File[]> {
  const out: File[] = [];
  async function walk(entry: FileSystemEntry, prefix: string) {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      Object.defineProperty(file, "webkitRelativePath", { value: prefix + entry.name, configurable: true });
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const children: FileSystemEntry[] = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const c of children) await walk(c, prefix + entry.name + "/");
    }
  }
  for (const e of entries) await walk(e, "");
  return out;
}
