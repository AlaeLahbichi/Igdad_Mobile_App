"""TAGHRID  BRONZE -> SILVER -> GOLD : métadonnées Xeno-Canto (Afrique + Europe), job PySpark batch.

    s3a://taghrid-bronze/xeno_canto/api/area=*/page_*.json   (JSON brut de l'API, cf. ingest_xc_metadata.py)
        |  lecture + explode + nettoyage + typage + dédoublonnage
        v
    s3a://taghrid-silver/xc_recordings/                       (Parquet, partitionné par area)
        |  agrégations, fenêtres, pivot, jointures
        v
    s3a://taghrid-gold/analytics/<table>/ + <table>.csv       (tables prêtes pour le rapport / le dashboard)

    .venv/bin/python scripts/spark_metadata_analytics.py
Interface Spark pendant l'exécution : http://localhost:4040
"""

from pyspark.sql import Window
from pyspark.sql import functions as F
from pyspark.sql import types as T

from lake import BRONZE, GOLD, SILVER, get_spark, write_single_csv

RAW = f"{BRONZE}/xeno_canto/api"
PROCESSED = f"{SILVER}/xc_recordings"
ANALYTICS = f"{GOLD}/analytics"
TARGET_CLASSES = f"{SILVER}/reference/model_v2_classes.txt"  # les 83 espèces du modèle audio

# On ne déclare que les champs utiles : Spark ignore le reste du JSON (pas d'inférence de schéma coûteuse)
STR_FIELDS = ["id", "gen", "sp", "ssp", "en", "rec", "cnt", "loc", "lat", "lon", "alt", "type", "sex",
              "stage", "method", "lic", "q", "length", "time", "date", "uploaded", "animal-seen",
              "playback-used", "smp", "status"]
REC_SCHEMA = T.StructType([T.StructField(f, T.StringType()) for f in STR_FIELDS]
                          + [T.StructField("also", T.ArrayType(T.StringType()))])
PAGE_SCHEMA = T.StructType([T.StructField("numRecordings", T.StringType()),
                            T.StructField("recordings", T.ArrayType(REC_SCHEMA))])


spark = None


def save(df, name):
    """Écrit une table d'analyse en Parquet + un CSV unique lisible directement (Excel, pandas, Kibana…)."""
    df.write.mode("overwrite").parquet(f"{ANALYTICS}/{name}")
    write_single_csv(spark, spark.read.parquet(f"{ANALYTICS}/{name}"), f"{ANALYTICS}/{name}.csv")


def to_double(c):
    return F.when(F.trim(F.col(c)).rlike(r"^-?\d+(\.\d+)?$"), F.col(c).try_cast("double"))


