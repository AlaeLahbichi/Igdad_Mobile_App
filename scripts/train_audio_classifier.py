"""Entraîne un CNN (EfficientNet pré-entraîné ImageNet, via timm) sur les mel-spectrogrammes
de la couche GOLD du data lake TAGHRID (MinIO) pour classer les 83 espèces d'oiseaux du Maroc.

    bash scripts/lake_start.sh                                          # MinIO doit tourner
    .venv/bin/python scripts/train_audio_classifier.py --check-data     # vérifie la lecture, sans entraîner
    .venv/bin/python scripts/train_audio_classifier.py                 # entraînement complet
    .venv/bin/python scripts/train_audio_classifier.py --epochs 1 --limit 512   # test rapide

Données lues dans s3://taghrid-gold/audio_training/ (cf. scripts/lake_gold_audio.py) :
    spectrograms/split=train|val|test/*.parquet   (mel = bytes float16 [128, 313], label, recording_id…)
    classes.txt, config.json
- Le dataset (~3,2 Go en float16) est lu par lots via pyarrow et chargé en mémoire (pré-alloué).
- Déséquilibre des classes : échantillonnage pondéré (chaque espèce tirée aussi souvent).
- Augmentations sur GPU : décalage temporel, SpecAugment (masques temps/fréquence), mixup.
- Évaluation par segment de 5 s ET par enregistrement (moyenne des probabilités des segments).
- Sorties : runs/audio/<date>/ (best.pt, history.csv, test_report.txt)
"""
import argparse
import csv
import json
import os
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.dataset as ds
import pyarrow.fs as pafs
import timm
import torch
import torch.nn.functional as F
from sklearn.metrics import classification_report, f1_score

ROOT = Path(__file__).resolve().parents[1]
GOLD = "taghrid-gold/audio_training"
META_COLS = ["recording_id", "species", "label", "chunk", "country", "quality"]


def gold_fs():
    """Système de fichiers S3 (MinIO) ; identifiants lus dans .env."""
    env = dict(l.split("=", 1) for l in (ROOT / ".env").read_text().split() if "=" in l)
    endpoint = os.environ.get("S3_ENDPOINT", "http://localhost:9000")
    return pafs.S3FileSystem(access_key=env["MINIO_ROOT_USER"], secret_key=env["MINIO_ROOT_PASSWORD"],
                             endpoint_override=endpoint.split("://")[-1], scheme=endpoint.split("://")[0],
                             region="us-east-1")


def read_text(fs, path):
    with fs.open_input_stream(path) as f:
        return f.read().decode()


def load_split(fs, split, shape, limit=0):
    """Lit un split de GOLD par lots : métadonnées -> DataFrame, mel -> tableau float16 pré-alloué."""
    dset = ds.dataset(f"{GOLD}/spectrograms", filesystem=fs, format="parquet", partitioning="hive")
    flt = ds.field("split") == split
    n = dset.count_rows(filter=flt)
    keep = np.ones(n, dtype=bool)
    if limit and limit < n:                                       # sous-échantillon aléatoire (test rapide)
        keep[:] = False
        keep[np.random.default_rng(0).choice(n, limit, replace=False)] = True
    x = np.empty((int(keep.sum()), *shape), dtype=np.float16)     # [N, 128, 313] float16, dB [-80, 0]
    metas, pos, j = [], 0, 0
    for batch in dset.to_batches(columns=META_COLS + ["mel"], filter=flt, batch_size=256):
        m = keep[pos:pos + batch.num_rows]
        pos += batch.num_rows
        if not m.any():
            continue
        t = pa.Table.from_batches([batch]).filter(pa.array(m))
        for b in t.column("mel").to_pylist():
            x[j] = np.frombuffer(b, dtype=np.float16).reshape(shape)
            j += 1
        metas.append(t.drop_columns(["mel"]).to_pandas())
    d = pd.concat(metas, ignore_index=True)
    x = torch.from_numpy(x).unsqueeze(1)                          # [N, 1, 128, 313]
    y = torch.tensor(d.label.values, dtype=torch.long)
    return d, x, y


