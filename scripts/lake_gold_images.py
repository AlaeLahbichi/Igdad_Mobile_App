"""TAGHRID  SILVER -> GOLD : dataset de détection YOLO des 83 espèces d'oiseaux du Maroc (job PySpark).

Entrées : silver/image_catalog + silver/image_detections + images de bronze
Sortie  : s3a://taghrid-gold/yolo_detection/
    images/{train,val,test}/<espece>_<obs>.jpg     redimensionnées (plus grand côté 640 px)
    labels/{train,val,test}/<espece>_<obs>.txt     "<classe> <xc> <yc> <w> <h>" (normalisés)
    data.yaml                                      83 classes, même ordre que le modèle audio
    manifest.csv                                   1 ligne par image (split, espèce, zone, licence, attribution…)

Règles :
    - photo décodable, non dupliquée, avec au moins 1 oiseau détecté (conf >= --min-conf) ;
    - toutes les boîtes d'une photo reçoivent l'espèce de l'observation ;
    - split 80/10/10 stratifié par espèce, déterministe (hash de l'observation).

    .venv/bin/python scripts/lake_gold_images.py
"""
import argparse
import io
from pathlib import Path

import pandas as pd
from pyspark.sql import Window
from pyspark.sql import functions as F
from pyspark.sql import types as T

from lake import GOLD, SILVER, get_spark, write_single_csv, write_text

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "yolo_detection"
MAX_SIDE = 640
RESULT = T.StructType([T.StructField("image_name", T.StringType()), T.StructField("ok", T.BooleanType()),
                       T.StructField("error", T.StringType())])


def export(batches):
    """mapInPandas : bronze -> redimensionnement -> gold (image .jpg + label .txt), via l'API S3."""
    import boto3
    from PIL import Image
    env = dict(l.split("=", 1) for l in (ROOT / ".env").read_text().split() if "=" in l)
    s3 = boto3.client("s3", endpoint_url="http://localhost:9000", region_name="us-east-1",
                      aws_access_key_id=env["MINIO_ROOT_USER"], aws_secret_access_key=env["MINIO_ROOT_PASSWORD"])
    for pdf in batches:
        rows = []
        for r in pdf.itertuples():
            try:
                body = s3.get_object(Bucket="taghrid-bronze", Key=r.bronze_key)["Body"].read()
                im = Image.open(io.BytesIO(body)).convert("RGB")
                scale = MAX_SIDE / max(im.size)
                if scale < 1:   # les coordonnées normalisées restent valables après redimensionnement
                    im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
                buf = io.BytesIO()
                im.save(buf, "JPEG", quality=90)
                s3.put_object(Bucket="taghrid-gold", Key=f"{PREFIX}/images/{r.split}/{r.image_name}.jpg",
                              Body=buf.getvalue(), ContentType="image/jpeg")
                s3.put_object(Bucket="taghrid-gold", Key=f"{PREFIX}/labels/{r.split}/{r.image_name}.txt",
                              Body=r.label_txt.encode(), ContentType="text/plain")
                rows.append((r.image_name, True, None))
            except Exception as e:
                rows.append((r.image_name, False, str(e)[:200]))
        yield pd.DataFrame(rows, columns=["image_name", "ok", "error"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-conf", type=float, default=0.35)
    args = ap.parse_args()
    spark = get_spark("taghrid-gold-images", extra={"spark.sql.execution.arrow.maxRecordsPerBatch": "64",
                                                    "spark.master": "local[8,4]"})

    classes = [r.value.strip() for r in spark.read.text(f"{SILVER}/reference/model_v2_classes.txt").collect()
               if r.value.strip()]
    labels = spark.createDataFrame([(s, i) for i, s in enumerate(classes)], ["species", "label"])
    cat = (spark.read.parquet(f"{SILVER}/image_catalog").filter("decodable AND NOT is_duplicate")
           .select("observation_id", "species", "zone", "bronze_key", "license", "attribution", "observer",
                   "source_url", "lat", "lon", "observed_on"))
    det = spark.read.parquet(f"{SILVER}/image_detections").select("observation_id", "boxes")

    boxes = F.filter("boxes", lambda b: b["conf"] >= args.min_conf)
    data = (cat.join(det, "observation_id").join(F.broadcast(labels), "species")
            .withColumn("boxes", boxes).filter(F.size("boxes") > 0)
            .withColumn("n_boxes", F.size("boxes"))
            .withColumn("label_txt", F.concat(F.array_join(F.transform("boxes", lambda b: F.format_string(
                "%d %.6f %.6f %.6f %.6f", F.col("label"), b["xc"], b["yc"], b["w"], b["h"])), "\n"), F.lit("\n")))
            .withColumn("image_name", F.format_string("%s_%d", "species", "observation_id")))

    # split 80/10/10 stratifié par espèce : rang (ordre pseudo-aléatoire déterministe) / effectif de l'espèce
    w = Window.partitionBy("species").orderBy(F.xxhash64("observation_id"))
    data = (data.withColumn("pct", F.percent_rank().over(w))
            .withColumn("split", F.when(F.col("pct") < 0.8, "train").when(F.col("pct") < 0.9, "val")
                        .otherwise("test")).drop("pct").cache())

    # on repart d'un gold vide : une image ne doit jamais rester dans un ancien split (fuite train/test)
    gold_dir = spark._jvm.org.apache.hadoop.fs.Path(f"{GOLD}/{PREFIX}")
    gold_dir.getFileSystem(spark._jsc.hadoopConfiguration()).delete(gold_dir, True)

    res = data.select("image_name", "bronze_key", "split", "label_txt").repartition(32).mapInPandas(export, RESULT)
    res = res.cache()
    n_ok = res.filter("ok").count()
    failed = res.filter("NOT ok").collect()

    names = "\n".join(f"  {i}: {s}" for i, s in enumerate(classes))
    write_text(spark, f"# TAGHRID - détection des oiseaux du Maroc (photos iNaturalist, boîtes pré-annotées)\n"
                      f"# 'path' est réécrit vers la copie locale par scripts/train_yolo_detector.py\n"
                      f"path: .\ntrain: images/train\nval: images/val\ntest: images/test\n\n"
                      f"nc: {len(classes)}\nnames:\n{names}\n", f"{GOLD}/{PREFIX}/data.yaml")
    manifest = (data.join(res.filter("ok").select("image_name"), "image_name")
                .select("image_name", "split", "species", "label", "n_boxes", "zone", "observation_id",
                        "observed_on", "lat", "lon", "license", "attribution", "observer", "source_url")
                .orderBy("split", "species", "image_name"))
    write_single_csv(spark, manifest, f"{GOLD}/{PREFIX}/manifest.csv")

    print(f"GOLD yolo_detection : {n_ok} images exportées, {len(failed)} échecs")
    m = spark.read.option("header", True).csv(f"{GOLD}/{PREFIX}/manifest.csv")
    m.groupBy("split").agg(F.count("*").alias("images"), F.sum(F.col("n_boxes").cast("int")).alias("boîtes"),
                           F.countDistinct("species").alias("espèces")).orderBy("split").show()
    m.groupBy("species").count().orderBy("count").show(8, truncate=False)
    for f in failed[:10]:
        print("échec", f.image_name, f.error)
    spark.stop()


if __name__ == "__main__":
    main()
