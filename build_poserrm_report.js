// POSERRM analysis report builder.
// Usage: node build_poserrm_report.js <poserrm_results.json> <output.docx> ["context line"]
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, AlignmentType, VerticalAlign,
  Header, Footer, PageNumber
} = require("docx");
const fs = require("fs");

const NAVY = "1F3864", BLUE = "2E5C8A", GREEN = "C6EFCE", GREENTXT = "006100";
const RED = "FFC7CE", REDTXT = "9C0006", YEL = "FFF2CC", YELTXT = "7F6000";
const BORDER_GREY = "BFBFBF";
const F = "Calibri";
const TABLE_W = 9360;

function cellBorder() {
  const side = { style: BorderStyle.SINGLE, size: 2, color: BORDER_GREY };
  return { top: side, bottom: side, left: side, right: side };
}
function txt(text, opts = {}) { return new TextRun({ text: String(text), font: F, size: 20, ...opts }); }
function p(text, opts = {}) { return new Paragraph({ children: [txt(text, opts)], spacing: { after: 90 } }); }
function headCell(text, width) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: BLUE },
    verticalAlign: VerticalAlign.CENTER, borders: cellBorder(), margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [txt(text, { bold: true, color: "FFFFFF", size: 18 })] })]
  });
}
function bodyCell(text, width, opts = {}) {
  const { fill, bold, color, align } = opts;
  return new TableCell({
    width: { size: width, type: WidthType.DXA }, shading: fill ? { type: ShadingType.CLEAR, fill } : undefined,
    verticalAlign: VerticalAlign.CENTER, borders: cellBorder(), margins: { top: 50, bottom: 50, left: 100, right: 100 },
    children: [new Paragraph({ alignment: align || AlignmentType.LEFT, children: [txt(text, { bold: !!bold, color, size: 18 })] })]
  });
}
function table(headers, widths, rows, boldColIdx = null) {
  const headerRow = new TableRow({ tableHeader: true, children: headers.map((h, i) => headCell(h, widths[i])) });
  const bodyRows = rows.map(r => new TableRow({
    children: r.map((v, i) => bodyCell(v, widths[i], { bold: i === boldColIdx, align: typeof v === "number" || /^[\d,]+$/.test(String(v)) ? AlignmentType.CENTER : AlignmentType.LEFT }))
  }));
  return new Table({ width: { size: TABLE_W, type: WidthType.DXA }, columnWidths: widths, rows: [headerRow, ...bodyRows] });
}
function heading1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 130 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: NAVY, space: 4 } },
    children: [txt(text, { bold: true, size: 25, color: NAVY })]
  });
}
function calloutBox(text, kind) {
  const fill = kind === "pass" ? GREEN : kind === "fail" ? RED : YEL;
  const color = kind === "pass" ? GREENTXT : kind === "fail" ? REDTXT : YELTXT;
  return new Table({
    width: { size: TABLE_W, type: WidthType.DXA }, columnWidths: [TABLE_W],
    rows: [new TableRow({ children: [new TableCell({
      width: { size: TABLE_W, type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill },
      borders: cellBorder(), margins: { top: 130, bottom: 130, left: 180, right: 180 },
      children: [new Paragraph({ children: [txt(text, { bold: true, color, size: 20 })] })]
    })] })]
  });
}
function bullet(text) { return new Paragraph({ bullet: { level: 0 }, spacing: { after: 55 }, children: [txt(text, { size: 20 })] }); }
function spacer(h = 100) { return new Paragraph({ spacing: { after: h }, children: [] }); }
function nf(n) { return Number(n).toLocaleString(); }

