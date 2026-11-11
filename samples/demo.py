# Databricks notebook source
# MAGIC %md
# MAGIC # Demo notebook
# MAGIC
# MAGIC Opens in the notebook UI and saves back to this exact `.py` format.

# COMMAND ----------

# MAGIC %run ./helpers/setup

# COMMAND ----------

# DBTITLE 1,Use a function defined by %run
print(greeting("world"))

# COMMAND ----------

# MAGIC %sql
# MAGIC select 1 as id, 'a' as label

# COMMAND ----------

df = spark.range(3)
display(df)
