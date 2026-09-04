#!/usr/bin/env python3
"""
POS Validation Server
=======================
Local backend for pos_console.html. Solves the large-file problem: instead
of parsing xlsx in the browser (slow/crashy above ~100k rows), the browser
uploads the two files here, and this server runs the same proven
pos_validator.py engine (streaming, tested to 500k+ rows) and returns JSON.
Word report generation shells out to the existing build_report.js /
build_weekly_report.js (Node + docx library) for full-fidelity .docx output.

Run:
    pip install flask
    python server.py
Then open http://localhost:5000 in a browser.

No external API calls. Everything here is local: file I/O, the existing
validator functions, and local subprocess calls to node for the docx step.
"""
import os
import json
import shutil
import tempfile
import subprocess
import uuid
from pathlib import Path

from flask import Flask, request, jsonify, send_file, send_from_directory

import pos_validator
import log_parser
import poserrm_analyzer

BASE_DIR = Path(__file__).resolve().parent
RUN_HISTORY_PATH = BASE_DIR / "run_history.json"
UPLOAD_TMP = Path(tempfile.gettempdir()) / "pos_validation_uploads"
UPLOAD_TMP.mkdir(exist_ok=True)

app = Flask(__name__, static_folder=None)


# ---------------------------------------------------------------------------
# static UI
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "pos_console.html")


# ---------------------------------------------------------------------------
# validation
# ---------------------------------------------------------------------------
@app.route("/api/validate", methods=["POST"])
def api_validate():
    golden = request.files.get("golden")
    generated = request.files.get("generated")
    file_type = request.form.get("fileType") or None
    key = request.form.get("key") or None
    exclude = request.form.get("exclude")  # may legitimately be "" to mean "exclude nothing"

    if not golden or not generated:
        return jsonify({"error": "Both golden and generated files are required."}), 400

    run_dir = UPLOAD_TMP / str(uuid.uuid4())
    run_dir.mkdir(parents=True, exist_ok=True)
    golden_path = run_dir / golden.filename
    generated_path = run_dir / generated.filename
    try:
        golden.save(golden_path)
        generated.save(generated_path)
        ftype, result = pos_validator.run_validation(
            str(golden_path), str(generated_path),
            file_type=file_type, key=key, exclude=exclude,
        )
        result["_golden_path"] = golden.filename
        result["_generated_path"] = generated.filename
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# word report generation (shells out to the existing, tested Node scripts)
# ---------------------------------------------------------------------------
@app.route("/api/report", methods=["POST"])
def api_report():
    body = request.get_json(force=True)
    kind = body.get("kind")  # 'single' | 'combined' | 'weekly'
    title = body.get("title", "")

    run_dir = UPLOAD_TMP / str(uuid.uuid4())
    run_dir.mkdir(parents=True, exist_ok=True)
    try:
        out_docx = run_dir / "report.docx"
        if kind == "weekly":
            summ_path = run_dir / "possumm.json"
            dtlm_path = run_dir / "posdtlm.json"
            summ_path.write_text(json.dumps(body["possumm"]))
            dtlm_path.write_text(json.dumps(body["posdtlm"]))
            cmd = ["node", str(BASE_DIR / "build_weekly_report.js"), str(summ_path), str(dtlm_path), str(out_docx), title]
        elif kind == "combined":
            # any 2+ results (e.g. daily: POSDATAMJ + POSNLSN + POSDLYM) — build_report.js
            # accepts N json paths followed by the output path and title.
            results = body.get("results", [])
            if len(results) < 1:
                return jsonify({"error": "combined report needs at least 1 result"}), 400
            json_paths = []
            for i, r in enumerate(results):
                p = run_dir / f"result{i}.json"
                p.write_text(json.dumps(r))
                json_paths.append(str(p))
            cmd = ["node", str(BASE_DIR / "build_report.js"), *json_paths, str(out_docx), title]
        elif kind == "poserrm":
            result_path = run_dir / "poserrm.json"
            result_path.write_text(json.dumps(body["result"]))
            cmd = ["node", str(BASE_DIR / "build_poserrm_report.js"), str(result_path), str(out_docx), title]
        else:  # single
            result_path = run_dir / "result.json"
            result_path.write_text(json.dumps(body["result"]))
            cmd = ["node", str(BASE_DIR / "build_report.js"), str(result_path), str(out_docx), title]

        proc = subprocess.run(cmd, capture_output=True, text=True, cwd=str(BASE_DIR))
        if proc.returncode != 0:
            return jsonify({"error": "Report generation failed", "stderr": proc.stderr}), 500

        return send_file(out_docx, as_attachment=True, download_name=(body.get("filename") or "report.docx"))
    finally:
        try:
            shutil.rmtree(run_dir, ignore_errors=True)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# run-log parsing + persistent run history
# ---------------------------------------------------------------------------
def load_history():
    if RUN_HISTORY_PATH.exists():
        try:
            return json.loads(RUN_HISTORY_PATH.read_text())
        except Exception:
            return []
    return []


def save_history(history):
    RUN_HISTORY_PATH.write_text(json.dumps(history, indent=2, default=str))


@app.route("/api/log/parse", methods=["POST"])
def api_log_parse():
    f = request.files.get("log")
    if not f:
        return jsonify({"error": "No log file uploaded."}), 400
    text = f.read().decode("utf-8", errors="replace")
    try:
        result = log_parser.parse_log(text)
    except Exception as e:
        return jsonify({"error": f"Could not parse log: {e}"}), 500

    if not result.get("run_id"):
        return jsonify({"error": "Could not find a run ID in this log — is it a ReaderLink.Console telemetry log?"}), 400

    result["_source_filename"] = f.filename
    result["_parsed_at"] = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()

    history = load_history()
    history = [h for h in history if h.get("run_id") != result["run_id"]]  # upsert
    history.append(result)
    history.sort(key=lambda h: int(h["run_id"]) if str(h.get("run_id", "")).isdigit() else 0)
    save_history(history)

    return jsonify(result)


@app.route("/api/log/history", methods=["GET"])
def api_log_history():
    return jsonify(load_history())


@app.route("/api/log/history/<run_id>", methods=["DELETE"])
def api_log_history_delete(run_id):
    history = load_history()
    history = [h for h in history if str(h.get("run_id")) != str(run_id)]
    save_history(history)
    return jsonify({"deleted": run_id})


@app.route("/api/poserrm/analyze", methods=["POST"])
def api_poserrm_analyze():
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "No POSERRM file uploaded."}), 400

    run_dir = UPLOAD_TMP / str(uuid.uuid4())
    run_dir.mkdir(parents=True, exist_ok=True)
    try:
        saved_path = run_dir / (f.filename or "poserrm.xlsx")
        f.save(str(saved_path))
        try:
            result = poserrm_analyzer.analyze_poserrm(str(saved_path))
        except Exception as e:
            return jsonify({"error": f"Could not analyze POSERRM file: {e}"}), 500
        result["_source_filename"] = f.filename
        return jsonify(result)
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)


if __name__ == "__main__":
    print("POS Validation Server")
    print("Open http://localhost:5000 in your browser.")
    app.run(host="0.0.0.0", port=5000, debug=False)
