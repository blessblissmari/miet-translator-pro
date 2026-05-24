import { useEffect, useMemo, useState } from "react";
import JSZip from "jszip";
import { PdfPreview } from "./Preview";

export function OriginalPreview({
  blob,
  path,
}: {
  blob: Blob;
  path: string;
}) {
  const ext = path.toLowerCase().split(".").pop();
  if (ext === "pdf") return <PdfPreview blob={blob} />;
  if (
    ext === "png" ||
    ext === "jpg" ||
    ext === "jpeg" ||
    ext === "webp" ||
    ext === "gif" ||
    ext === "bmp"
  ) {
    return <ImageOnly blob={blob} />;
  }
  return <RawTextPreview blob={blob} path={path} />;
}

function ImageOnly({ blob }: { blob: Blob }) {
  const url = useMemo(() => URL.createObjectURL(blob), [blob]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="preview-pane">
      <img src={url} alt="" style={{ maxWidth: "100%" }} />
    </div>
  );
}

function RawTextPreview({ blob, path }: { blob: Blob; path: string }) {
  const [text, setText] = useState("Загрузка…");
  useEffect(() => {
    (async () => {
      const ext = path.toLowerCase().split(".").pop();
      try {
        if (ext === "docx") {
          const m = await import("mammoth/mammoth.browser.js");
          const r = await m.extractRawText({
            arrayBuffer: await blob.arrayBuffer(),
          });
          setText(r.value || "(пусто)");
        } else if (ext === "pptx") {
          const zip = await JSZip.loadAsync(await blob.arrayBuffer());
          const slides = Object.keys(zip.files)
            .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
            .sort();
          const out: string[] = [];
          for (let i = 0; i < slides.length; i++) {
            const xml = await zip.files[slides[i]].async("string");
            const txt: string[] = [];
            const re = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(xml))) txt.push(m[1]);
            out.push(`--- Слайд ${i + 1} ---\n` + txt.join("\n"));
          }
          setText(out.join("\n\n"));
        } else {
          setText(await blob.text());
        }
      } catch (e) {
        setText("Не удалось прочитать: " + (e as Error).message);
      }
    })();
  }, [blob, path]);
  return (
    <div className="preview-pane">
      <pre className="raw-text">{text}</pre>
    </div>
  );
}