function main() {
  const [, , jsonPath, outPath, customTitle] = process.argv;
  if (!jsonPath || !outPath) {
    console.error('Usage: node build_poserrm_report.js <poserrm_results.json> <output.docx> ["context line"]');
    process.exit(1);
  }
  const r = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const children = [];

  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 },
    children: [txt("POSERRM VALIDATION REPORT", { bold: true, size: 32, color: NAVY })] }));
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 },
    children: [txt(customTitle || "Reject records grouped by ESRES1", { bold: true, size: 21, color: BLUE })] }));
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 },
    children: [txt("Every reject row read, no sampling", { italics: true, size: 18, color: "595959" })] }));

  children.push(calloutBox(`${nf(r.total_rows)} reject rows across ${r.categories.length} categor${r.categories.length === 1 ? "y" : "ies"}, ${nf(r.distinct_stores_affected)} stores affected.`, "info"));
  children.push(spacer(140));

  children.push(heading1("File Summary"));
  children.push(bullet(`Total POSERRM rows: ${nf(r.total_rows)}`));
  children.push(bullet(`Run IDs covered: ${r.distinct_run_ids.join(", ")}`));
  children.push(bullet(`Chain(s): ${r.chains.join(", ")}   Agency/agencies: ${r.agencies.join(", ")}`));
  children.push(bullet(`Distinct stores affected (any category): ${nf(r.distinct_stores_affected)}`));

  children.push(heading1("Reject Totals by Category (ESRES1)"));
  children.push(table(
    ["Category (ESRES1)", "Code (ESERC1)", "Total Count", "Unique UPCs", "Stores Affected"],
    [3560, 1600, 1600, 1600, 1600],
    r.categories.map(c => [c.category, c.code, nf(c.total_count), nf(c.unique_upcs), nf(c.stores_affected)]),
    2
  ));

  r.categories.forEach((c, i) => {
    children.push(new Paragraph({ children: [], pageBreakBefore: i > 0 }));
    children.push(heading1(`${i + 1}. ${c.category} — Unique UPC Breakdown`));
    children.push(bullet(`Total count: ${nf(c.total_count)}     Unique UPCs: ${nf(c.unique_upcs)}     Stores affected: ${nf(c.stores_affected)}`));
    children.push(table(
      ["UPC", "Occurrence Count", "Stores Affected"],
      [5360, 2000, 2000],
      c.upc_breakdown.map(u => [u.upc || "(blank)", nf(u.count), nf(u.stores_affected)]),
      1
    ));
  });

  children.push(new Paragraph({ children: [], pageBreakBefore: true }));
  children.push(heading1("Conclusion"));
  r.categories.forEach(c => {
    children.push(bullet(`${c.category}: ${nf(c.total_count)} rows, ${nf(c.unique_upcs)} unique UPC(s) — top offender: ${c.upc_breakdown[0] ? `${c.upc_breakdown[0].upc} (${nf(c.upc_breakdown[0].count)} occurrences)` : "n/a"}.`));
  });
  children.push(spacer(80));
  children.push(bullet("ITEM MASTER MISSING and UPC NOT FOUND both point at the item master / cross-reference tables not being seeded for these UPCs — same family of root cause as the identity-waterfall gaps seen in the run-log analysis, worth checking together."));
  children.push(bullet("SCAN MATCH REVERSED concentrated on a small number of UPCs suggests a specific never-distributed-to-chain flag issue for those items, not a systemic gap."));

  children.push(spacer(240));
  children.push(new Paragraph({ border: { top: { style: BorderStyle.SINGLE, size: 6, color: BORDER_GREY, space: 8 } }, spacing: { before: 180 },
    children: [txt(`Source: ${(r._source_filename || r._source_file || "").split("/").pop()}`, { italics: true, size: 16, color: "808080" })] }));

  const doc = new Document({
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, bottom: 1080, left: 1440, right: 1440 } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT,
        children: [txt("POSERRM Validation Report", { size: 16, color: "808080" })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER,
        children: [txt("Page ", { size: 16, color: "808080" }), new TextRun({ children: [PageNumber.CURRENT], font: F, size: 16, color: "808080" }),
          txt(" of ", { size: 16, color: "808080" }), new TextRun({ children: [PageNumber.TOTAL_PAGES], font: F, size: 16, color: "808080" })]
      })] }) },
      children
    }]
  });

  Packer.toBuffer(doc).then(buf => {
    fs.writeFileSync(outPath, buf);
    console.log("saved " + outPath);
  });
}
main();
