# Backend dependencies

This repo has exactly one Python environment now:
`apps/server/.venv`, which `make backend` keeps in sync with
`apps/server/pyproject.toml` + `apps/server/uv.lock` (`uv sync --frozen`)
on every run. Those two files are the only place backend dependencies are
declared; add or change one with `uv add` / `uv lock` from `apps/server/`.

The backend needs **Python 3.12**: `requires-python = ">= 3.12, < 3.13.0a1"`
(3.11 was listed until 2026-10-09, but the pinned scipy 1.18 already needed
3.12, so it never actually installed there). uv picks or downloads a 3.12
interpreter itself, so a newer system `python3` (3.14 on the current Fedora
44 machine) doesn't matter.

What the default install includes, and what it leaves out:

- **torch is the CPU build**, from the PyTorch CPU index (`[tool.uv.sources]`
  in `pyproject.toml`). It only runs sentence-transformers' embedding and
  reranking models here; llama-server does inference. A CUDA build added
  ~5 GB and competed with llama-server for VRAM.
- **pgvector is the only vector store.** It lives in the app's own Postgres.
  The twelve other stores the inherited code supported (Chroma, Milvus,
  Qdrant, Pinecone, Weaviate, Elasticsearch, OpenSearch, Oracle 23ai,
  MariaDB, openGauss, S3 Vectors, Valkey) were removed on 2026-10-17, along
  with their dependencies. Any other `VECTOR_DB` value stops startup.
- **Loaders and integrations this install doesn't use** (the Qdrant and
  Milvus clients for external knowledge connections, MongoDB, ColBERT, Azure
  Search, Playwright, unstructured) are in the `all` extra, not the default
  install.
  Each is imported only when configured, so nothing breaks without them;
  RAG uploads of `.rst`/`.xml` files report `unstructured` missing (Excel and
  PowerPoint fall back to pandas / python-pptx). Install them with
  `uv sync --extra all` from `apps/server/`.
- **`nltk` and `RestrictedPython`** (unused, with unpatched advisories of
  their own) were removed on 2026-10-09.

Two dependencies exist for the Benchmarks section: `scikit-learn` widens the
DS-1000 slice, and `pyyaml` is needed for DS-1000 items that round-trip through
YAML. scipy is a hard dependency (the Report page's request fails outright
without it), and so is statsmodels (added 2026-10-19), which supplies the
cluster-robust errors, Wilson intervals, exact McNemar and Holm behind Compare
and Report. The estimators that use it are imported on first use rather than
at backend startup, since statsmodels and the parts of scipy it loads take
about three seconds to import. matplotlib is installed by
default but optional in code (the report falls back to unicode plots).

## Runtime data (`DATA_DIR`)

Uploads, caches, the Benchmarks section's grader calibrations and LiveCodeBench's fetched increments (the other benchmarks are vendored), answer exports and
reports live under `DATA_DIR`. `make backend` pins it to `apps/server/data`
(gitignored) instead of relying on `env.py`'s default, because that default
is relative to the package and moved once already, when `apps/server/backend/`
was flattened; a moved default would silently start the backend on an empty
directory. Override it with `make backend DATA_DIR=/some/where`. Chats,
accounts, settings and benchmark results are in Postgres, not here.

## Offline model cache

`make backend` sets `HF_HUB_OFFLINE=1`, so the backend never reaches Hugging
Face at runtime. The sentence-transformers embedding model
(`RAG_EMBEDDING_MODEL`, default `sentence-transformers/all-MiniLM-L6-v2`) and
any reranking model must therefore already be in the local Hugging Face cache.
If one is missing, the backend still starts, but loading the embedding
function fails and knowledge uploads are not embedded. Fetch a model once
with the backend's own `hf`, outside `make backend`:

```sh
cd apps/server
HF_HUB_OFFLINE=0 .venv/bin/hf download BAAI/bge-m3 --exclude "onnx/*" --exclude "imgs/*"
```

Give each pattern its own `--exclude`: `hf download` reads a second
pattern after one `--exclude` as a file name to fetch, and then downloads
only metadata. The models in use since 2026-10-24 (`BAAI/bge-m3` and
`BAAI/bge-reranker-v2-m3`) are in
[assistant-tools.md](assistant-tools.md#knowledge-retrieval).
