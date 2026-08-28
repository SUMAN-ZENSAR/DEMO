# POS Pipeline Validation — Project Knowledge

This document is the reference Claude uses every time a Golden/Generated file pair
is uploaded for validation. It covers the pipeline context, the exact layout of
each of the three output types, the validation key for each, and the rules for
building the report. Nothing in here requires an API key, external service, or
agent — every comparison is a plain local field/value check.

---

## 1. Pipeline Context (from MEIJER_PIPELINE_PROCESS_FLOW.pdf)

Orchestrator: `PosPipelineOrchestrator`. Every transmission runs phases
A0→A6→C1→C2→C3→E. Only the 7th transmission of a POS week additionally runs
D1→D4 (weekly close), in the same run.

Phases relevant to validation:
- **A1 — Stage**: writes the inbound 512-byte EDI records into `pos.POSDATAMJ`, one row per record. This is the **POSDATAMJ** file.
- **A3 — Parse & classify**: turns POSDATAMJ rows into a typed segment stream, flattens every non-blank SDQ store/quantity slot into a "fact." Derives week-ending Saturday and POS activity date (header date minus one day for Meijer).
- **A4 — Identity waterfall**: resolves each fact's barcode to an item (UPCSALM → UPCSALH → WHSSCNM/SMPITSM fallback). Unresolved → `ERRCOD '01' UPC NOT FOUND`, captured in `pos.POSERRM`, but the transmission continues.
- **A5 — Post detail**: posts resolved facts into `pos.POSDTL`, one row per (agency, chain, store, item, activity-date). On-hand and sold are separate columns — a zero on-hand is posted, a zero sale is discarded.
- **C1 — BookScan extract**: renders **POSNLSN**, grouped by store: `92` header, `I3` item lines, `94` trailer. An `I3` line is emitted **only for a strictly positive sold quantity** — this is why POSNLSN typically has far fewer item lines than POSDATAMJ has QA (on-hand) records.
- **C2 — Daily accumulate**: writes **POSDLYM** at (agency, chain, store, week-ending, item, activity-code, activity-date) grain. Three insert buckets: QS / QA / QR. `P0NOID` is drawn from `pos.POSDLYSEQN`, once per inserted row.
- **E — Epilogue**: closes the run, writes the debug telemetry line (`Parsed`, `PostedDetail`, `AccumulatedDaily`, `UnmatchedItems`, `ReversedMatches`, `HeldRows`, `ToleratedNumericWarnings`).

Telemetry cross-check, when a debug log is supplied alongside the files:
| Counter | Should equal |
|---|---|
| Parsed | Total POSDATAMJ records staged (A1) |
| PostedDetail | Total non-blank SDQ facts (A5) |
| AccumulatedDaily | Total POSDLYM rows written (C2) |
| UnmatchedItems | Count of ERRCOD '01' rejects (A4) — should be 0 if all tested items resolve |
| HeldRows | Rows parked in `pos.POSHOLDM` on a duplicate activity-date key (C2) |

---

## 2. File Format Specs

### 2.1 POSDATAMJ (EDI 852 — landing/staging file)

Raw format: one 512-byte fixed-width text line per record. Golden is usually
supplied as a single-column raw-text export (one cell per line). Generated is
sometimes exported as a 4-column table: `FileId, Seq, RunId, POSDATA` — the
validator reads the `POSDATA` column in that case and treats it identically to
the raw single-column form.

Segment types (first 3 chars are always `852`, next 3 identify the segment):

