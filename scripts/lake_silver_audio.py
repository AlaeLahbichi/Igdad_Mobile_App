"""TAGHRID  BRONZE -> SILVER : catalogue validé des enregistrements audio.

Entrées (bronze, brut) :
    s3a://taghrid-bronze/xeno_canto/audio/<Genre_espece>/XC<id>.(mp3|wav)
    s3a://taghrid-bronze/xeno_canto/downloads/metadata.csv
Sortie (silver, nettoyé/typé/validé, Parquet) :
    s3a://taghrid-silver/audio_catalog/      1 ligne par fichier audio, partitionné par espèce
        recording_id, species, country, quality, lat/lon, type, licence…   (métadonnées typées)
        duration_s, sample_rate, channels, format, size_bytes, decodable, error   (contrôle qualité)

Les fichiers audio sont lus en parallèle par Spark (binaryFile) et inspectés dans des workers Python
(soundfile) : aucun fichier n'est copié en local.

    .venv/bin/python scripts/lake_silver_audio.py
"""
import io

import pandas as pd
from pyspark.sql import functions as F
from pyspark.sql import types as T

from lake import BRONZE, SILVER, get_spark

INFO_SCHEMA = T.StructType([
    T.StructField("bronze_path", T.StringType()),
    T.StructField("size_bytes", T.LongType()),
    T.StructField("decodable", T.BooleanType()),
    T.StructField("duration_s", T.DoubleType()),
    T.StructField("sample_rate", T.IntegerType()),
    T.StructField("channels", T.IntegerType()),
    T.StructField("format", T.StringType()),
    T.StructField("error", T.StringType()),
])


def inspect_audio(batches):
    """mapInPandas : lit l'en-tête de chaque fichier audio (sans le décoder entièrement)."""
    import soundfile as sf
    for pdf in batches:
        rows = []
        for path, length, content in zip(pdf["path"], pdf["length"], pdf["content"]):
            r = {"bronze_path": path, "size_bytes": int(length), "decodable": False, "duration_s": None,
                 "sample_rate": None, "channels": None, "format": None, "error": None}
            try:
                info = sf.info(io.BytesIO(content))
                r.update(decodable=info.frames > 0, duration_s=float(info.duration),
                         sample_rate=int(info.samplerate), channels=int(info.channels), format=info.format)
            except Exception as e:
                r["error"] = str(e)[:300]
            rows.append(r)
        yield pd.DataFrame(rows, columns=[f.name for f in INFO_SCHEMA])


def main():
    spark = get_spark("taghrid-silver-audio", extra={
        "spark.sql.execution.arrow.maxRecordsPerBatch": "16",   # lots de 16 fichiers par worker
        "spark.sql.files.maxPartitionBytes": str(256 * 1024 * 1024),
    })

    # --- métadonnées des téléchargements (bronze) -> typées
    meta = (spark.read.option("header", True).option("multiLine", True).option("escape", '"')
            .csv(f"{BRONZE}/xeno_canto/downloads/metadata.csv"))
    length_parts = F.split("length", ":")
    meta = (meta.select(
                F.col("id").try_cast("long").alias("recording_id"), "species",
                F.col("en").alias("english_name"), F.col("gen").alias("genus"), F.col("sp").alias("epithet"),
                F.col("cnt").alias("country"), F.col("loc").alias("locality"),
                F.col("lat").try_cast("double").alias("lat"), F.col("lon").try_cast("double").alias("lon"),
                F.lower(F.trim("type")).alias("type"), F.col("q").alias("quality"),
                F.aggregate(length_parts, F.lit(0), lambda a, x: a * 60 + F.coalesce(x.try_cast("int"), F.lit(0)))
                 .alias("declared_length_s"),
                F.to_date(F.when(F.col("date").rlike(r"^\d{4}-\d{2}-\d{2}$")
                                 & ~F.col("date").rlike("-00"), F.col("date"))).alias("date"),
                F.col("rec").alias("recordist"),
                F.regexp_extract("lic", r"licenses/([^/]+)/", 1).alias("license"),
                F.col("url").alias("source_url"))
            .filter(F.col("recording_id").isNotNull())
            .dropDuplicates(["recording_id"]))

    # --- fichiers audio (bronze) -> inspection en parallèle
    files = (spark.read.format("binaryFile").option("recursiveFileLookup", True)
             .option("pathGlobFilter", "XC*.{mp3,wav,MP3,WAV,flac}")
             .load(f"{BRONZE}/xeno_canto/audio/"))
    info = (files.select("path", "length", "content").mapInPandas(inspect_audio, INFO_SCHEMA)
            .withColumn("recording_id", F.regexp_extract("bronze_path", r"XC(\d+)\.", 1).cast("long")))

    catalog = (meta.join(info, "recording_id", "inner")
               .withColumn("duration_mismatch_s", F.round(F.abs(F.col("duration_s") - F.col("declared_length_s")), 1))
               .withColumn("ingested_at", F.current_timestamp()))
    catalog.repartition(8).write.mode("overwrite").partitionBy("species").parquet(f"{SILVER}/audio_catalog")

    c = spark.read.parquet(f"{SILVER}/audio_catalog").cache()
    print(f"SILVER audio_catalog : {c.count()} fichiers, {c.select('species').distinct().count()} espèces")
    c.groupBy("decodable").count().show()
    c.groupBy("format", "sample_rate").count().orderBy(F.desc("count")).show(8)
    c.agg(F.round(F.sum("duration_s") / 3600, 1).alias("heures"),
          F.round(F.sum("size_bytes") / 1e9, 1).alias("Go")).show()
    c.filter(~F.col("decodable")).select("recording_id", "species", "error").show(10, truncate=60)
    spark.stop()


if __name__ == "__main__":
    main()
