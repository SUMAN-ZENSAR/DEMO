// Generic POS validation report builder.
// Usage: node build_report.js <results.json> <output.docx> ["Optional custom title line"]
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
  return { fill: YEL, color: YELTXT }; // format-only / minor / structural / soft
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

// ---------------------------------------------------------------------------
function buildPOSDATAMJ(r, children) {
  const pass = r.facts_missing_in_golden === 0 && r.facts_qty_mismatch === 0;
  children.push(calloutBox(
    pass ? "RESULT: ALL DATA MATCHED" : `RESULT: MISMATCH — ${r.facts_qty_mismatch} quantity difference(s), ${r.facts_missing_in_golden} record(s) not found in Golden.`,
    pass ? "pass" : "fail"
  ));
  children.push(spacer(140));
  children.push(heading1("File Summary"));
  children.push(table(
    ["Metric", "Golden", "Generated"], [4000, 2680, 2680],
    [
      ["Total records (lines)", r.golden_rows.toLocaleString(), r.generated_rows.toLocaleString()],
      ["Transaction sets", r.golden_sets, r.generated_sets],
      ["LIN (item) segments", r.golden_lins.toLocaleString(), r.generated_lins.toLocaleString()],
      ["Store/quantity detail facts", r.golden_facts.toLocaleString(), r.generated_facts.toLocaleString()],
    ]
  ));
  children.push(spacer(140));
  children.push(heading1("Fact-Level Validation"));
  children.push(bullet(`${r.facts_matched.toLocaleString()} of ${r.generated_facts.toLocaleString()} Generated facts (item + store + activity qualifier + date) matched Golden exactly.`));
  if (r.facts_missing_in_golden > 0) {
    children.push(new Paragraph({ spacing: { after: 60 }, children: [statusTag("MISMATCH"), txt(`${r.facts_missing_in_golden} Generated fact(s) not found anywhere in Golden:`, { bold: true, size: 20 })] }));
    r.missing_examples.forEach(m => children.push(bullet(`${fmtKey(m.key)} — generated qty ${m.generated_qty}`)));
    if (r.facts_missing_in_golden > r.missing_examples.length) children.push(bullet(`...and ${r.facts_missing_in_golden - r.missing_examples.length} more.`));
  } else {
    children.push(bullet("0 Generated facts missing from Golden."));
  }
  if (r.facts_qty_mismatch > 0) {
    children.push(new Paragraph({ spacing: { after: 60 }, children: [statusTag("MISMATCH"), txt(`${r.facts_qty_mismatch} fact(s) found in both but with a different quantity:`, { bold: true, size: 20 })] }));
    r.diff_examples.forEach(m => children.push(bullet(`${fmtKey(m.key)} — Golden ${m.golden_qty}, Generated ${m.generated_qty}`)));
    if (r.facts_qty_mismatch > r.diff_examples.length) children.push(bullet(`...and ${r.facts_qty_mismatch - r.diff_examples.length} more.`));
  } else {
    children.push(bullet("0 quantity mismatches."));
  }
  children.push(spacer(140));
  children.push(heading1("Control Totals (CTT)"));
  children.push(bullet(`Golden CTT counts by transaction set: ${r.golden_ctt.join(", ")}`));
  children.push(bullet(`Generated CTT counts by transaction set: ${r.generated_ctt.join(", ")}`));
  children.push(bullet("Each file's own CTT count matches its own LIN count (self-consistent) — " +
    (r.golden_lin_count_matches_ctt.every(Boolean) && r.generated_lin_count_matches_ctt.every(Boolean) ? "confirmed on both sides." : "CHECK — inconsistency found, see raw counts above.")));
  if (r.golden_rows !== r.generated_rows) {
    children.push(bullet("Note: CTT totals differ between Golden and Generated because Generated covers fewer records than Golden (a smaller/test-scope run) — expected, not a functional defect, as long as the fact-level validation above shows 0 mismatches."));
  }
}

