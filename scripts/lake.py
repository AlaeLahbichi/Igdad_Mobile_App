
import os
import sys
from pathlib import Path

from pyspark.sql import SparkSession

ROOT = Path(__file__).resolve().parents[1]
BRONZE, SILVER, GOLD = "s3a://taghrid-bronze", "s3a://taghrid-silver", "s3a://taghrid-gold"
HADOOP_AWS = "org.apache.hadoop:hadoop-aws:3.5.0"  # même version que le Hadoop embarqué par PySpark 4.2


def read_env():
    env = {}
    for line in (ROOT / ".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def get_spark(app, driver_memory="4g", extra=None):
    env = read_env()
    # Le shell peut pointer vers un autre Spark/venv (ex. TP1) : on force celui du projet
    os.environ["PYSPARK_PYTHON"] = os.environ["PYSPARK_DRIVER_PYTHON"] = sys.executable
    os.environ.pop("SPARK_HOME", None)
    # local[*,4] : chaque tâche peut être relancée 4 fois (erreurs transitoires de MinIO)
    b = (SparkSession.builder.appName(app).master("local[*,4]")
         .config("spark.driver.memory", driver_memory)
         .config("spark.jars.packages", HADOOP_AWS)
         .config("spark.sql.shuffle.partitions", "16")
         .config("spark.sql.session.timeZone", "UTC")
         .config("spark.hadoop.fs.s3a.endpoint", os.environ.get("S3_ENDPOINT", "http://localhost:9000"))
         .config("spark.hadoop.fs.s3a.access.key", env["MINIO_ROOT_USER"])
         .config("spark.hadoop.fs.s3a.secret.key", env["MINIO_ROOT_PASSWORD"])
         .config("spark.hadoop.fs.s3a.path.style.access", "true")
         .config("spark.hadoop.fs.s3a.connection.ssl.enabled", "false")
         .config("spark.hadoop.fs.s3a.endpoint.region", "us-east-1")
         .config("spark.hadoop.fs.s3a.aws.credentials.provider",
                 "org.apache.hadoop.fs.s3a.SimpleAWSCredentialsProvider")
         .config("spark.hadoop.fs.s3a.retry.http.5xx.errors", "true")
         .config("spark.hadoop.fs.s3a.retry.limit", "10")
         .config("spark.hadoop.fs.s3a.retry.interval", "1s"))
    for k, v in (extra or {}).items():
        b = b.config(k, v)
    spark = b.getOrCreate()
    spark.sparkContext.setLogLevel("WARN")
    return spark


def write_single_csv(spark, df, path):
    """Écrit `df` en un seul fichier CSV nommé exactement `path` (local ou s3a://), via l'API Hadoop FS."""
    tmp = path + "._tmp"
    df.coalesce(1).write.mode("overwrite").option("header", True).csv(tmp)
    jvm = spark._jvm
    conf = spark._jsc.hadoopConfiguration()
    src_dir = jvm.org.apache.hadoop.fs.Path(tmp)
    fs = src_dir.getFileSystem(conf)
    part = [s.getPath() for s in fs.listStatus(src_dir) if s.getPath().getName().startswith("part-")][0]
    dst = jvm.org.apache.hadoop.fs.Path(path)
    fs.delete(dst, False)
    fs.rename(part, dst)
    fs.delete(src_dir, True)


def write_text(spark, text, path):
    """Écrit un petit fichier texte (config, classes…) dans le data lake."""
    jvm = spark._jvm
    p = jvm.org.apache.hadoop.fs.Path(path)
    out = p.getFileSystem(spark._jsc.hadoopConfiguration()).create(p, True)
    out.write(bytearray(text.encode()))
    out.close()
