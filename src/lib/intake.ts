import JSZip from "jszip";
import { Archive } from "libarchive.js";

let initialized = false;
async function ensureInit() {
  if (initialized) return;
  Archive.init({
    workerUrl: `${import.meta.env.BASE_URL}worker-bundle.js`,
  });
  initialized = true;
}

export interface IntakeFile {
  /** Display path (e.g. "2 Дымань/Ch5(1).pdf"). */
  path: string;
  blob: Blob;
}

const ZIP_EXT = /\.(zip)$/i;
const ARCHIVE_EXT = /\.(rar|7z|tar|tar\.gz|tgz)$/i;
const SUPPORTED_EXT = /\.(pdf|pptx|docx|png|jpe?g|webp|gif|bmp|txt|md|markdown|rst)$/i;

/** Recursively expand the input list into individual document blobs.
 *  Accepts:
 *  - Any supported file (.pdf, .pptx, .docx, image, txt, …)
 *  - Archives (.zip / .rar / .7z / .tar / .tar.gz) — extracted recursively
 *  - Folder uploads via webkitdirectory or DataTransfer entries — flat File[]
 */
export async function expandInputs(files: File[]): Promise<IntakeFile[]> {
  const out: IntakeFile[] = [];
  for (const f of files) {
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (ZIP_EXT.test(f.name)) {
      const inner = await extractZip(f);
      for (const x of inner) out.push(x);
    } else if (ARCHIVE_EXT.test(f.name)) {
      const inner = await extractArchive(f);
      for (const x of inner) out.push(x);
    } else if (SUPPORTED_EXT.test(f.name)) {
      out.push({ path, blob: f });
    } else {
      // Unknown type — skip
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}



async function extractZip(file: File): Promise<IntakeFile[]> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const out: IntakeFile[] = [];
  for (const path of Object.keys(zip.files)) {
    const entry = zip.files[path];
    if (entry.dir) continue;
    if (!SUPPORTED_EXT.test(path)) continue;
    const blob = await entry.async("blob");
    out.push({ path, blob });
  }
  return out;
}

async function extractArchive(file: File): Promise<IntakeFile[]> {
  await ensureInit();
  const archive = await Archive.open(file);
  // extractFiles returns nested object {dirname: {filename: File}}; we'll walk it.
  const tree = (await archive.extractFiles()) as Record<string, unknown>;
  const out: IntakeFile[] = [];
  walkTree(tree, "", out);
  return out;
}

function walkTree(node: unknown, prefix: string, out: IntakeFile[]) {
  if (node instanceof File) {
    if (SUPPORTED_EXT.test(node.name)) {
      out.push({ path: prefix.replace(/\/+$/, "") || node.name, blob: node });
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const next = prefix ? `${prefix}/${k}` : k;
      walkTree(v, next, out);
    }
  }
}

/** Heuristic: does this PDF look like a presentation (slide deck) or a document? */
export async function detectKind(blob: Blob): Promise<"presentation" | "document"> {
  // Use pdfjs to read first page dimensions
  const pdfjsLib = await (await import("./pdfjs")).getPdfjs();

  const buf = await blob.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const ratio = vp.width / vp.height;
  // Slides are landscape; documents are portrait/letter
  return ratio > 1.2 ? "presentation" : "document";
}