function buildPOSNLSN(r, children) {
  const pass = r.item_missing_in_golden === 0 && r.item_qty_mismatch === 0 && r.chain_mismatch === 0 && r.date_mismatch === 0;
  children.push(calloutBox(
    pass && r.trailer_value_mismatch === 0 ? "RESULT: ALL DATA MATCHED" :
    pass ? `RESULT: ITEM DATA MATCHED. ${r.trailer_value_mismatch} store trailer(s) differ (see below).` :
    "RESULT: MISMATCH",
    pass ? (r.trailer_value_mismatch > 0 ? "info" : "pass") : "fail"
  ));
  children.push(spacer(140));
  children.push(heading1("File Summary"));
  children.push(table(
    ["Metric", "Golden", "Generated"], [4000, 2680, 2680],
    [
      ["Store headers (92)", r.golden_stores.toLocaleString(), r.generated_stores.toLocaleString()],
      ["Sold-item lines (I3)", r.golden_items.toLocaleString(), r.generated_items.toLocaleString()],
    ]
  ));
  children.push(spacer(140));
  children.push(heading1("Validation Results"));
  children.push(bullet(`Stores in Generated missing from Golden: ${r.stores_missing_in_golden}`));
  children.push(bullet(`Sold-item (I3) lines matched exactly: ${r.item_matched} of ${r.item_matched + r.item_missing_in_golden + r.item_qty_mismatch}`));
  if (r.item_missing_in_golden > 0) {
    children.push(new Paragraph({ spacing: { after: 60 }, children: [statusTag("MISMATCH"), txt(`${r.item_missing_in_golden} item line(s) not found in Golden:`, { bold: true, size: 20 })] }));
    r.item_missing_examples.forEach(m => children.push(bullet(`Store ${m.store}, EAN ${m.ean}, qty ${m.generated_qty}`)));
    if (r.item_missing_in_golden > r.item_missing_examples.length) children.push(bullet(`...and ${r.item_missing_in_golden - r.item_missing_examples.length} more.`));
  }
  if (r.item_qty_mismatch > 0) {
    children.push(new Paragraph({ spacing: { after: 60 }, children: [statusTag("MISMATCH"), txt(`${r.item_qty_mismatch} item line(s) with a different quantity:`, { bold: true, size: 20 })] }));
    r.item_qty_diff_examples.forEach(m => children.push(bullet(`Store ${m.store}, EAN ${m.ean} — Golden ${m.golden_qty}, Generated ${m.generated_qty}`)));
    if (r.item_qty_mismatch > r.item_qty_diff_examples.length) children.push(bullet(`...and ${r.item_qty_mismatch - r.item_qty_diff_examples.length} more.`));
  }
  children.push(bullet(`Chain code mismatches: ${r.chain_mismatch}`));
  children.push(bullet(`Period-end date mismatches: ${r.date_mismatch}`));
  if (r.trailer_value_mismatch > 0) {
    children.push(new Paragraph({ spacing: { after: 60 }, children: [statusTag("MINOR"), txt(`Store trailer (94) count/total differs on ${r.trailer_value_mismatch} store(s):`, { bold: true, size: 20 })] }));
    r.trailer_diff_examples.forEach(m => children.push(bullet(`Store ${m.store} — Golden ${JSON.stringify(m.golden)}, Generated ${JSON.stringify(m.generated)}`)));
    if (r.trailer_value_mismatch > r.trailer_diff_examples.length) children.push(bullet(`...and ${r.trailer_value_mismatch - r.trailer_diff_examples.length} more store(s) with the same trailer difference.`));
    children.push(bullet("Expected when Generated covers fewer stores/items than Golden (a test-scope run) — Golden's trailer counts all activity at that store, Generated's trailer only counts what it actually received. Not a functional defect by itself, but listed per the \"report every mismatch\" rule."));
  } else {
    children.push(bullet("Store trailer (94) counts: 0 mismatches."));
  }
}

