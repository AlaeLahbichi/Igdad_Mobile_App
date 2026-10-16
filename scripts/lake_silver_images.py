"""TAGHRID  BRONZE -> SILVER : catalogue validé des photos iNaturalist (job PySpark).

Entrées (bronze) :
    s3a://taghrid-bronze/inaturalist/api/<espece>/<zone>_page<N>.json    réponses brutes de l'API
    s3a://taghrid-bronze/inaturalist/images/<espece>/<obs>_<photo>.jpg
Sortie (silver, Parquet) :
    s3a://taghrid-silver/image_catalog/    1 ligne par photo : observation (date, lieu, GPS, zone),
        licence + attribution, contrôle qualité (décodable, largeur, hauteur, md5, doublon)

    .venv/bin/python scripts/lake_silver_images.py
"""
import hashlib
import io

import pandas as pd
from pyspark.sql import Window
from pyspark.sql import functions as F
from pyspark.sql import types as T

from lake import BRONZE, SILVER, get_spark

PHOTO = T.StructType([T.StructField("id", T.LongType()), T.StructField("license_code", T.StringType()),
                      T.StructField("attribution", T.StringType()), T.StructField("url", T.StringType())])
OBS = T.StructType([
    T.StructField("id", T.LongType()), T.StructField("observed_on", T.StringType()),
    T.StructField("place_guess", T.StringType()), T.StructField("location", T.StringType()),
    T.StructField("quality_grade", T.StringType()), T.StructField("uri", T.StringType()),
    T.StructField("user", T.StructType([T.StructField("login", T.StringType())])),
    T.StructField("taxon", T.StructType([T.StructField("id", T.LongType()), T.StructField("name", T.StringType()),
                                         T.StructField("preferred_common_name", T.StringType())])),
    T.StructField("photos", T.ArrayType(PHOTO)),
])
PAGE = T.StructType([T.StructField("results", T.ArrayType(OBS))])

CHECK = T.StructType([
    T.StructField("bronze_key", T.StringType()), T.StructField("size_bytes", T.LongType()),
    T.StructField("decodable", T.BooleanType()), T.StructField("width", T.IntegerType()),
    T.StructField("height", T.IntegerType()), T.StructField("md5", T.StringType()),
])


def check_images(batches):
    """mapInPandas : ouvre chaque image (PIL), mesure ses dimensions, calcule son empreinte md5."""
    from PIL import Image
    for pdf in batches:
        rows = []
        for path, length, content in zip(pdf["path"], pdf["length"], pdf["content"]):
            r = {"bronze_key": path.split("taghrid-bronze/", 1)[-1], "size_bytes": int(length), "decodable": False,
                 "width": None, "height": None, "md5": hashlib.md5(content).hexdigest()}
            try:
                with Image.open(io.BytesIO(content)) as im:
                    im.verify()
                with Image.open(io.BytesIO(content)) as im:
                    r.update(decodable=True, width=im.width, height=im.height)
            except Exception:
                pass
            rows.append(r)
        yield pd.DataFrame(rows, columns=[f.name for f in CHECK])


def main():
    spark = get_spark("taghrid-silver-images", extra={"spark.sql.execution.arrow.maxRecordsPerBatch": "32"})

    # --- observations : JSON brut -> une ligne par observation (1re photo sous licence = celle téléchargée)
    pages = (spark.read.schema(PAGE).option("recursiveFileLookup", True).option("pathGlobFilter", "*.json")
             .json(f"{BRONZE}/inaturalist/api/")
             .withColumn("species", F.regexp_extract(F.input_file_name(), r"/api/([^/]+)/", 1))
             .withColumn("zone", F.regexp_extract(F.input_file_name(), r"/([a-z]+)_page\d+\.json", 1)))
    obs = (pages.select("species", "zone", F.explode("results").alias("o")).select("species", "zone", "o.*")
           .withColumn("photo", F.filter("photos", lambda p: p["license_code"].isNotNull())[0])
           .filter(F.col("photo").isNotNull())
           .select(F.col("id").alias("observation_id"), "species", "zone",
                   F.col("photo.id").alias("photo_id"),
                   F.col("taxon.id").alias("inat_taxon_id"), F.col("taxon.name").alias("inat_taxon_name"),
                   F.col("taxon.preferred_common_name").alias("common_name"),
                   F.to_date(F.col("observed_on")).alias("observed_on"), "place_guess",
                   F.split("location", ",")[0].try_cast("double").alias("lat"),
                   F.split("location", ",")[1].try_cast("double").alias("lon"),
                   F.col("photo.license_code").alias("license"), F.col("photo.attribution").alias("attribution"),
                   F.col("user.login").alias("observer"), F.col("uri").alias("source_url"))
           .withColumn("bronze_key", F.format_string("inaturalist/images/%s/%d_%d.jpg",
                                                      "species", "observation_id", "photo_id")))
    # une observation peut apparaître dans 2 zones (ex. Maroc puis « monde ») : on garde la 1re zone
    zone_rank = F.when(F.col("zone") == "morocco", 0).when(F.col("zone") == "spain", 1) \
                 .when(F.col("zone") == "portugal", 2).otherwise(3)
    w = Window.partitionBy("bronze_key").orderBy(zone_rank)
    obs = obs.withColumn("r", F.row_number().over(w)).filter("r = 1").drop("r")

    # --- images (bronze) -> contrôle qualité en parallèle
    imgs = (spark.read.format("binaryFile").option("recursiveFileLookup", True).option("pathGlobFilter", "*.jpg")
            .load(f"{BRONZE}/inaturalist/images/").select("path", "length", "content")
            .mapInPandas(check_images, CHECK))

    catalog = obs.join(imgs, "bronze_key", "inner")
    # doublons exacts (même fichier publié 2 fois) : on ne garde que la 1re occurrence
    wd = Window.partitionBy("md5").orderBy("observation_id")
    catalog = (catalog.withColumn("is_duplicate", F.row_number().over(wd) > 1)
               .withColumn("ingested_at", F.current_timestamp()))
    catalog.repartition(4).write.mode("overwrite").parquet(f"{SILVER}/image_catalog")

    c = spark.read.parquet(f"{SILVER}/image_catalog").cache()
    print(f"SILVER image_catalog : {c.count()} photos, {c.select('species').distinct().count()} espèces")
    c.groupBy("zone").count().orderBy(F.desc("count")).show()
    c.groupBy("decodable", "is_duplicate").count().show()
    c.groupBy("license").count().orderBy(F.desc("count")).show()
    c.agg(F.round(F.avg("width")).alias("largeur_moy"), F.round(F.avg("height")).alias("hauteur_moy"),
          F.round(F.sum("size_bytes") / 1e9, 2).alias("Go")).show()
    spark.stop()


if __name__ == "__main__":
    main()
