// MinerU cloud OCR client for Node.
//   1) POST /file-urls/batch (with extract:true, model_version:"vlm")
//   2) PUT the PDF to the presigned URL it returns
//   3) Poll /extract-results/batch/<id> until status==done for the file
//   4) Download result.zip, return the full.md text
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const API = "https://mineru.net/api/v4";

async function jpost(url, token, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`MinerU ${url}: ${j.msg || JSON.stringify(j)}`);
  return j.data;
}
async function jget(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`MinerU ${url}: ${j.msg || JSON.stringify(j)}`);
  return j.data;
}

export async function mineruExtractMarkdown({ token, pdfPath, workDir, lang = "en", modelVersion = "vlm" }) {
  await mkdir(workDir, { recursive: true });
  const name = path.basename(pdfPath);

  // 1. Get presigned upload URL
  const batch = await jpost(`${API}/file-urls/batch`, token, {
    language: lang,
    enable_formula: true,
    enable_table: true,
    model_version: modelVersion,
    files: [{ name, is_ocr: true, data_id: "doc1" }],
  });
  const { batch_id, file_urls } = batch;
  const uploadUrl = file_urls[0];

  // 2. PUT the PDF
  const buf = await readFile(pdfPath);
  const r = await fetch(uploadUrl, { method: "PUT", body: buf });
  if (!r.ok) throw new Error(`MinerU upload PUT: HTTP ${r.status}`);

  // 3. Poll for completion (~60-300s typical)
  const start = Date.now();
  let lastState = "";
  for (let i = 0; i < 360; i++) {
    const status = await jget(`${API}/extract-results/batch/${batch_id}`, token);
    const f = status?.extract_result?.[0];
    if (f) {
      if (f.state !== lastState) {
        process.stderr.write(`  mineru state=${f.state} (${Math.round((Date.now()-start)/1000)}s)\n`);
        lastState = f.state;
      }
      if (f.state === "done" && f.full_zip_url) {
        // 4. Download result.zip
        const zr = await fetch(f.full_zip_url);
        if (!zr.ok) throw new Error(`MinerU result download HTTP ${zr.status}`);
        const zbuf = Buffer.from(await zr.arrayBuffer());
        const zipPath = path.join(workDir, "result.zip");
        await writeFile(zipPath, zbuf);

        // 5. Extract full.md
        const extractDir = path.join(workDir, "extracted");
        await mkdir(extractDir, { recursive: true });
        await new Promise((resolve, reject) => {
          const p = spawn("unzip", ["-o", "-q", zipPath, "-d", extractDir]);
          p.on("close", (c) => c === 0 ? resolve() : reject(new Error("unzip failed")));
          p.on("error", reject);
        });
        const mdPath = path.join(extractDir, "full.md");
        const md = await readFile(mdPath, "utf8");
        return { markdown: md, dir: extractDir, batchId: batch_id };
      }
      if (f.state === "failed") throw new Error(`MinerU failed: ${f.err_msg || "unknown"}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("MinerU timed out after 30 min");
}
