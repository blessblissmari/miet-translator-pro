import {
  Document, Packer, Paragraph, HeadingLevel, TextRun, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, LevelFormat,
} from "docx";

// Build text runs from a string that may contain $...$ inline / $$...$$ display math.
// Inline math is rendered in italic monospace (Cambria Math); display goes to its own paragraph.
function runsWithMath(text, opts = {}) {
  const out = [];
  const re = /\$\$([^$]+?)\$\$|\$([^$\n]+?)\$/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      const seg = text.slice(last, m.index);
      if (seg) out.push(new TextRun({ text: seg, bold: opts.bold, font: "Times New Roman", size: 28 }));
    }
    const latex = (m[1] || m[2]).trim();
    out.push(new TextRun({ text: " " + latex + " ", italics: true, font: "Cambria Math", size: 28 }));
    last = re.lastIndex;
  }
  if (last < text.length) {
    out.push(new TextRun({ text: text.slice(last), bold: opts.bold, font: "Times New Roman", size: 28 }));
  }
  if (!out.length) out.push(new TextRun({ text, bold: opts.bold, font: "Times New Roman", size: 28 }));
  return out;
}

function blockToElements(block) {
  switch (block.type) {
    case "h1":
      return [new Paragraph({ heading: HeadingLevel.HEADING_1, children: runsWithMath(block.text, { bold: true }) })];
    case "h2":
      return [new Paragraph({ heading: HeadingLevel.HEADING_2, children: runsWithMath(block.text, { bold: true }) })];
    case "h3":
      return [new Paragraph({ heading: HeadingLevel.HEADING_3, children: runsWithMath(block.text, { bold: true }) })];
    case "para":
      return [new Paragraph({
        alignment: AlignmentType.JUSTIFIED,
        children: runsWithMath(block.text),
        spacing: { line: 360, after: 120 },
        indent: { firstLine: 720 },
      })];
    case "list":
      return block.items.map((it) => new Paragraph({
        bullet: block.ordered ? undefined : { level: 0 },
        numbering: block.ordered ? { reference: "ordered", level: 0 } : undefined,
        children: runsWithMath(it),
        spacing: { line: 360, after: 60 },
      }));
    case "formula":
      return [new Paragraph({
        alignment: block.display ? AlignmentType.CENTER : AlignmentType.LEFT,
        children: [new TextRun({ text: block.latex, italics: true, font: "Cambria Math", size: 28 })],
        spacing: { line: 360, before: 120, after: 120 },
      })];
    case "table": {
      const rows = block.rows.map((row, ri) => new TableRow({
        children: row.map((cell) => new TableCell({
          children: [new Paragraph({ children: runsWithMath(cell, { bold: !!(block.header && ri === 0) }) })],
        })),
      }));
      const border = { style: BorderStyle.SINGLE, size: 4, color: "888888" };
      return [new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows,
        borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
      })];
    }
    default:
      return [];
  }
}

export async function buildDocxFromBlocks({ title, blocks }) {
  const children = [];
  if (title) {
    children.push(new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: title, bold: true, font: "Times New Roman", size: 40 })],
      spacing: { after: 240 },
    }));
  }
  for (const b of blocks) {
    children.push(...blockToElements(b));
  }
  const doc = new Document({
    creator: "MIET Translator Pro",
    title: title || "Документ",
    styles: {
      default: {
        document: {
          run: { font: "Times New Roman", size: 28 },
          paragraph: { spacing: { line: 360, after: 120 } },
        },
        heading1: {
          run: { font: "Times New Roman", size: 32, bold: true },
          paragraph: { spacing: { before: 240, after: 120 } },
        },
        heading2: {
          run: { font: "Times New Roman", size: 28, bold: true },
          paragraph: { spacing: { before: 200, after: 100 } },
        },
        heading3: {
          run: { font: "Times New Roman", size: 26, bold: true, italics: true },
          paragraph: { spacing: { before: 160, after: 80 } },
        },
      },
    },
    numbering: {
      config: [{
        reference: "ordered",
        levels: [{
          level: 0,
          format: LevelFormat.DECIMAL,
          text: "%1.",
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 1134, bottom: 1134, left: 1701, right: 850 },
        },
      },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}
