
import io
import json

import numpy as np
import pandas as pd
from pyspark.sql import Window
from pyspark.sql import functions as F
from pyspark.sql import types as T

from lake import BRONZE, GOLD, SILVER, get_spark, write_single_csv, write_text

CFG = {"sr": 32000, "chunk_s": 5.0, "min_last_s": 2.0, "n_fft": 2048, "hop_length": 512, "n_mels": 128,
       "fmin": 50, "fmax": 14000, "db_range": [-80, 0], "dtype": "float16", "shape": [128, 313],
       "max_segments": 6, "max_per_species": 200}

SEG_SCHEMA = T.StructType([
    T.StructField("bronze_path", T.StringType()),
    T.StructField("chunk", T.IntegerType()),
    T.StructField("rms", T.FloatType()),
    T.StructField("mel", T.BinaryType()),
])


def to_segments(batches):
    """mapInPandas : décodage -> segments de 5 s -> top RMS -> mel-spectrogramme float16."""
    import librosa
    sr, n = CFG["sr"], int(CFG["chunk_s"] * CFG["sr"])
    for pdf in batches:
        out = []
        for path, content in zip(pdf["path"], pdf["content"]):
            try:
                y, _ = librosa.load(io.BytesIO(content), sr=sr, mono=True)
            except Exception:
                continue
            segs = []
            for k, start in enumerate(range(0, max(len(y), 1), n)):
                seg = y[start:start + n]
                if len(seg) < n:
                    if len(seg) < CFG["min_last_s"] * sr and k > 0:
                        break
                    seg = np.pad(seg, (0, n - len(seg)))
                if np.any(seg):
                    segs.append((k, seg, float(np.sqrt(np.mean(seg ** 2)))))
            if len(segs) > CFG["max_segments"]:
                segs = sorted(sorted(segs, key=lambda s: -s[2])[:CFG["max_segments"]], key=lambda s: s[0])
            for k, seg, rms in segs:
                m = librosa.feature.melspectrogram(y=seg, sr=sr, n_fft=CFG["n_fft"], hop_length=CFG["hop_length"],
                                                   n_mels=CFG["n_mels"], fmin=CFG["fmin"], fmax=CFG["fmax"])
                db = librosa.power_to_db(m, ref=np.max, top_db=80.0).astype(np.float16)
                out.append({"bronze_path": path, "chunk": k, "rms": rms, "mel": db.tobytes()})
        yield pd.DataFrame(out, columns=[f.name for f in SEG_SCHEMA])


def main():
    spark = get_spark("taghrid-gold-audio", driver_memory="4g", extra={
        "spark.sql.execution.arrow.maxRecordsPerBatch": "8",
        "spark.sql.files.maxPartitionBytes": str(64 * 1024 * 1024),
        "spark.sql.shuffle.partitions": "32",
        "spark.master": "local[6,4]",   # 6 workers Python (librosa) : limite la RAM sur un portable 18 Go
    })

    catalog = spark.read.parquet(f"{SILVER}/audio_catalog").filter("decodable")
    model_split = (spark.read.option("header", True).csv(f"{SILVER}/reference/model_v2_split.csv")
                   .select(F.col("recording_id").cast("long"), F.col("split").alias("model_split")))
    classes = spark.read.text(f"{SILVER}/reference/model_v2_classes.txt").collect()
    classes = [r.value.strip() for r in classes if r.value.strip()]
    labels = spark.createDataFrame([(s, i) for i, s in enumerate(classes)], ["species", "label"])

    # --- sélection : 200 enregistrements max par espèce (fenêtre), priorité modèle actuel > Maroc > qualité
    w = Window.partitionBy("species").orderBy(
        F.col("model_split").isNull(), F.col("country") != "Morocco",
        F.coalesce(F.col("quality"), F.lit("Z")), F.xxhash64("recording_id"))
    hash_split = (F.when(F.pmod(F.xxhash64("recording_id"), 10) == 0, "val")
                   .when(F.pmod(F.xxhash64("recording_id"), 10) == 1, "test").otherwise("train"))
    selected = (catalog.join(model_split, "recording_id", "left")
                .withColumn("rank", F.row_number().over(w))
                .filter(F.col("rank") <= CFG["max_per_species"])
                .withColumn("split", F.coalesce("model_split", hash_split))
                .withColumn("used_by_model_v2", F.col("model_split").isNotNull())
                .join(F.broadcast(labels), "species")
                .select("recording_id", "species", "label", "split", "used_by_model_v2", "country", "quality",
                        "bronze_path")
                .cache())
    paths = [r.bronze_path for r in selected.select("bronze_path").collect()]
    print(f"Sélection : {len(paths)} enregistrements, "
          f"{selected.filter('used_by_model_v2').count()} issus du split du modèle actuel")

    # --- lecture des seuls fichiers sélectionnés depuis bronze, puis calcul distribué des spectrogrammes
    audio = spark.read.format("binaryFile").load(paths).select("path", "content")
    segs = audio.mapInPandas(to_segments, SEG_SCHEMA)  # pas de repartition : on évite de déplacer l'audio
    gold = (segs.join(F.broadcast(selected), "bronze_path")
            .select("recording_id", "species", "label", "split", "chunk", "rms", "country", "quality",
                    "used_by_model_v2", "mel"))
    # peu d'écrivains simultanés (MinIO sur volume partagé macOS supporte mal les écritures massivement parallèles)
    (gold.repartition(12, "split", "species").write.mode("overwrite").partitionBy("split")
         .parquet(f"{GOLD}/audio_training/spectrograms"))

    # --- fichiers d'accompagnement
    g = spark.read.parquet(f"{GOLD}/audio_training/spectrograms")
    write_single_csv(spark, g.drop("mel").orderBy("split", "species", "recording_id", "chunk"),
                     f"{GOLD}/audio_training/manifest.csv")
    write_text(spark, "\n".join(classes) + "\n", f"{GOLD}/audio_training/classes.txt")
    write_text(spark, json.dumps(CFG, indent=2), f"{GOLD}/audio_training/config.json")

    print("GOLD audio_training :")
    g.groupBy("split").agg(F.countDistinct("recording_id").alias("enregistrements"),
                           F.count("*").alias("segments")).orderBy("split").show()
    print(f"espèces : {g.select('species').distinct().count()}")
    spark.stop()


if __name__ == "__main__":
    main()
