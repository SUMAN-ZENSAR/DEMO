#!/usr/bin/env python3
"""
ReaderLink Log Parser
======================
Parses ReaderLink.Console telemetry log output into a structured per-run
summary: phase timings, identity waterfall breakdown, reject/capture
summary, daily-accumulate details, performance ranking, and a final run
summary — the same shape as the manual tabulation this was built to
automate.

Pure regex/string parsing. No API calls, no external services.
"""
import re
import sys
import json
import argparse

PHASE_ENTERED_RE = re.compile(
    r"\[(?P<phase>\w+)\]\s+PhaseEntered\s+run=(?P<run>\d+)\s+file=(?P<file>\S+)\s+chain=(?P<chain>\S+)\s+Elapsed=\+(?P<elapsed>[\d.]+)s"
)
PHASE_COMPLETED_RE = re.compile(
    r"\[(?P<phase>\w+)\]\s+PhaseCompleted\s+run=(?P<run>\d+)\s+file=(?P<file>\S+)\s+chain=(?P<chain>\S+)\s+Elapsed=\+(?P<elapsed>[\d.]+)s\s+(?P<rest>.+)"
)
ENGINE_OUTCOME_RE = re.compile(
    r"\[(?P<phase>\w+)\]\s+EngineOutcome\s+run=(?P<run>\d+)\s+file=(?P<file>\S+)\s+chain=(?P<chain>\S+)\s+Engine=(?P<engine>\S+)\s+Elapsed=\+(?P<elapsed>[\d.]+)s\s+(?P<rest>.+)"
)
IDENTITY_WATERFALL_RE = re.compile(
    r"\[A4IdentityWaterfall\]\s+IdentityWaterfall\s+run=(?P<run>\d+)\s+file=(?P<file>\S+)\s+chain=(?P<chain>\S+)\s+(?P<rest>.+)"
)
ITEM_STORE_EXIST_RE = re.compile(
    r"\[C2DailyAccumulate\]\s+ItemStoreExistenceFailures\s+run=(?P<run>\d+).*?"
    r"ItemStoreExistenceFailures=(?P<failures>\d+)\s+TotalRows=(?P<total>\d+)\s+Decision=(?P<decision>.+)"
)
REJECT_LINE_RE = re.compile(
    r"\[CAPTURE\]\s+reject\s+run=(?P<run>\d+)\s+chain=(?P<chain>\S+)\s+store=(?P<store>\S+)\s+item=(?P<item>\S+)\s+"
    r"upc=(?P<upc>\S+)\s+qtyType=(?P<qtytype>\S+)\s+qty=(?P<qty>-?\d+)\s+cause=(?P<cause>\S+)\s+(?P<desc>.+?)\s*->\s*pos\.POSERRM"
)
CAUSE_TALLY_RE = re.compile(
    r"\[CAPTURE\]\s+cause=(?P<cause>\S+):\s+(?P<count>\d+)\s+reject\(s\)\s+so far this run"
)
FLUSH_RE = re.compile(
    r"\[CAPTURE\]\s+flushed\s+\d+\s+pos\.POSERRM\s+reject row\(s\)\s+\(Seq through (?P<through>\d+)\)"
)
SQL_RESULT_RE = re.compile(
    r"\[SQL\]\s+(?P<script>\S+\.sql)\s+(?P<ms>\d+)ms\s+on=(?P<txn>\S+)\s+result=(?P<result>.+)"
)
STRUCT_RESULT_RE = re.compile(r"(\w+)\s*\{\s*(.+?)\s*\}")
KV_RE = re.compile(r"(\w+)\s*=\s*(-?[\d,]+(?:\.\d+)?)")
RUN_COMPLETED_RE = re.compile(
    r"\[EEpilogue\]\s+RunCompleted\s+run=(?P<run>\d+)\s+file=(?P<file>\S+)\s+chain=(?P<chain>\S+)\s+(?P<rest>.+)"
)