| Segment | Byte layout | Meaning |
|---|---|---|
| `852000` (header) | `[49:58]`=sender, `[106:116]`=receiver-ish/version, `[141:151]`=date/time, `[155:164]`=receiver | Interchange header, one per transaction set |
| `XQ` | `[6:7]`=qualifier, `[7:13]`=date | Transaction-set activity date |
| `LIN` | `[12:14]`=item qualifier (`EN`=ISBN, `UP`=UPC), `[14:]`=item identifier | Starts a new item |
| `ZA` | `[6:8]`=activity qualifier (`QA`=on-hand, `QS`=sold), `[8:18]`=amount/price (usually all zeros — this feed carries no price), `[20:23]`=date qualifier, `[23:29]`=activity date (only present on `QS`) | Activity type for the preceding LIN |
| `SDQ` | `[6:8]`=UOM, `[8:10]`=location qualifier, then **10 fixed 27-char slots**: each slot = 17-char store (left-justified, blank if unused) + 10-char quantity (zero-padded, leading `-` for negative) | Store/quantity detail. A line always has all 10 slots present; unused slots are store=blank, qty=`0000000000`. Only non-blank-store slots are "facts." |
| `CTT` | `[6:12]`=count | Count of LIN segments in this transaction set — must equal the actual LIN count in that set, for both Golden and Generated independently |

**Validation approach**: build a fact dictionary keyed
`(item, store, ZA qualifier, ZA date) → quantity` from both files. Golden is
usually a superset (a full production run); Generated is usually a smaller
test-scope run. Validate that **every Generated fact exists in Golden with the
same quantity** — do not expect Generated to cover every Golden fact. CTT
counts will differ between the two files when Generated is a subset; that is
expected as long as each file's own CTT matches its own LIN count.

### 2.2 POSNLSN (Nielsen / BookScan extract)

Golden is fixed-width raw text (one record per line, no header row other than
a stray `POSNLSN` label in row 1, which the loader discards). Generated is
sometimes already split into columns: `RunId, Seq, RecordType, Chain, Store,
PerEndDate, EANnumber, QtySold, NbrRecords, TotQtySold`.

Three record types:

| Type | Length | Layout |
|---|---|---|
| `92` (store header) | 18 ch | `92` + chain(5) + store(5) + period-end date(6) |
| `I3` (item line) | 20 ch | `I3` + EAN(13) + qty sold(5) |
| `94` (store trailer) | 14 ch | `94` + nbr records(5) + total qty sold(7) |

> Note: the segment marker is the two characters **`I3`** (capital I, digit 3),
> not the number "13" — confirmed from raw byte inspection of actual files.

**Validation approach**: group into per-store records (header + item lines +
trailer). For every Generated store, check it exists in Golden, then check
every `I3` line's EAN+qty matches Golden exactly. Also check chain code and
period-end date per store. **Trailer (`94`) count/total will differ per store
whenever Generated covers fewer items than Golden** (test-scope subset) — this
is expected, not a functional defect, but must still be listed in the report
as a minor/explained mismatch, never silently dropped.

### 2.3 POSDLYM (daily accumulation — tabular)

32 columns (Golden) / 33 columns (Generated, one extra `RunId` column):

```
P0AGY P0CHN P0STR P0WEDT P0ISBN P0SKU P0UPC P0EAN P0QTY P0ACOD P0ADAT P0DAAD
P0UOM P0FLAG P0DISP P0RPRC P0RSP P0CPRC P0EXTF P0MAGY P0MCHN P0SFL1 P0SFL2
P0POOC P0VEN# P0PVEN P0RWDT P0GRNO P0QQSI P0QOH P0QOHI P0NOID [RunId]
```

**Validation key: `P0STR + P0ISBN + P0ACOD`** (store + item + activity code).
This is the standard key going forward — use it exactly, do not substitute
P0EAN/P0UPC resolution unless the key fields are missing from a given export.

Known field notes:
- `P0ADAT` = POS activity date. `P0DAAD` = processing date (these are two
  different dates — a past defect had `P0DAAD` incorrectly holding the same
  value as `P0ADAT`).
- `P0RPRC`/`P0RSP`/`P0CPRC` = retail price / retail selling price / cost
  price, sourced from item/vendor master enrichment (not present in POSDATAMJ,
  so POSDATAMJ can never be used as Golden for these three fields).
