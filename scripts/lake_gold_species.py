"""Gold : catalogue des 83 espèces pour l'application mobile Igdad.

Sources :
  bronze  species_info/{inat,wikipedia,photos}     (scripts/ingest_species_info.py)
  silver  xc_recordings, audio_catalog              (Xeno-Canto)
  silver  image_catalog, image_detections           (iNaturalist)

Sortie : taghrid-gold/species_catalog/
  species.json      une fiche par espèce : noms, taxonomie, statut UICN, textes Wikipédia, photo,
                    galerie, chants, statistiques, saisonnalité au Maroc, zone d'observation
  species/          même contenu à plat (Parquet), pour l'analyse
  ranges/           grille 0,5° x 0,5° des observations par espèce (Parquet)

Les fichiers audio et photos ne sont pas recopiés : les fiches pointent vers leurs clés bronze.

    .venv/bin/python scripts/lake_gold_species.py
"""
import json
import re
import sys
from pathlib import Path

from pyspark.sql import Window
from pyspark.sql import functions as F

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ingest_species_info import s3_client  # noqa: E402
from lake import GOLD, SILVER, get_spark, write_text  # noqa: E402

OUT = f"{GOLD}/species_catalog"
CELL = 0.5            # taille des cellules de la carte (degrés)
MAX_CELLS = 600       # cellules gardées par espèce (les plus observées)

IUCN_FR = {"LC": "Préoccupation mineure", "NT": "Quasi menacée", "VU": "Vulnérable", "EN": "En danger",
           "CR": "En danger critique", "DD": "Données insuffisantes", "NE": "Non évaluée"}
# Cochevis du Maghreb : pas d'article dédié ; iNaturalist et Wikipédia le rattachent au Cochevis huppé
NOTES = {"Galerida_macrorhyncha": "Le Cochevis du Maghreb est souvent traité comme une sous-espèce du Cochevis huppé "
                                  "(Galerida cristata). Le texte ci-dessous décrit le Cochevis huppé."}
IUCN_OVERRIDES = {"Galerida_macrorhyncha": "LC"}   # BirdLife International (espèce Maghreb Lark)
# rubriques Wikipédia retenues (premier mot-clé trouvé dans le titre de section, fr puis en)
SECTIONS = [
    ("description", ("description", "morphologie", "apparence", "identification", "caractéristiques", "appearance")),
    ("voix", ("voix", "chant", "vocalis", "cri", "voice", "song", "call")),
    ("habitat", ("habitat", "milieu")),
    ("repartition", ("répartition", "distribution", "aire", "range")),
    ("alimentation", ("alimentation", "nourriture", "régime", "diet", "food", "feeding")),
    ("reproduction", ("reproduction", "nidification", "breeding", "nesting")),
    ("comportement", ("comportement", "mœurs", "moeurs", "behaviour", "behavior")),
]


def clip(text, n=1100):
    text = re.sub(r"\s+", " ", text.replace("\u00a0", " ")).strip()
    if len(text) <= n:
        return text
    cut = text[:n]
    end = max(cut.rfind(". "), cut.rfind(".»"))
    return cut[: end + 1] if end > n // 3 else cut.rsplit(" ", 1)[0] + "…"


def split_sections(text):
    """Texte brut MediaWiki -> {"intro": ..., "<titre>": ...} : sections ET sous-sections (== / ===)."""
    out, title, buf = {}, "intro", []
    for line in text.splitlines():
        m = re.fullmatch(r"\s*(={2,4})\s*(.*?)\s*\1\s*", line)
        if m:
            if "".join(buf).strip():
                out.setdefault(title, "\n".join(buf).strip())
            title, buf = m.group(2), []
        else:
            buf.append(line)
    if "".join(buf).strip():
        out.setdefault(title, "\n".join(buf).strip())
    return out


def wiki_fields(art):
    if not art:
        return None
    secs = split_sections(art["extract"])
    out = {"lang": art["lang"], "title": art["title"], "url": art["url"], "intro": clip(secs.get("intro", ""), 1400)}
    for key, words in SECTIONS:
        for title, body in secs.items():
            t = title.lower()
            if (title != "intro" and any(t.startswith(w) or f" {w}" in t for w in words) and len(body) > 60
                    and clip(body) not in out.values()):   # « Habitat et répartition » : une seule rubrique
                out[key] = clip(body)
                break
    return out