PHASE_LABELS = {
    "A0Guard": "A0 Guard",
    "A1Stage": "A1 Stage",
    "A2ClearCaptures": "A2 Clear Captures",
    "A3ParseClassify": "A3 Parse & Classify",
    "A4IdentityWaterfall": "A4 Identity Waterfall",
    "A5PostDetail": "A5 Post Detail",
    "A6StoreFlip": "A6 Store Flip",
    "C1BookScanExtract": "C1 BookScan Extract",
    "C2DailyAccumulate": "C2 Daily Accumulate",
    "C3WeekCheck": "C3 Week Check",
    "D1WeekRebuild": "D1 Week Rebuild",
    "D2WeeklyEditSelect": "D2 Weekly Edit & Select",
    "D3HistoryWrite": "D3 History Write",
    "D4HistoryCompanions": "D4 History Companions",
    "EEpilogue": "EEpilogue",
}


def parse_kv_rest(rest):
    """Parse a trailing 'Key=Value Key2=Value2 ...' string into a dict,
    numeric where possible."""
    out = {}
    for m in KV_RE.finditer(rest):
        k, v = m.group(1), m.group(2).replace(",", "")
        try:
            out[k] = int(v)
        except ValueError:
            try:
                out[k] = float(v)
            except ValueError:
                out[k] = v
    return out


def parse_struct_result(text):
    """Parse 'SomeName { Key = 1, Key2 = 2 }' into (name, {key: val})."""
    m = STRUCT_RESULT_RE.search(text)
    if not m:
        return text.strip(), {}
    name, body = m.group(1), m.group(2)
    out = {}
    for part in body.split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            k, v = k.strip(), v.strip()
            try:
                out[k] = int(v)
            except ValueError:
                try:
                    out[k] = float(v)
                except ValueError:
                    out[k] = v
    return name, out


