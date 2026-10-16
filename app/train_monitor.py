"""Tableau de bord temps réel de l'entraînement YOLO (lit logs/train_yolo.log et runs/detect/<dernier>/results.csv).

    .venv/bin/python app/train_monitor.py          -> http://localhost:8050
"""
import csv
import json
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psutil

ROOT = Path(__file__).resolve().parents[1]
LOG = ROOT / "logs" / "train_yolo.log"
PID = ROOT / "logs" / "train_yolo.pid"
PAGE = Path(__file__).resolve().parent / "static" / "train_monitor.html"
# ex. "  2/100      9.73G      1.009      2.903      1.183         46        640: 88% ━━╸─ 651/737 1.1it/s 9:59<1:17"
BATCH_RE = re.compile(r"^\s*(\d+)/(\d+)\s+([\d.]+G)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+\d+\s+\d+:\s+(\d+)%.*?"
                      r"(\d+)/(\d+)\s+([\d.]+)(it/s|s/it)\s+([\d:]+)<([\d:]+)")


def to_s(t):
    s = 0
    for p in t.split(":"):
        s = s * 60 + int(p)
    return s


def status():
    run_dirs = sorted((ROOT / "runs" / "detect").glob("2*/"))
    run = run_dirs[-1] if run_dirs else None
    rows = []
    if run and (run / "results.csv").exists():
        with open(run / "results.csv") as f:
            rows = [{k.strip(): float(v) for k, v in r.items()} for r in csv.DictReader(f)]
    tail = ""
    if LOG.exists():
        with open(LOG, "rb") as f:
            f.seek(max(0, LOG.stat().st_size - 20000))
            tail = f.read().decode(errors="replace")
    clean = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", tail)
    segments = [s for s in re.split(r"[\r\n]", clean) if s.strip()]
    cur = None
    for s in reversed(segments):
        m = BATCH_RE.match(s)
        if m:
            g = m.groups()
            speed = float(g[9]) if g[10] == "it/s" else 1 / float(g[9])
            cur = {"epoch": int(g[0]), "epochs": int(g[1]), "gpu_mem": g[2], "box_loss": float(g[3]),
                   "cls_loss": float(g[4]), "dfl_loss": float(g[5]), "batch": int(g[7]), "batches": int(g[8]),
                   "it_s": round(speed, 2), "elapsed_s": to_s(g[11]), "eta_epoch_s": to_s(g[12])}
            break
    last = segments[-1] if segments else ""
    phase = "entraînement" if BATCH_RE.match(last) else \
        "validation" if any("mAP50" in s for s in segments[-3:]) else "préparation"
    alive = False
    if PID.exists():
        try:
            alive = psutil.pid_exists(int(PID.read_text().strip()))
        except ValueError:
            pass
    if not alive:
        phase = "terminé" if "Résultats ->" in clean else "arrêté"
    epoch_times = [r["time"] for r in rows]
    per_epoch = (epoch_times[-1] / len(rows)) if rows else None
    done_epochs = len(rows)
    total = cur["epochs"] if cur else 100
    best = max(rows, key=lambda r: r.get("metrics/mAP50-95(B)", 0)) if rows else None
    mem = psutil.virtual_memory()
    return {
        "run": run.name if run else None, "phase": phase, "alive": alive, "current": cur, "rows": rows,
        "done_epochs": done_epochs, "total_epochs": total,
        "per_epoch_s": per_epoch, "remaining_s": per_epoch * (total - done_epochs) if per_epoch else None,
        "best": {"epoch": int(best["epoch"]), "map50": best["metrics/mAP50(B)"],
                 "map": best["metrics/mAP50-95(B)"]} if best else None,
        "ram": {"used_gb": round((mem.total - mem.available) / 1e9, 1), "total_gb": round(mem.total / 1e9, 1),
                "swap_gb": round(psutil.swap_memory().used / 1e9, 1)},
        "now": time.strftime("%H:%M:%S"),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/api/status"):
            body, ctype = json.dumps(status()).encode(), "application/json"
        elif self.path in ("/", "/index.html"):
            body, ctype = PAGE.read_bytes(), "text/html; charset=utf-8"
        else:
            return self.send_error(404)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print("Tableau de bord : http://localhost:8050")
    ThreadingHTTPServer(("127.0.0.1", 8050), Handler).serve_forever()