def normalize(x):
    return (x.float() + 40.0) / 40.0                              # [-80, 0] dB -> [-1, 1]


def augment(x, y, n_classes, mixup_p=0.5):
    b, _, n_mels, t = x.shape
    # décalage temporel circulaire aléatoire
    shifts = torch.randint(0, t, (b,))
    x = torch.stack([torch.roll(x[i], int(shifts[i]), dims=-1) for i in range(b)])
    # SpecAugment : 2 masques de fréquence, 2 masques de temps (mis à la valeur min = -1)
    for _ in range(2):
        f = torch.randint(0, 16, (b,), device=x.device)
        f0 = (torch.rand(b, device=x.device) * (n_mels - f)).long()
        ar = torch.arange(n_mels, device=x.device)[None]
        m = (ar >= f0[:, None]) & (ar < (f0 + f)[:, None])
        x = x.masked_fill(m[:, None, :, None], -1.0)
        w = torch.randint(0, 40, (b,), device=x.device)
        w0 = (torch.rand(b, device=x.device) * (t - w)).long()
        ar = torch.arange(t, device=x.device)[None]
        m = (ar >= w0[:, None]) & (ar < (w0 + w)[:, None])
        x = x.masked_fill(m[:, None, None, :], -1.0)
    y = F.one_hot(y, n_classes).float()
    if torch.rand(1).item() < mixup_p:
        lam = float(np.random.beta(0.4, 0.4))
        perm = torch.randperm(b, device=x.device)
        x = lam * x + (1 - lam) * x[perm]
        y = lam * y + (1 - lam) * y[perm]
    return x, y


@torch.no_grad()
def predict(model, x, device, bs=128):
    model.eval()
    out = []
    for i in range(0, len(x), bs):
        out.append(model(normalize(x[i:i + bs].to(device))).float().softmax(-1).cpu())
    return torch.cat(out)


