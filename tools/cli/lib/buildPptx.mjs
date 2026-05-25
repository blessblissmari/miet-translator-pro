// Node port of src/lib/pptxBuild.ts — builds PPTX in the MIET template from SlidePlan objects.
import JSZip from "jszip";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = process.env.MIET_TEMPLATE
  || path.resolve(__dirname, "..", "..", "..", "src", "assets", "template.pptx");

const LAYOUT_INDEX = {
  "section-title": 1,
  "title-text": 4,
  "title-text-image-right": 5,
  "title-text-image-left": 6,
  "title-image": 7,
};

const GEOM = {
  1: {},
  4: {
    title:   { x: 457197,  y: 587901,  cx: 11277605, cy: 1206715 },
    body:    { x: 466197,  y: 2057400, cx: 11260606, cy: 4400000 },
  },
  5: {
    title:   { x: 457197,  y: 587901,  cx: 5594740,  cy: 1206715 },
    body:    { x: 466198,  y: 2048933, cx: 5689069,  cy: 4400000 },
    picture: { x: 6611938, y: 737130,  cx: 5580062,  cy: 5800000 },
  },
  6: {
    title:   { x: 6053662, y: 587901,  cx: 5594740,  cy: 1206715 },
    body:    { x: 6079597, y: 2048933, cx: 5689069,  cy: 4400000 },
    picture: { x: 0,       y: 737130,  cx: 5580062,  cy: 5800000 },
  },
  7: {
    body:    { x: 2083331, y: 5486399, cx: 7518400,  cy: 600000  },
    picture: { x: 2083331, y: 499533,  cx: 7518400,  cy: 4851400 },
  },
};

function dataUrlToUint8(dataUrl) {
  const base64 = dataUrl.split(",")[1];
  return new Uint8Array(Buffer.from(base64, "base64"));
}

function escXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function paragraphsXml(paragraphs) {
  if (paragraphs.length === 0) return `<a:p><a:endParaRPr lang="ru-RU"/></a:p>`;
  return paragraphs.map(p => `<a:p><a:r><a:rPr lang="ru-RU" dirty="0"/><a:t>${escXml(p)}</a:t></a:r></a:p>`).join("");
}

function bulletsXml(bullets) {
  if (bullets.length === 0) return `<a:p><a:endParaRPr lang="ru-RU"/></a:p>`;
  return bullets.map(b => `<a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="ru-RU" dirty="0"/><a:t>${escXml(b)}</a:t></a:r></a:p>`).join("");
}

function spText(id, name, phType, phIdxAttr, box, paraXml) {
  const xfrm = box
    ? `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm></p:spPr>`
    : `<p:spPr/>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escXml(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="${phType}"${phIdxAttr}/></p:nvPr></p:nvSpPr>${xfrm}<p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:normAutofit fontScale="90000" lnSpcReduction="10000"/></a:bodyPr><a:lstStyle/>${paraXml}</p:txBody></p:sp>`;
}