def taxonomy(taxon):
    anc = {a["rank"]: a for a in taxon.get("ancestors", [])}
    iucn = next((c for c in taxon.get("conservation_statuses", [])
                 if (c.get("authority") or "").startswith("IUCN") and not c.get("place")), None)
    code = (iucn or {}).get("status", "NE").upper()
    return {
        "inat_id": taxon["id"], "fr": taxon.get("preferred_common_name"), "en": taxon.get("english_common_name"),
        "order": anc.get("order", {}).get("name"), "order_fr": anc.get("order", {}).get("preferred_common_name"),
        "family": anc.get("family", {}).get("name"), "family_fr": anc.get("family", {}).get("preferred_common_name"),
        "iucn": code, "iucn_label": IUCN_FR.get(code, code),
        "inat_observations": taxon.get("observations_count"),
    }


def main():
    s3 = s3_client()
    classes = s3.get_object(Bucket="taghrid-gold", Key="audio_training/classes.txt")["Body"].read().decode().split()
    spark = get_spark("taghrid-gold-species")
    sp = spark.createDataFrame([(c,) for c in classes], ["species"])

    xc = spark.read.parquet(f"{SILVER}/xc_recordings").join(F.broadcast(sp), "species")
    img = (spark.read.parquet(f"{SILVER}/image_catalog").where(~F.col("is_duplicate") & F.col("decodable"))
           .join(F.broadcast(sp), "species"))

    # --- zone d'observation : grille des points Xeno-Canto + iNaturalist -------------------------------
    pts = (xc.select("species", "lat", "lon", F.lit("xeno-canto").alias("src"))
           .unionByName(img.select("species", "lat", "lon", F.lit("inaturalist").alias("src")))
           .where(F.col("lat").isNotNull() & F.col("lon").isNotNull()
                  & F.col("lat").between(-90, 90) & F.col("lon").between(-180, 180)))
    cells = (pts.groupBy("species", (F.floor(F.col("lat") / CELL) * CELL + CELL / 2).alias("lat"),
                         (F.floor(F.col("lon") / CELL) * CELL + CELL / 2).alias("lon"))
             .agg(F.count("*").alias("n"), F.sum((F.col("src") == "xeno-canto").cast("int")).alias("n_xc")))
    cells = (cells.withColumn("rk", F.row_number().over(Window.partitionBy("species").orderBy(F.desc("n"))))
             .where(F.col("rk") <= MAX_CELLS).drop("rk"))
    cells.write.mode("overwrite").partitionBy("species").parquet(f"{OUT}/ranges")

    # --- statistiques et saisonnalité au Maroc ---------------------------------------------------------
    stats = xc.groupBy("species").agg(
        F.count("*").alias("xc_recordings"),
        F.sum((F.col("country") == "Morocco").cast("int")).alias("xc_morocco"),
        F.countDistinct("country").alias("xc_countries"),
        F.sum(F.col("is_song").cast("int")).alias("xc_songs"),
        F.sum(F.col("is_call").cast("int")).alias("xc_calls"))
    months = (xc.where((F.col("country") == "Morocco") & F.col("month").between(1, 12))
              .groupBy("species").pivot("month", list(range(1, 13))).count().na.fill(0))
    photos = img.groupBy("species").agg(F.count("*").alias("inat_photos"),
                                        F.sum((F.col("zone") == "morocco").cast("int")).alias("inat_photos_morocco"))

    # --- chants : meilleur chant + meilleur cri parmi les fichiers réellement présents en bronze ----------
    audio = (spark.read.parquet(f"{SILVER}/audio_catalog").where("decodable").join(F.broadcast(sp), "species")
             .withColumn("kind", F.when(F.lower("type").contains("song"), "chant")
                         .when(F.lower("type").contains("call"), "cri"))
             .where(F.col("kind").isNotNull() & F.col("duration_s").between(6, 120)))
    score = (F.when(F.col("quality") == "A", 0).when(F.col("quality") == "B", 1).otherwise(2) * 10
             + F.when(F.col("country") == "Morocco", 0).otherwise(3)
             + F.when(F.col("duration_s").between(10, 60), 0).otherwise(2))
    songs = (audio.withColumn("rk", F.row_number().over(
                Window.partitionBy("species", "kind").orderBy(score, F.col("size_bytes"))))
             .where("rk = 1")
             .select("species", "kind", "recording_id", "type", "quality", "country", "locality", "date",
                     "recordist", "license", "source_url", "duration_s",
                     F.regexp_replace("bronze_path", "^s3a://taghrid-bronze/", "").alias("key")))

    # --- galerie : photos avec un seul oiseau bien détecté ----------------------------------------------
    det = (spark.read.parquet(f"{SILVER}/image_detections").where("n_birds = 1")
           .select("bronze_key", F.col("boxes")[0]["conf"].alias("conf"),
                   (F.col("boxes")[0]["w"] * F.col("boxes")[0]["h"]).alias("area")))
    gallery = (img.join(det, "bronze_key").where(F.col("area").between(0.08, 0.8))
               .withColumn("rk", F.row_number().over(Window.partitionBy("species").orderBy(
                   (F.col("zone") != "morocco").cast("int"), F.desc("conf"))))
               .where("rk <= 6")
               .select("species", "rk", "bronze_key", "attribution", "license", "place_guess", "source_url"))

    rows = {r["species"]: r.asDict() for r in stats.join(photos, "species", "outer").collect()}
    month_rows = {r["species"]: [int(r[str(m)]) for m in range(1, 13)] for r in months.collect()}
    song_rows, gal_rows, cell_rows = {}, {}, {}
    for r in songs.collect():
        d = r.asDict()
        d["date"] = str(d["date"]) if d["date"] else None
        song_rows.setdefault(r["species"], []).append(d)
    for r in gallery.orderBy("species", "rk").collect():
        gal_rows.setdefault(r["species"], []).append(r.asDict())
    for r in cells.collect():
        cell_rows.setdefault(r["species"], []).append([round(r["lat"], 2), round(r["lon"], 2), r["n"]])

    catalog = []
    for c in classes:
        taxon = json.loads(s3.get_object(Bucket="taghrid-bronze", Key=f"species_info/inat/{c}.json")["Body"].read())
        art = json.loads(s3.get_object(Bucket="taghrid-bronze", Key=f"species_info/wikipedia/{c}.json")["Body"].read())
        photo = json.loads(s3.get_object(Bucket="taghrid-bronze", Key=f"species_info/photos/{c}.json")["Body"].read())
        st = rows.get(c, {})
        cl = cell_rows.get(c, [])
        entry = {
            "species": c, "sci": c.replace("_", " "), **taxonomy(taxon), "note": NOTES.get(c),
            "photo_key": f"species_info/photos/{c}.jpg", "photo_attribution": photo["attribution"],
            "photo_license": photo["license"], "photo_source": photo["source_url"],
            "wiki": wiki_fields(art),
            "stats": {k: int(st.get(k) or 0) for k in ("xc_recordings", "xc_morocco", "xc_countries", "xc_songs",
                                                          "xc_calls", "inat_photos", "inat_photos_morocco")},
            "months_morocco": month_rows.get(c, [0] * 12),
            "songs": sorted([{k: v for k, v in s.items() if k != "species"} for s in song_rows.get(c, [])],
                            key=lambda s: s["kind"] != "chant"),
            "gallery": [{k: v for k, v in g.items() if k not in ("species", "rk")} for g in gal_rows.get(c, [])],
            "range": {"cell_deg": CELL, "cells": cl},
        }
        if c in IUCN_OVERRIDES:
            entry["iucn"] = IUCN_OVERRIDES[c]
            entry["iucn_label"] = IUCN_FR[entry["iucn"]]
        catalog.append(entry)

    write_text(spark, json.dumps(catalog, ensure_ascii=False), f"{OUT}/species.json")
    flat = [{k: v for k, v in e.items() if not isinstance(v, (dict, list))} | e["stats"]
            | {"wiki_url": (e["wiki"] or {}).get("url"), "n_range_cells": len(e["range"]["cells"]),
               "n_songs": len(e["songs"]), "n_gallery": len(e["gallery"])} for e in catalog]
    spark.createDataFrame(flat).coalesce(1).write.mode("overwrite").parquet(f"{OUT}/species")

    missing = {k: [e["species"] for e in catalog if not cond(e)] for k, cond in {
        "fr": lambda e: e["fr"], "wiki": lambda e: e["wiki"], "chant": lambda e: e["songs"],
        "galerie": lambda e: e["gallery"], "carte": lambda e: e["range"]["cells"]}.items()}
    print(f"species_catalog : {len(catalog)} espèces -> {OUT}")
    for k, v in missing.items():
        print(f"  sans {k:<8}: {len(v):>2} {v[:8]}")
    spark.stop()


if __name__ == "__main__":
    main()