def evaluate(probs, d):
    seg_pred = probs.argmax(1).numpy()
    seg_acc = float((seg_pred == d.label.values).mean())
    # niveau enregistrement : moyenne des probabilités de tous ses segments
    rec = pd.DataFrame(probs.numpy()).groupby(d.recording_id.values).mean()
    rec_true = d.groupby("recording_id").label.first().loc[rec.index].values
    rec_pred = rec.values.argmax(1)
    return {"seg_acc": seg_acc,
            "rec_acc": float((rec_pred == rec_true).mean()),
            "rec_f1_macro": float(f1_score(rec_true, rec_pred, average="macro")),
            "rec_true": rec_true, "rec_pred": rec_pred}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="efficientnet_b0")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--bs", type=int, default=32)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--no-pretrained", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="nb max de segments par split (test rapide)")
    ap.add_argument("--check-data", action="store_true", help="charge les données depuis GOLD puis s'arrête")
    args = ap.parse_args()

    torch.manual_seed(0)
    np.random.seed(0)
    device = torch.device("mps" if torch.backends.mps.is_available()
                          else "cuda" if torch.cuda.is_available() else "cpu")
    fs = gold_fs()
    classes = read_text(fs, f"{GOLD}/classes.txt").split()
    config = json.loads(read_text(fs, f"{GOLD}/config.json"))
    n_classes, shape = len(classes), tuple(config["shape"])

    print(f"Chargement des spectrogrammes depuis s3://{GOLD} …")
    t0 = time.time()
    d_tr, x_tr, y_tr = load_split(fs, "train", shape, args.limit)
    d_va, x_va, _ = load_split(fs, "val", shape, args.limit)
    d_te, x_te, _ = load_split(fs, "test", shape, args.limit)
    print(f"train {len(x_tr)} | val {len(x_va)} | test {len(x_te)} segments, {n_classes} classes, "
          f"device={device} ({time.time() - t0:.0f}s)")
    if args.check_data:
        for name, d, x in (("train", d_tr, x_tr), ("val", d_va, x_va), ("test", d_te, x_te)):
            print(f"  {name:<5} {tuple(x.shape)} {x.dtype} dB [{float(x.min()):.0f}, {float(x.max()):.0f}] "
                  f"{d.recording_id.nunique()} enregistrements, {d.label.nunique()} espèces")
        print(f"  mémoire : {sum(x.nbytes for x in (x_tr, x_va, x_te)) / 1e9:.2f} Go")
        return

    model = timm.create_model(args.model, pretrained=not args.no_pretrained,
                              num_classes=n_classes, in_chans=1, drop_rate=0.3).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-2)
    steps_per_epoch = len(x_tr) // args.bs
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=args.epochs * steps_per_epoch,
                                                pct_start=0.1)

    # échantillonnage équilibré : poids = 1 / nb de segments de la classe
    counts = torch.bincount(y_tr, minlength=n_classes).float()
    sample_w = (1.0 / counts.clamp(min=1))[y_tr]

    out_dir = ROOT / "runs" / "audio" / datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir.mkdir(parents=True)
    history, best = [], -1.0
    for epoch in range(1, args.epochs + 1):
        model.train()
        t0, tot = time.time(), 0.0
        idx = torch.multinomial(sample_w, steps_per_epoch * args.bs, replacement=True)
        for s in range(steps_per_epoch):
            b = idx[s * args.bs:(s + 1) * args.bs]
            x = normalize(x_tr[b].to(device))
            x, y = augment(x, y_tr[b].to(device), n_classes)
            loss = torch.sum(-y * F.log_softmax(model(x), -1), -1).mean()
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            sched.step()
            tot += loss.item()
        m = evaluate(predict(model, x_va, device), d_va)
        row = {"epoch": epoch, "loss": tot / steps_per_epoch, "val_seg_acc": m["seg_acc"],
               "val_rec_acc": m["rec_acc"], "val_rec_f1": m["rec_f1_macro"], "time_s": time.time() - t0}
        history.append(row)
        print(f"epoch {epoch:2d}/{args.epochs} loss {row['loss']:.3f} | val seg acc {m['seg_acc']:.3f} "
              f"| val rec acc {m['rec_acc']:.3f} f1 {m['rec_f1_macro']:.3f} | {row['time_s']:.0f}s")
        if m["rec_f1_macro"] > best:
            best = m["rec_f1_macro"]
            torch.save({"model": args.model, "state_dict": model.state_dict(), "classes": classes,
                        "config": config, "epoch": epoch},
                       out_dir / "best.pt")

    with open(out_dir / "history.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(history[0]))
        w.writeheader()
        w.writerows(history)

    # Test final avec le meilleur modèle (selon F1 val)
    ckpt = torch.load(out_dir / "best.pt", map_location=device)
    model.load_state_dict(ckpt["state_dict"])
    probs_te = predict(model, x_te, device)
    m = evaluate(probs_te, d_te)
    labels = sorted(set(m["rec_true"]) | set(m["rec_pred"]))
    report = (f"Meilleure epoch (val F1) : {ckpt['epoch']}\n"
              f"TEST  seg acc {m['seg_acc']:.3f} | rec acc {m['rec_acc']:.3f} | rec F1 macro {m['rec_f1_macro']:.3f}\n")
    if "country" in d_te:
        for c in sorted(d_te.country.dropna().unique()):
            sel = (d_te.country == c).values
            if d_te[sel].recording_id.nunique() >= 10:
                mc = evaluate(probs_te[torch.from_numpy(sel)], d_te[sel].reset_index(drop=True))
                report += (f"  {c:<10} ({d_te[sel].recording_id.nunique()} enr.) seg acc {mc['seg_acc']:.3f} "
                           f"| rec acc {mc['rec_acc']:.3f} | rec F1 macro {mc['rec_f1_macro']:.3f}\n")
    report += ("\n"
              + classification_report(m["rec_true"], m["rec_pred"], labels=labels,
                                      target_names=[classes[i] for i in labels], zero_division=0))
    (out_dir / "test_report.txt").write_text(report)
    print(report.split("\n\n")[0])
    print(f"Résultats -> {out_dir}")


if __name__ == "__main__":
    main()
