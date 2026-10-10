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
- **Vector stores and loaders this install doesn't use** (Milvus, Qdrant,
  Pinecone, Weaviate, Elasticsearch, Oracle, MongoDB, ColBERT, Azure Search,
  Playwright, unstructured) are in the `all` extra, not the default install.
  Each is imported only when configured, so nothing breaks without them;
  RAG uploads of `.rst`/`.xml` files report `unstructured` missing (Excel and
  PowerPoint fall back to pandas / python-pptx). Install them with
  `uv sync --extra all` from `apps/server/`.
- **Chroma isn't installed at all**, not even by `--extra all`: every
  `chromadb` release has unpatched critical advisories (pre-auth code
  injection among them), and upstream's default `VECTOR_DB=chroma` is now
  `pgvector`. The Chroma code is still there; `VECTOR_DB=chroma` works if you
  install `chromadb` yourself, and otherwise stops startup saying so.
  `nltk` and `RestrictedPython` (unused, with unpatched advisories of their
  own) were removed too, on 2026-10-09.

Two dependencies exist for the Benchmarks section: `scikit-learn` widens the
DS-1000 slice, and `pyyaml` is needed for DS-1000 items that round-trip through
YAML. scipy is a hard dependency (the Report page's request fails outright
without it); matplotlib is installed by default but optional in code (the
report falls back to unicode plots).

## Runtime data (`DATA_DIR`)

Uploads, caches, the Benchmarks section's fetched datasets, answer exports and
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
function fails and knowledge uploads are not embedded. Fetch it once by
running the backend without `HF_HUB_OFFLINE` (for example, start uvicorn by
hand with the same environment minus that variable), then go back to
`make backend`. On 2026-10-10 the default model was not cached on this
machine.