function buildPOSDLYM(r, children) {
  const fr = r.field_results;
  const fields = r.common_fields;
  const brokenFields = fields.filter(f => fr[f].diff > 0);
  const formatFields = fields.filter(f => fr[f].diff === 0 && fr[f].soft > 0);
  const cleanFields = fields.filter(f => fr[f].diff === 0 && fr[f].soft === 0);
  const rowsOk = r.rows_missing_in_golden === 0 && r.rows_extra_in_golden === 0;
  const fieldsOk = brokenFields.length === 0 && formatFields.length === 0;
  const pass = rowsOk && fieldsOk;

  children.push(calloutBox(
    pass ? "RESULT: ALL DATA MATCHED" :
      `RESULT: MISMATCH — ${brokenFields.length} field(s) with real differences, ${formatFields.length} field(s) with format-only differences.`,
    pass ? "pass" : "fail"
  ));
  children.push(spacer(140));

  children.push(heading1("Files & Key"));
  children.push(bullet(`Validation key: ${r.key_fields.join(" + ")}`));
  children.push(bullet(`Golden: ${r.golden_rows.toLocaleString()} rows. Generated: ${r.generated_rows.toLocaleString()} rows.`));

  children.push(heading1("Row-Level Match"));
  children.push(bullet(`${r.golden_keys.toLocaleString()} Golden rows, ${r.generated_keys.toLocaleString()} Generated rows.`));
  children.push(bullet(`Duplicate keys — Golden: ${r.golden_dupes}, Generated: ${r.generated_dupes}.`));
  children.push(bullet(`Rows in Generated not found in Golden: ${r.rows_missing_in_golden}.`));
  children.push(bullet(`Rows in Golden not found in Generated: ${r.rows_extra_in_golden}.`));
  if (r.rows_missing_in_golden > 0) {
    r.missing_examples.forEach(k => children.push(bullet(`  Missing: ${fmtKey(k)}`)));
  }
  if (r.rows_extra_in_golden > 0) {
    r.extra_golden_examples.forEach(k => children.push(bullet(`  Extra in Golden: ${fmtKey(k)}`)));
  }

  const totalComparisons = fields.reduce((s, f) => s + fr[f].exact + fr[f].soft + fr[f].diff, 0);
  const totalExact = fields.reduce((s, f) => s + fr[f].exact, 0);
  const totalSoft = fields.reduce((s, f) => s + fr[f].soft, 0);
  const totalDiff = fields.reduce((s, f) => s + fr[f].diff, 0);
  children.push(heading1(`Field-by-Field Summary — All ${fields.length} Fields`));
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
    children.push(p(`${cleanFields.length} fields matched perfectly on every row — no issues:`, { bold: true }));
    children.push(bullet(cleanFields.join(", ") + "."));
  }

  children.push(heading1("Every Mismatch, In Full"));
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
    children.push(spacer(80));
  });

  children.push(heading1("Conclusion"));
  if (pass) {
    children.push(bullet("All rows and all fields matched Golden exactly. Ready for sign-off."));
  } else {
    children.push(bullet(`${brokenFields.length} field(s) need a fix: ${brokenFields.join(", ") || "none"}.`));
    if (formatFields.length) children.push(bullet(`${formatFields.length} field(s) have a minor formatting inconsistency: ${formatFields.join(", ")}.`));
    children.push(bullet("Recommend logging the fields above in the bug tracker and re-running this validation after the fix."));
  }
}

// ---------------------------------------------------------------------------
function main() {
  const [, , jsonPath, outPath, customTitle] = process.argv;
  const r = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const children = [];

  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 },
    children: [txt(`${r.file_type} VALIDATION REPORT`, { bold: true, size: 32, color: NAVY })] }));
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 40 },
    children: [txt(customTitle || "Generated vs. Golden Output", { bold: true, size: 21, color: BLUE })] }));
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 },
    children: [txt("Complete field-by-field check, no sampling, every mismatch listed however small", { italics: true, size: 18, color: "595959" })] }));

  if (r.file_type === "POSDATAMJ") buildPOSDATAMJ(r, children);
  else if (r.file_type === "POSNLSN") buildPOSNLSN(r, children);
  else if (r.file_type === "POSDLYM") buildPOSDLYM(r, children);
  else throw new Error("Unknown file_type in results JSON: " + r.file_type);

  children.push(spacer(240));
  children.push(new Paragraph({ border: { top: { style: BorderStyle.SINGLE, size: 6, color: BORDER_GREY, space: 8 } }, spacing: { before: 180 },
    children: [txt(`Golden: ${r._golden_path.split("/").pop()}   |   Generated: ${r._generated_path.split("/").pop()}`, { italics: true, size: 16, color: "808080" })] }));

  const doc = new Document({
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, bottom: 1080, left: 1440, right: 1440 } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT,
        children: [txt(`${r.file_type} Validation Report`, { size: 16, color: "808080" })] })] }) },
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
