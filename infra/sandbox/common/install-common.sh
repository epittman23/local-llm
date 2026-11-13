#!/usr/bin/env bash
# The tools both sandbox images share. Runs once, as root, at build time
# (Dockerfile.data and Dockerfile.web COPY this file and run it).
#
# apt packages float with the base image's distribution release: an old
# apt version is dropped from the archive, so pinning one would break
# rebuilds. What is pinned is the base image (tag and digest, for both), the
# DuckDB release and its checksum, and everything the Dockerfiles install
# beyond this script; image-freeze.txt and image-freeze-r.txt record what actually landed.
set -euo pipefail

DUCKDB_VERSION=2.0.0
# SHA-256 of duckdb-cli-linux-amd64.tar.gz, as GitHub lists it for the release.
DUCKDB_SHA256=c6507206baf7793c6013dbd82368469a45f20dc0e17a6f92f204602f652ed2bc

export DEBIAN_FRONTEND=noninteractive
apt-get update
# tini is the sandbox's init: it reaps the processes a call leaves behind.
apt-get install -y --no-install-recommends \
    bash ca-certificates curl file git poppler-utils procps sqlite3 tini xxd
rm -rf /var/lib/apt/lists/*

tmp="$(mktemp -d)"
curl -fsSL -o "$tmp/duckdb.tar.gz" \
    "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/duckdb-cli-linux-amd64.tar.gz"
echo "${DUCKDB_SHA256}  $tmp/duckdb.tar.gz" | sha256sum -c -
tar -xzf "$tmp/duckdb.tar.gz" -C "$tmp" duckdb
install -m 0755 -o root -g root "$tmp/duckdb" /usr/local/bin/duckdb
rm -rf "$tmp"

duckdb --version
tini --version
