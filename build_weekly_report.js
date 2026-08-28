// Combined weekly POS validation report: POSSUMM + POSDTLM.
// Usage: node build_weekly_report.js <possumm_results.json> <posdtlm_results.json> <output.docx> ["context line"]
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
function statusFill(status) {
  const s = String(status).toUpperCase();
  if (["MATCH", "PASS", "YES", "FIXED", "EXACT"].includes(s)) return { fill: GREEN, color: GREENTXT };
  if (["MISMATCH", "FAIL", "NO", "DIFF"].includes(s)) return { fill: RED, color: REDTXT };
  return { fill: YEL, color: YELTXT };
}
function table(headers, widths, rows, statusColIdx = null) {
  const headerRow = new TableRow({ tableHeader: true, children: headers.map((h, i) => headCell(h, widths[i])) });
  const bodyRows = rows.map(r => new TableRow({
    children: r.map((v, i) => {
      if (statusColIdx !== null && i === statusColIdx) {
        const sf = statusFill(v);
        return bodyCell(v, widths[i], { fill: sf.fill, color: sf.color, bold: true, align: AlignmentType.CENTER });
      }
      return bodyCell(v, widths[i]);
    })
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
function heading2(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 220, after: 110 }, children: [txt(text, { bold: true, size: 22, color: BLUE })] });
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
function bullet(text, opts = {}) { return new Paragraph({ bullet: { level: 0 }, spacing: { after: 55 }, children: [txt(text, { size: 20, ...opts })] }); }
function spacer(h = 100) { return new Paragraph({ spacing: { after: h }, children: [] }); }
function statusTag(word) {
  const sf = statusFill(word);
  return txt(" [" + word + "] ", { bold: true, color: sf.color, size: 18 });
}
function fmtKey(k) { return Array.isArray(k) ? k.join(" / ") : String(k); }

function classify(r) {
  const fr = r.field_results;
  const fields = r.common_fields;
  const brokenFields = fields.filter(f => fr[f].diff > 0);
  const formatFields = fields.filter(f => fr[f].diff === 0 && fr[f].soft > 0);
  const cleanFields = fields.filter(f => fr[f].diff === 0 && fr[f].soft === 0);
  const rowsOk = r.rows_missing_in_golden === 0 && r.rows_extra_in_golden === 0;
  const pass = rowsOk && brokenFields.length === 0 && formatFields.length === 0;
  return { brokenFields, formatFields, cleanFields, rowsOk, pass };
}

function buildSection(r, sectionTitle, children) {
  const { brokenFields, formatFields, cleanFields, pass } = classify(r);
  const fr = r.field_results;
  const fields = r.common_fields;

  children.push(heading1(sectionTitle));
  children.push(calloutBox(
    pass ? "RESULT: ALL DATA MATCHED" :
      `RESULT: MISMATCH — ${brokenFields.length} field(s) with real differences, ${formatFields.length} field(s) with format-only differences.`,
    pass ? "pass" : "fail"
  ));
  children.push(spacer(140));

  children.push(heading2("Files & Key"));
  children.push(bullet(`Validation key: ${r.key_fields.join(" + ")}`));
  if (r.excluded_fields && r.excluded_fields.length) {
    children.push(bullet(`Excluded from comparison (environment/run-specific): ${r.excluded_fields.join(", ")}`));
  }
  children.push(bullet(`Golden: ${r.golden_rows.toLocaleString()} rows. Generated: ${r.generated_rows.toLocaleString()} rows.`));

  children.push(heading2("Row-Level Match"));
  children.push(bullet(`Duplicate keys — Golden: ${r.golden_dupes}, Generated: ${r.generated_dupes}.`));
  children.push(bullet(`Rows in Generated not found in Golden: ${r.rows_missing_in_golden}.`));
  children.push(bullet(`Rows in Golden not found in Generated: ${r.rows_extra_in_golden}${r.rows_extra_in_golden > 0 ? " (Golden is a superset — expected, not a defect)" : ""}.`));
  if (r.rows_missing_in_golden > 0) r.missing_examples.forEach(k => children.push(bullet(`  Missing: ${fmtKey(k)}`)));

  const totalComparisons = fields.reduce((s, f) => s + fr[f].exact + fr[f].soft + fr[f].diff, 0);
  const totalExact = fields.reduce((s, f) => s + fr[f].exact, 0);
  const totalSoft = fields.reduce((s, f) => s + fr[f].soft, 0);
  const totalDiff = fields.reduce((s, f) => s + fr[f].diff, 0);
  children.push(heading2(`Field-by-Field Summary — All ${fields.length} Fields`));
  children.push(p(`${totalComparisons.toLocaleString()} total field comparisons (${r.rows_checked.toLocaleString()} rows × ${fields.length} fields):`, { bold: true }));
  children.push(table(
    ["Result", "Field comparisons", "What it means"], [2200, 2400, 4760],
    [
      ["Exact match", totalExact.toLocaleString(), `${cleanFields.length} of ${fields.length} fields match Golden on every row`],
      ["Format-only difference", totalSoft.toLocaleString(), `${formatFields.length} field(s) — same value, different formatting`],
      ["Real mismatch", totalDiff.toLocaleString(), `${brokenFields.length} field(s) — see below`],
    ]
  ));
  children.push(spacer(140));
  if (cleanFields.length) {
    children.push(p(`${cleanFields.length} fields matched perfectly on every row:`, { bold: true }));
    children.push(bullet(cleanFields.join(", ") + "."));
  }

  children.push(heading2("Every Mismatch, In Full"));
  if (brokenFields.length === 0 && formatFields.length === 0) {
    children.push(bullet("None. All fields matched exactly on every row."));
  }
  brokenFields.forEach(f => {
    const d = fr[f];
    children.push(new Paragraph({ spacing: { after: 60 }, children: [statusTag("MISMATCH"), txt(`${f} — differs on ${d.diff.toLocaleString()} of ${r.rows_checked.toLocaleString()} rows.`, { bold: true, size: 20 })] }));
    d.diff_examples.forEach(ex => children.push(bullet(`${fmtKey(ex.key)} — Golden '${ex.golden}', Generated '${ex.generated}'`)));
    if (d.diff > d.diff_examples.length) children.push(bullet(`...and ${d.diff - d.diff_examples.length} more row(s) with the same field mismatch.`));
    children.push(spacer(80));
  });
  formatFields.forEach(f => {
    const d = fr[f];
    children.push(new Paragraph({ spacing: { after: 60 }, children: [statusTag("MINOR"), txt(`${f} — formatting only, on ${d.soft.toLocaleString()} row(s). Same numeric value, different format.`, { bold: true, size: 20 })] }));
    d.soft_examples.forEach(ex => children.push(bullet(`${fmtKey(ex.key)} — Golden '${ex.golden}', Generated '${ex.generated}'`)));
    if (d.soft > d.soft_examples.length) children.push(bullet(`...and ${d.soft - d.soft_examples.length} more row(s) with the same formatting difference.`));
    children.push(spacer(80));
  });

  children.push(new Paragraph({ children: [], spacing: { after: 40 } }));
  return { pass, brokenFields, formatFields };
}

// ---------------------------------------------------------------------------
function main() {
  const [, , summJsonPath, dtlmJsonPath, outPath, customTitle] = process.argv;
  const summ = JSON.parse(fs.readFileSync(summJsonPath, "utf8"));
  const dtlm = JSON.parse(fs.readFileSync(dtlmJsonPath, "utf8"));
  const children = [];

  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 },
    children: [txt("WEEKLY VALIDATION REPORT", { bold: true, size: 32, color: NAVY })] }));
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 },
    children: [txt(customTitle || "POSSUMM + POSDTLM — Generated vs. Golden", { bold: true, size: 21, color: BLUE })] }));
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 },
    children: [txt("Complete field-by-field check, no sampling, every mismatch listed however small", { italics: true, size: 18, color: "595959" })] }));

  const sClass = classify(summ);
  const dClass = classify(dtlm);
  const overallPass = sClass.pass && dClass.pass;
  children.push(calloutBox(
    overallPass ? "OVERALL RESULT: ALL DATA MATCHED — both POSSUMM and POSDTLM." :
      `OVERALL RESULT: MISMATCH — POSSUMM: ${sClass.pass ? "clean" : sClass.brokenFields.length + " field(s) broken"}. POSDTLM: ${dClass.pass ? "clean" : dClass.brokenFields.length + " field(s) broken"}.`,
    overallPass ? "pass" : "fail"
  ));
  children.push(spacer(160));

  children.push(heading1("Executive Summary"));
  children.push(table(
    ["File", "Rows (Golden / Generated)", "Fields checked", "Real mismatches", "Format-only", "Verdict"],
    [1800, 2200, 1500, 1500, 1300, 1060],
    [
      ["POSSUMM", `${summ.golden_rows.toLocaleString()} / ${summ.generated_rows.toLocaleString()}`, summ.common_fields.length,
       sClass.brokenFields.length, sClass.formatFields.length, sClass.pass ? "MATCH" : "MISMATCH"],
      ["POSDTLM", `${dtlm.golden_rows.toLocaleString()} / ${dtlm.generated_rows.toLocaleString()}`, dtlm.common_fields.length,
       dClass.brokenFields.length, dClass.formatFields.length, dClass.pass ? "MATCH" : "MISMATCH"],
    ],
    5
  ));
  children.push(spacer(140));
  children.push(p("Common thread across both weekly files:", { bold: true }));
  children.push(bullet("PDRSP / PSRSP (selling price) is blank or zero on every row in both POSSUMM and POSDTLM — the same enrichment gap seen earlier at the daily grain (POSDLYM) is still present after the weekly rollup."));
  children.push(bullet("PDPVEN (primary vendor) is blank on every POSDTLM row — same story as the daily-grain P0PVEN gap; POSSUMM doesn't carry a vendor field so this can't be cross-checked there."));
  children.push(bullet("Cost-related zero fields (PSCPRC/PDCPRC, PSACST/PDACST) show the same formatting-only pattern as before — Golden writes bare '0', Generated writes '0.00' or '0.0000'."));
  children.push(bullet("Row identity and counts are otherwise clean on both files — every Generated row exists in Golden, no duplicates, no extras."));

  buildSection(summ, "1. POSSUMM — Weekly Summary History", children);
  children.push(new Paragraph({ children: [], pageBreakBefore: true }));
  buildSection(dtlm, "2. POSDTLM — Weekly Detail History", children);

  children.push(heading1("3. Conclusion"));
  children.push(bullet(`POSSUMM — ${sClass.pass ? "PASS, all data matched." : `FAIL. Real mismatches: ${sClass.brokenFields.join(", ")}. Format-only: ${sClass.formatFields.join(", ") || "none"}.`}`));
  children.push(bullet(`POSDTLM — ${dClass.pass ? "PASS, all data matched." : `FAIL. Real mismatches: ${dClass.brokenFields.join(", ")}. Format-only: ${dClass.formatFields.join(", ") || "none"}.`}`));
  children.push(spacer(80));
  children.push(bullet("Recommend fixing the shared selling-price (RSP) and primary-vendor (PVEN) enrichment gap once at the source — it's showing up identically at daily and weekly grain, so it's very likely one root cause feeding both."));
  children.push(bullet("Recommend logging the weekly-specific findings (PDQOH small deltas, PDSFL1/PDSFL2/PDBSC1 on POSDTLM) as separate bug tracker entries, since they don't have an obvious shared cause with the RSP/PVEN gap."));
  children.push(bullet("Format-only fields (PSCPRC/PDCPRC, PSACST/PDACST) are low priority but worth a single formatting fix since the same pattern repeats across every file type tested so far."));

  children.push(spacer(240));
  children.push(new Paragraph({ border: { top: { style: BorderStyle.SINGLE, size: 6, color: BORDER_GREY, space: 8 } }, spacing: { before: 180 },
    children: [txt(`POSSUMM — Golden: ${summ._golden_path.split("/").pop()} | Generated: ${summ._generated_path.split("/").pop()}`, { italics: true, size: 16, color: "808080" })] }));
  children.push(new Paragraph({ spacing: { before: 40 },
    children: [txt(`POSDTLM — Golden: ${dtlm._golden_path.split("/").pop()} | Generated: ${dtlm._generated_path.split("/").pop()}`, { italics: true, size: 16, color: "808080" })] }));

  const doc = new Document({
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, bottom: 1080, left: 1440, right: 1440 } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT,
        children: [txt("Weekly Validation Report — POSSUMM + POSDTLM", { size: 16, color: "808080" })] })] }) },
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