- `P0VEN#`/`P0PVEN` = vendor number / primary vendor, also master-enrichment
  fields.
- `P0NOID` is a sequence number from `pos.POSDLYSEQN` — expect it to differ
  between environments/runs. **`P0NOID` and `RunId` are excluded from the
  field-by-field comparison entirely** (see `DEFAULT_EXCLUDE_FIELDS` in
  `pos_validator.py`) — they are environment/run identifiers, not a
  data-correctness signal, so they generate no mismatch rows in the report.
  If a future request needs them back in scope, pass `--exclude ""` (empty)
  or a smaller exclude list to `pos_validator.py`.

**Validation approach**: exact field-by-field comparison for every row matched
on the key. Three-way classification per field per row:
1. **Exact** — identical string after trimming.
2. **Soft / format-only** — different string but numerically equal (e.g.
   Golden `'01'` vs Generated `'1'`, or `'0'` vs `'0.00'`). Report separately
   from real mismatches — same value, just formatted differently.
3. **Real mismatch** — values actually differ.

---

## 3. Comparison Rules (apply to all three file types)

- **No sampling.** Read every row on both sides. Use streaming/read-only
  workbook access so this stays fast at 80k+ rows / ~100MB per file.
- **No API keys, no external services, no agentic/LLM-based matching.**
  Every comparison is a deterministic Python value/format check
  (`pos_validator.py`). If a person asks for "smarter" or "fuzzy" matching,
  push back — exact/format/real-diff is the only classification used.
- **Golden-is-superset is normal.** Generated is very often a smaller
  test-scope run. Missing-in-Generated (i.e. Golden has more) is not a defect
  by itself. Missing-in-Golden (i.e. Generated has a fact/row Golden doesn't)
  **is** always worth flagging.
- **Report every mismatch, however small**, including format-only
  differences and structural/environment notes — never silently drop them
  because they seem "expected." State the explanation, but still list it.
- **At production scale**, do not dump every mismatched row into the report.
  Show up to 5 example rows per mismatch category, then state
  `...and N more rows with the same issue.` Full counts always appear in the
  summary table regardless of how many examples are shown.
- **Never editorialize away a real value difference as "cosmetic"** unless it
  is genuinely numerically equal (the "soft match" rule above) — leading
  zero drop and trailing-decimal padding qualify; a value that is actually
  different (like the 60%-flat-rate P0RSP bug found previously) does not.

---

## 4. Report Format (Word document)

Structure, every time, regardless of file type:
1. Title + one-line overall result callout (colored: green=pass, red=fail,
   yellow=pass-with-minor-notes).
2. Files & method (what was compared, what key was used).
3. Row-level / fact-level match counts (missing, extra, duplicates).
4. Field-by-field (or segment-by-segment) summary table: exact / format-only /
   real-mismatch counts.
5. Every mismatch, in full — one block per broken field/segment, tagged
   `[MISMATCH]`, `[MINOR]`, or `[STRUCTURAL]`, with example rows and an
   overflow count.
6. Conclusion — plain bullet points, what needs fixing, recommendation to log
   in the bug tracker and re-test.

Style: bullet points, not paragraphs. Tables only for genuinely tabular data.
Simple, plain language — this gets read by non-technical stakeholders too.

---

## 5. Scale Notes

- `pos_validator.py` uses `openpyxl(read_only=True, data_only=True)` and
  streams rows — tested at 85,510 rows / 2.4MB comfortably (~6 seconds). A
  100MB / 80k+ row file should complete in low single-digit minutes; there is
  no reason to pre-emptively split files unless a single file exceeds
  available memory (unlikely below a few hundred MB for this row width).
- If a file is genuinely too large to upload in one piece, it can be split
  into ordered chunks (row-preserving splits only, no reordering) and
  concatenated before parsing — confirm the chunks reconstruct the original
  byte-for-byte before trusting them as Golden.