def parse_log(text):
    lines = text.splitlines()

    phases = {}  # phase_key -> {entered, completed, telemetry_at_completion, engine_outcomes: []}
    phase_order = []
    run_id = file_id = chain = None
    identity_waterfall = {}
    item_store_existence = {}
    sql_results = {}  # script name -> parsed struct dict
    reject_examples = {}  # cause -> list of example dicts (max 5)
    reject_cause_running_max = {}  # cause -> max "so far this run" count seen
    reject_line_count_by_cause = {}
    max_poserrm_seq = 0
    run_completed = None

    for raw in lines:
        line = raw.rstrip("\n")

        m = PHASE_ENTERED_RE.search(line)
        if m:
            phase = m.group("phase")
            run_id = run_id or m.group("run")
            file_id = file_id or m.group("file")
            chain = chain or m.group("chain")
            if phase not in phases:
                phases[phase] = {"entered": None, "completed": None, "telemetry": {}, "engine_outcomes": []}
                phase_order.append(phase)
            phases[phase]["entered"] = float(m.group("elapsed"))
            continue

        m = PHASE_COMPLETED_RE.search(line)
        if m:
            phase = m.group("phase")
            if phase not in phases:
                phases[phase] = {"entered": None, "completed": None, "telemetry": {}, "engine_outcomes": []}
                phase_order.append(phase)
            phases[phase]["completed"] = float(m.group("elapsed"))
            phases[phase]["telemetry"] = parse_kv_rest(m.group("rest"))
            continue

        m = ENGINE_OUTCOME_RE.search(line)
        if m:
            phase = m.group("phase")
            if phase not in phases:
                phases[phase] = {"entered": None, "completed": None, "telemetry": {}, "engine_outcomes": []}
                phase_order.append(phase)
            phases[phase]["engine_outcomes"].append({
                "engine": m.group("engine"),
                "elapsed": float(m.group("elapsed")),
                **parse_kv_rest(m.group("rest")),
            })
            continue

        m = IDENTITY_WATERFALL_RE.search(line)
        if m:
            identity_waterfall = parse_kv_rest(m.group("rest"))
            continue

        m = ITEM_STORE_EXIST_RE.search(line)
        if m:
            item_store_existence = {
                "ItemStoreExistenceFailures": int(m.group("failures")),
                "TotalRows": int(m.group("total")),
                "Decision": m.group("decision").strip(),
            }
            continue

        m = SQL_RESULT_RE.search(line)
        if m:
            script = m.group("script")
            name, fields = parse_struct_result(m.group("result"))
            if fields:
                sql_results[script] = {"name": name, "ms": int(m.group("ms")), **fields}
            else:
                sql_results[script] = {"name": name, "ms": int(m.group("ms")), "result": name}
            continue

        m = REJECT_LINE_RE.search(line)
        if m:
            cause = m.group("cause")
            reject_line_count_by_cause[cause] = reject_line_count_by_cause.get(cause, 0) + 1
            reject_examples.setdefault(cause, [])
            if len(reject_examples[cause]) < 5:
                reject_examples[cause].append({
                    "store": m.group("store"), "upc": m.group("upc"),
                    "qtyType": m.group("qtytype"), "qty": int(m.group("qty")),
                    "desc": m.group("desc").strip(),
                })
            continue

        m = CAUSE_TALLY_RE.search(line)
        if m:
            cause, count = m.group("cause"), int(m.group("count"))
            reject_cause_running_max[cause] = max(reject_cause_running_max.get(cause, 0), count)
            continue

        m = FLUSH_RE.search(line)
        if m:
            max_poserrm_seq = max(max_poserrm_seq, int(m.group("through")))
            continue

        m = RUN_COMPLETED_RE.search(line)
        if m:
            run_id = m.group("run")
            file_id = m.group("file")
            chain = m.group("chain")
            run_completed = parse_kv_rest(m.group("rest"))
            continue

    # ---- build phase timing table ----
    phase_rows = []
    prev_end = 0.0
    for phase in phase_order:
        p = phases[phase]
        start = p["entered"] if p["entered"] is not None else prev_end
        end = p["completed"] if p["completed"] is not None else start
        duration = round(end - start, 2)
        key_metrics = []
        for eo in p["engine_outcomes"]:
            bits = [f"{k}={v:,}" if isinstance(v, int) else f"{k}={v}" for k, v in eo.items() if k not in ("engine", "elapsed")]
            key_metrics.append(f"{eo['engine']}: " + ", ".join(bits))
        phase_rows.append({
            "phase": phase,
            "label": PHASE_LABELS.get(phase, phase),
            "start": round(start, 2), "end": round(end, 2), "duration": duration,
            "telemetry": p["telemetry"],
            "engine_outcomes": p["engine_outcomes"],
            "key_metrics": key_metrics,
        })
        prev_end = end

    total_runtime = phase_rows[-1]["end"] if phase_rows else 0.0

    performance_ranking = sorted(
        [{"phase": r["label"], "duration": r["duration"]} for r in phase_rows],
        key=lambda x: -x["duration"]
    )

    reject_summary = []
    all_causes = set(reject_cause_running_max) | set(reject_line_count_by_cause)
    for cause in all_causes:
        reject_summary.append({
            "cause": cause,
            "count": reject_cause_running_max.get(cause, reject_line_count_by_cause.get(cause, 0)),
            "examples": reject_examples.get(cause, []),
        })
    reject_summary.sort(key=lambda x: -x["count"])
    total_poserrm = max_poserrm_seq or sum(r["count"] for r in reject_summary)

    daily_accumulate = {}
    for script, data in sql_results.items():
        if "Validate" in script:
            daily_accumulate["validate"] = data
        elif "Merge" in script:
            daily_accumulate["merge"] = data
        elif "holdm_park" in script:
            daily_accumulate["park"] = data

    final_summary = run_completed or {}
    facts = None
    for r in phase_rows:
        for eo in r["engine_outcomes"]:
            if "Facts" in eo:
                facts = eo["Facts"]

    result = {
        "run_id": run_id, "file_id": file_id, "chain": chain,
        "total_runtime": total_runtime,
        "phases": phase_rows,
        "performance_ranking": performance_ranking,
        "identity_waterfall": identity_waterfall,
        "facts": facts,
        "item_store_existence": item_store_existence,
        "daily_accumulate": daily_accumulate,
        "reject_summary": reject_summary,
        "total_poserrm_rows": total_poserrm,
        "final_summary": final_summary,
        "bottleneck": performance_ranking[0] if performance_ranking else None,
    }
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logfile")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    with open(args.logfile, "r", errors="replace") as f:
        text = f.read()
    result = parse_log(text)
    out = json.dumps(result, indent=2, default=str)
    if args.out:
        with open(args.out, "w") as f:
            f.write(out)
        print(f"Parsed run {result['run_id']}. Written to {args.out}")
    else:
        print(out)


if __name__ == "__main__":
    main()
