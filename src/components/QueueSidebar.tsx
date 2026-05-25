import type { QueueItem, Kind } from "../types/queue";

interface QueueSidebarProps {
  items: QueueItem[];
  selectedId: string | null;
  running: boolean;
  paused?: boolean;
  hasKey: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onChangeKind: (id: string, kind: Kind) => void;
  onDownloadOne: (it: QueueItem) => void;
  onRunAll: () => void;
  onCancelAll: () => void;
  onTogglePause?: () => void;
  onDownloadAll: () => void;
  onClearAll: () => void;
  onFilesSelected: (files: FileList | File[]) => void;
  dropRef: React.RefObject<HTMLDivElement | null>;
}

function statusLabel(s: QueueItem["status"]): string {
  switch (s) {
    case "queued":
      return "В очереди";
    case "extracting":
      return "Чтение…";
    case "translating":
      return "Перевод…";
    case "building":
      return "Сборка…";
    case "done":
      return "Готово";
    case "error":
      return "Ошибка";
  }
}

function fmtElapsed(ms: number | undefined): string {
  if (!ms || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m} мин ${r.toString().padStart(2, "0")} с`;
}

export function QueueSidebar({
  items,
  selectedId,
  running,
  paused,
  hasKey,
  onSelect,
  onRemove,
  onRetry,
  onChangeKind,
  onDownloadOne,
  onRunAll,
  onCancelAll,
  onTogglePause,
  onDownloadAll,
  onClearAll,
  onFilesSelected,
  dropRef,
}: QueueSidebarProps) {
  const totalQueued = items.filter(
    (i) => i.status === "queued" || i.status === "error",
  ).length;
  const totalDone = items.filter((i) => i.status === "done").length;
  const totalErrors = items.filter((i) => i.status === "error").length;

  return (
    <aside className="sidebar">
      <div className="dropzone" ref={dropRef}>
        <p>
          Брось <b>файлы</b>, <b>папку</b> или <b>.zip / .rar / .7z</b>
        </p>
        <p className="muted small">PDF · PPTX · DOCX · картинки · txt</p>
        <div className="dropzone-actions">
          <label className="ghost">
            Файлы…
            <input
              type="file"
              multiple
              accept=".pdf,.pptx,.docx,.png,.jpg,.jpeg,.webp,.gif,.bmp,.txt,.md,.zip,.rar,.7z,.tar,.gz,.tgz"
              onChange={(e) =>
                e.target.files && onFilesSelected(e.target.files)
              }
              hidden
            />
          </label>
          <label className="ghost">
            Папка…
            <input
              type="file"
              {...({ webkitdirectory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
              onChange={(e) =>
                e.target.files && onFilesSelected(e.target.files)
              }
              hidden
            />
          </label>
        </div>
      </div>

      <div className="queue-controls">
        <button
          className="primary"
          onClick={onRunAll}
          disabled={running || totalQueued === 0 || !hasKey}
          title={!hasKey ? "Добавь ключ MiMo в Настройках" : ""}
        >
          {running ? "Обработка…" : `Запустить (${totalQueued})`}
        </button>
        {running && onTogglePause && (
          <button className="ghost" onClick={onTogglePause}>
            {paused ? "▶ Продолжить" : "⏸ Пауза"}
          </button>
        )}
        {running && (
          <button className="ghost" onClick={onCancelAll}>
            Стоп
          </button>
        )}
        {totalErrors > 0 && !running && (
          <button
            className="ghost"
            onClick={() => {
              items.filter((i) => i.status === "error").forEach((i) => onRetry(i.id));
            }}
            title="Повторить все ошибки"
          >
            ↻ Ошибки ({totalErrors})
          </button>
        )}
        <button
          className="ghost"
          onClick={onDownloadAll}
          disabled={!items.some((i) => i.status === "done")}
          title={
            items.some((i) => i.status === "done") ? "" : "Нет готовых файлов"
          }
        >
          ⬇ Скачать всё{totalDone > 0 ? ` (${totalDone})` : ""}
        </button>
        <button className="ghost" onClick={onClearAll} disabled={running}>
          Очистить
        </button>
      </div>

      {items.length > 0 && (
        <div className="queue-summary muted small">
          {totalDone > 0 && <span>✓ {totalDone}</span>}
          {totalQueued > 0 && <span>· в очереди {totalQueued}</span>}
          {totalErrors > 0 && (
            <span className="queue-summary-err">· ошибок {totalErrors}</span>
          )}
        </div>
      )}

      <ul className="queue">
        {items.map((it) => {
          const pct = it.progress
            ? Math.round(
                (it.progress.done / Math.max(it.progress.total, 1)) * 100,
              )
            : 0;
          const elapsed = it.elapsedMs ? fmtElapsed(it.elapsedMs) : "";
          return (
            <li
              key={it.id}
              className={`q-item q-${it.status} ${selectedId === it.id ? "selected" : ""}`}
              onClick={() => onSelect(it.id)}
            >
              <div className="q-top">
                <span className="q-name" title={it.path}>
                  {it.path.split("/").pop()}
                </span>
                <select
                  className={`q-kind kind-${it.kind}`}
                  value={it.kind}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) =>
                    onChangeKind(it.id, e.target.value as Kind)
                  }
                >
                  <option value="presentation">PPT</option>
                  <option value="document">DOC</option>
                </select>
                <button
                  className="q-remove"
                  title="удалить"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(it.id);
                  }}
                >
                  ×
                </button>
              </div>
              <div className="q-status" title={it.error || it.message || ""}>
                {it.message ?? statusLabel(it.status)}
                {it.progress && it.progress.total > 1 && (
                  <span className="q-progress-num">
                    {" "}
                    · {it.progress.done}/{it.progress.total}
                  </span>
                )}
                {elapsed && <span className="q-elapsed"> · {elapsed}</span>}
              </div>
              {it.progress && (
                <div className="progress small" title={`${pct}%`}>
                  <div className="bar" style={{ width: `${pct}%` }} />
                </div>
              )}
              {it.status === "error" && (
                <button
                  className="ghost q-retry"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRetry(it.id);
                  }}
                  disabled={running}
                >
                  ↻ Повторить
                </button>
              )}
              {it.status === "done" && (
                <button
                  className="ghost q-download"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDownloadOne(it);
                  }}
                >
                  ⬇ {it.resultName}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
