The two Parquet files contain synthetic scores, five local model families, a
community lookalike, and a non-overall Arena row. Their schemas follow the
publishers' snapshots, using SNAPPY compression. They exercise actual Parquet
decoding without making network requests or copying benchmark measurements.