def main():
    global spark
    spark = get_spark("taghrid-metadata")

    # ------------------------------------------------------------------ RAW -> PROCESSED
    raw = (spark.read.schema(PAGE_SCHEMA).option("multiLine", True).option("pathGlobFilter", "page_*.json")
           .option("recursiveFileLookup", True).json(RAW)
           .withColumn("area", F.regexp_extract(F.input_file_name(), r"area=([^/]+)", 1)))
    rec = raw.select("area", F.explode("recordings").alias("r")).select("area", "r.*")

    length_parts = F.split(F.col("length"), ":")
    clean = (rec
        .withColumn("id", F.col("id").try_cast("long"))
        .withColumn("species", F.concat_ws("_", "gen", "sp"))
        .withColumn("scientific_name", F.concat_ws(" ", "gen", "sp"))
        .withColumn("lat", to_double("lat")).withColumn("lon", to_double("lon")).withColumn("alt", to_double("alt"))
        # "m:ss" ou "h:mm:ss" -> secondes
        .withColumn("length_s", F.aggregate(length_parts, F.lit(0),
                                            lambda acc, x: acc * 60 + F.coalesce(x.try_cast("int"), F.lit(0))))
        # dates souvent partielles ("2019-05-00", "0000-00-00") : on extrait ce qui est valide
        .withColumn("year", F.substring("date", 1, 4).try_cast("int"))
        .withColumn("year", F.when(F.col("year").between(1900, 2030), F.col("year")))
        .withColumn("month", F.substring("date", 6, 2).try_cast("int"))
        .withColumn("month", F.when(F.col("month").between(1, 12), F.col("month")))
        .withColumn("hour", F.regexp_extract("time", r"^(\d{1,2}):\d{2}", 1).try_cast("int"))
        .withColumn("hour", F.when(F.col("hour").between(0, 23), F.col("hour")))
        .withColumn("upload_year", F.substring("uploaded", 1, 4).try_cast("int"))
        .withColumn("quality", F.when(F.col("q").isin("A", "B", "C", "D", "E"), F.col("q")).otherwise("no score"))
        .withColumn("type", F.lower(F.trim("type")))
        .withColumn("is_song", F.col("type").contains("song"))
        .withColumn("is_call", F.col("type").contains("call"))
        .withColumn("license", F.regexp_extract("lic", r"licenses/([^/]+)/", 1))
        .withColumn("n_background_species", F.size(F.coalesce("also", F.array())))
        .withColumn("sample_rate", F.col("smp").try_cast("int"))
        .withColumnRenamed("cnt", "country").withColumnRenamed("rec", "recordist")
        .withColumnRenamed("en", "english_name").withColumnRenamed("animal-seen", "animal_seen")
        .withColumnRenamed("playback-used", "playback_used")
        .filter(F.col("id").isNotNull() & (F.col("sp") != "mystery") & (F.col("gen") != ""))
        .dropDuplicates(["id"])
        .drop("q", "lic", "smp", "length", "time", "uploaded"))

    # espèces du modèle audio (jointure broadcast : petite table)
    targets = spark.read.text(TARGET_CLASSES).select(F.trim("value").alias("species")).filter("species != ''")
    clean = (clean.join(F.broadcast(targets.withColumn("is_model_species", F.lit(True))), "species", "left")
                  .fillna({"is_model_species": False}))

    clean.repartition("area").write.mode("overwrite").partitionBy("area").parquet(PROCESSED)
    df = spark.read.parquet(PROCESSED).cache()
    n = df.count()
    print(f"PROCESSED : {n} enregistrements -> {PROCESSED}")

    hours = (F.sum("length_s") / 3600).alias("hours")
    maroc = df.filter(F.col("country") == "Morocco")

    # ------------------------------------------------------------------ ANALYTICS
    # 1. Vue d'ensemble par zone
    save(df.groupBy("area").agg(F.count("*").alias("recordings"), F.countDistinct("species").alias("species"),
                                F.countDistinct("country").alias("countries"), F.round(hours, 1).alias("hours"),
                                F.countDistinct("recordist").alias("recordists")).orderBy("area"), "overview")

    # 2. Par pays : volume, richesse spécifique, qualité
    save(df.groupBy("area", "country").agg(
            F.count("*").alias("recordings"), F.countDistinct("species").alias("species"),
            F.round(hours, 1).alias("hours"), F.countDistinct("recordist").alias("recordists"),
            F.round(F.avg((F.col("quality") == "A").cast("int")) * 100, 1).alias("pct_quality_A"))
         .orderBy(F.desc("recordings")), "by_country")

    # 3. Top 10 des espèces par pays (fonction de fenêtre)
    w = Window.partitionBy("country").orderBy(F.desc("recordings"))
    save(df.groupBy("country", "species", "english_name").agg(F.count("*").alias("recordings"))
           .withColumn("rank", F.row_number().over(w)).filter("rank <= 10")
           .orderBy("country", "rank"), "top_species_by_country")

    # 4. Les espèces du Maroc
    save(maroc.groupBy("species", "english_name").agg(
            F.count("*").alias("recordings"), F.round(hours, 2).alias("hours"),
            F.min("year").alias("first_year"), F.max("year").alias("last_year"),
            F.round(F.avg(F.col("is_song").cast("int")) * 100, 1).alias("pct_song"),
            F.round(F.avg(F.col("is_call").cast("int")) * 100, 1).alias("pct_call"),
            F.first("is_model_species").alias("is_model_species"))
         .orderBy(F.desc("recordings")), "maroc_species")

    # 5. Saisonnalité au Maroc : espèce x mois (pivot), 40 espèces les plus enregistrées
    top40 = maroc.groupBy("species").count().orderBy(F.desc("count")).limit(40).select("species")
    save(maroc.join(top40, "species").filter(F.col("month").isNotNull())
              .groupBy("species").pivot("month", list(range(1, 13))).count().fillna(0)
              .orderBy("species"), "maroc_seasonality")

    # 6. Carte : grille de 0,5° sur le Maroc (nb d'enregistrements et d'espèces par case)
    save(maroc.filter(F.col("lat").isNotNull() & F.col("lon").isNotNull())
              .withColumn("lat_cell", F.floor(F.col("lat") * 2) / 2)
              .withColumn("lon_cell", F.floor(F.col("lon") * 2) / 2)
              .groupBy("lat_cell", "lon_cell").agg(F.count("*").alias("recordings"),
                                                   F.countDistinct("species").alias("species"))
              .orderBy(F.desc("recordings")), "maroc_grid")

    # 7. Activité vocale selon l'heure (Maroc) : chants vs cris
    save(maroc.filter(F.col("hour").isNotNull()).groupBy("hour").agg(
            F.count("*").alias("recordings"), F.sum(F.col("is_song").cast("int")).alias("songs"),
            F.sum(F.col("is_call").cast("int")).alias("calls")).orderBy("hour"), "maroc_hourly")

    # 8. Vélocité : enregistrements mis en ligne par an, et cumul (fenêtre glissante)
    wc = Window.partitionBy("area").orderBy("upload_year").rowsBetween(Window.unboundedPreceding, 0)
    save(df.filter(F.col("upload_year").isNotNull()).groupBy("area", "upload_year")
           .agg(F.count("*").alias("uploaded")).withColumn("cumulative", F.sum("uploaded").over(wc))
           .orderBy("area", "upload_year"), "growth_by_year")

    # 9. Qualité par pays
    save(df.groupBy("country").pivot("quality", ["A", "B", "C", "D", "E", "no score"]).count().fillna(0)
           .withColumn("total", sum(F.col(c) for c in ["A", "B", "C", "D", "E", "no score"]))
           .orderBy(F.desc("total")), "quality_by_country")

    # 10. Disponibilité des 83 espèces du modèle audio selon le pays (explique le choix du dataset)
    region = (F.when(F.col("country").isin("Morocco", "Spain", "Portugal", "Algeria"), F.col("country"))
               .when(F.col("area") == "africa", "Other Africa").otherwise("Other Europe"))
    save(df.filter("is_model_species").withColumn("region", region)
           .groupBy("species").pivot("region", ["Morocco", "Spain", "Portugal", "Algeria", "Other Africa",
                                                "Other Europe"]).count().fillna(0)
           .withColumn("total", F.col("Morocco") + F.col("Spain") + F.col("Portugal") + F.col("Algeria")
                       + F.col("Other Africa") + F.col("Other Europe"))
           .orderBy("total"), "model_species_availability")

    # 11. Licences
    save(df.groupBy("license").count().orderBy(F.desc("count")), "licenses")

    # 12. Co-occurrences au Maroc : espèces entendues en fond (champ "also" -> explode)
    save(maroc.select("species", F.explode("also").alias("background"))
              .withColumn("background", F.regexp_replace(F.trim("background"), " ", "_"))
              .filter(F.col("background") != "")
              .groupBy("species", "background").count().orderBy(F.desc("count")).limit(200),
         "maroc_cooccurrence")

    # ------------------------------------------------------------------ Résumé console
    print("\n== Vue d'ensemble"); spark.read.parquet(f"{ANALYTICS}/overview").show()
    print("== Top 10 pays"); spark.read.parquet(f"{ANALYTICS}/by_country").show(10, truncate=False)
    print("== Top 10 espèces au Maroc"); spark.read.parquet(f"{ANALYTICS}/maroc_species").show(10, truncate=False)
    print(f"Tables -> {ANALYTICS}")
    spark.stop()


if __name__ == "__main__":
    main()