function picXml(id, rId, box) {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function buildSlideXml(plan, imageRId) {
  const layoutNum = LAYOUT_INDEX[plan.layout];
  const geom = GEOM[layoutNum] ?? {};
  const parts = [];
  let nextId = 2;

  if (plan.title?.trim()) {
    if (plan.layout === "section-title") {
      parts.push(spText(nextId++, "Заголовок", "ctrTitle", "", undefined, paragraphsXml([plan.title])));
    } else if (geom.title || plan.layout !== "title-image") {
      parts.push(spText(nextId++, "Заголовок", "title", "", geom.title, paragraphsXml([plan.title])));
    }
  }

  if (plan.bullets && plan.bullets.length > 0) {
    parts.push(spText(nextId++, "Текст", "body", ' sz="quarter" idx="12"', geom.body, bulletsXml(plan.bullets)));
  }

  if (imageRId && geom.picture) {
    parts.push(picXml(nextId, imageRId, geom.picture));
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${parts.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function buildSlideRels(layoutNum, imageFileName) {
  const items = [
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout${layoutNum}.xml"/>`,
  ];
  if (imageFileName) {
    items.push(`<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${imageFileName}"/>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join("")}</Relationships>`;
}

export async function buildPptx(slides) {
  const tplBuf = await readFile(TEMPLATE_PATH);
  const zip = await JSZip.loadAsync(tplBuf);

  // 1) Remove existing slides + their rels
  for (const p of Object.keys(zip.files).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p))) zip.remove(p);
  for (const p of Object.keys(zip.files).filter(p => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(p))) zip.remove(p);

  // Drop media not referenced by any layout/master/theme rels.
  const mediaFiles = Object.keys(zip.files).filter(p => p.startsWith("ppt/media/"));
  const layoutRelsXmls = await Promise.all(
    Object.keys(zip.files)
      .filter(p => /^ppt\/slideLayouts\/_rels\//.test(p) || /^ppt\/slideMasters\/_rels\//.test(p) || /^ppt\/theme\/_rels\//.test(p))
      .map(p => zip.file(p).async("string"))
  );
  const referenced = new Set();
  for (const r of layoutRelsXmls) {
    for (const m of r.matchAll(/Target="\.\.\/media\/([^"]+)"/g)) referenced.add(m[1]);
  }
  for (const m of mediaFiles) {
    const name = m.replace("ppt/media/", "");
    if (!referenced.has(name)) zip.remove(m);
  }

  // 2) Add new slides + media
  let mediaCounter = 0;
  for (let i = 0; i < slides.length; i++) {
    const plan = slides[i];
    const slideNum = i + 1;
    let imageFileName = null;
    let imageRId = null;
    if (plan.imageDataUrl) {
      mediaCounter++;
      imageFileName = `slide_${slideNum}_img${mediaCounter}.png`;
      zip.file(`ppt/media/${imageFileName}`, dataUrlToUint8(plan.imageDataUrl));
      imageRId = "rId2";
    }
    const layoutNum = LAYOUT_INDEX[plan.layout];
    zip.file(`ppt/slides/slide${slideNum}.xml`, buildSlideXml(plan, imageRId));
    zip.file(`ppt/slides/_rels/slide${slideNum}.xml.rels`, buildSlideRels(layoutNum, imageFileName));
  }

  // 3) Update [Content_Types].xml
  let ct = await zip.file("[Content_Types].xml").async("string");
  ct = ct.replace(/<Override\s+PartName="\/ppt\/slides\/slide\d+\.xml"[^/]*\/>/g, "");
  if (!/Extension="png"/.test(ct)) {
    ct = ct.replace(/<Default[^>]*Extension="jpeg"[^/]*\/>/i, m => m + `<Default Extension="png" ContentType="image/png"/>`);
    if (!/Extension="png"/.test(ct)) {
      ct = ct.replace(/<Types\b[^>]*>/, m => m + `<Default Extension="png" ContentType="image/png"/>`);
    }
  }
  const overrides = slides
    .map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
    .join("");
  ct = ct.replace("</Types>", `${overrides}</Types>`);
  zip.file("[Content_Types].xml", ct);

  // 4) Update presentation.xml + its rels
  let presRels = await zip.file("ppt/_rels/presentation.xml.rels").async("string");
  let pres = await zip.file("ppt/presentation.xml").async("string");

  presRels = presRels.replace(/<Relationship\s[^>]*Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/slide"[^/]*\/>/g, "");
  const existingIds = Array.from(presRels.matchAll(/Id="rId(\d+)"/g)).map(m => parseInt(m[1], 10));
  const startId = (existingIds.length ? Math.max(...existingIds) : 0) + 1;
  const newRels = [];
  const sldEntries = [];
  for (let i = 0; i < slides.length; i++) {
    const rid = `rId${startId + i}`;
    newRels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`);
    sldEntries.push(`<p:sldId id="${256 + i}" r:id="${rid}"/>`);
  }
  presRels = presRels.replace("</Relationships>", `${newRels.join("")}</Relationships>`);
  zip.file("ppt/_rels/presentation.xml.rels", presRels);

  pres = pres.replace(/<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/, `<p:sldIdLst>${sldEntries.join("")}</p:sldIdLst>`);
  zip.file("ppt/presentation.xml", pres);

  return zip.generateAsync({ type: "uint8array" });
}
