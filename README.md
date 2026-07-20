# Personal AI Assistant

A personal AI assistant prototyped on cloud-hosted open-weight models via
OpenRouter, structured so it can migrate to local, self-hosted inference
later with minimal code changes. See `CLAUDE.md` for the full project
rationale.

The project has two parts, each a self-contained sibling project:

- `backend/` — the Python assistant logic, a CLI (`main.py`), and a FastAPI
  server (`server.py`) that powers the web frontend.
- `frontend/` — a Bun-managed React web UI (built on
  [assistant-ui](https://www.assistant-ui.com)) that talks to the FastAPI
  server.

The CLI works completely standalone; the frontend/API server are optional.

## Backend setup

1. Create a virtual environment (recommended):
   ```bash
   cd backend
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Set up your API key:
   ```bash
   cp .env.example .env
   ```
   Then edit `.env` and add your OpenRouter API key (from
   https://openrouter.ai/keys).

## CLI usage

Run these from the `backend/` directory (or prefix with `backend/`, e.g.
`python backend/main.py ...`, from the repo root):

```bash
# Math/statistics/reasoning question (default)
python main.py "What is the standard error of the mean for a sample of 30?"

# Coding question
python main.py --task coding "Write a Python function to compute a rolling average"

# Try the alternative reasoning model instead of the default
python main.py --task reasoning_alt "Prove that the sum of two even numbers is even"
```

## Conversation memory

By default, each query is a one-off with no memory of prior turns. To have
the assistant remember context across queries, use `--session <name>`:

```bash
python main.py --session math-help "What's a p-value?"
python main.py --session math-help "How does that relate to a confidence interval?"
```

The second query will have the first exchange in context. Session history is
saved to `backend/sessions/<name>/` and persists across separate runs of the
script, not just within one run.

For a continuous back-and-forth without re-invoking the script each time, use
interactive chat mode:

```bash
python main.py --chat --session math-help --task reasoning
```

Type `exit` or press Ctrl+D to leave the chat.

## Web frontend

The web frontend replicates a Claude.ai-style chat UI: a sidebar of saved
sessions, a task (model) selector, and a streaming chat pane. It talks to the
FastAPI server, which shares the same `Conversation`/session storage as the
CLI — a session started on the command line can be continued in the browser,
and vice versa.

Start the API server (from `backend/`, with dependencies installed as above):

```bash
uvicorn server:app --reload --port 8000
```

In a separate terminal, start the frontend (requires [Bun](https://bun.sh)):

```bash
cd frontend
bun install
bun run dev
```

Then open the URL Vite prints (default `http://localhost:5173`).

## Comparing models (A/B evaluation)

Every query — from the CLI or the web UI — is logged to
`backend/logs/usage.jsonl`, recording which model handled it, how long it
took, and how many tokens were used. This is what lets you decide between
`REASONING_MODEL` and `REASONING_MODEL_ALT` based on your own actual queries
rather than published benchmarks.

To see a summary:

```bash
cd backend
python scripts/analyze_logs.py
```

This prints, per model: number of queries, average latency, and average total
tokens used. Note that this captures speed and verbosity, not correctness;
you will still need to judge answer quality yourself, since that isn't
something a log file can measure. Record any conclusions in the "Decisions
log" section of `CLAUDE.md` so future sessions retain that context.

Neither `backend/sessions/` nor `backend/logs/` are committed to version
control (see `.gitignore`), since they may contain the actual content of your
queries.

## Project structure

```
.
├── CLAUDE.md              # Project context for Claude Code sessions
├── README.md
├── backend/
│   ├── requirements.txt
│   ├── .env.example        # Template for required environment variables
│   ├── .env                # Your actual key (not committed, see .gitignore)
│   ├── main.py              # CLI entrypoint (single-query and --chat modes)
│   ├── server.py             # FastAPI app powering the web frontend
│   ├── src/
│   │   ├── config.py         # Reads model names and API key from environment
│   │   ├── assistant.py      # Routes requests to the appropriate model, logs usage
│   │   ├── memory.py         # Conversation history, persisted per session
│   │   ├── logging_utils.py  # Per-query usage logging for model A/B comparison
│   │   └── api/               # FastAPI routers/schemas for the web frontend
│   ├── scripts/
│   │   └── analyze_logs.py    # Summarizes logs/usage.jsonl per model
│   ├── sessions/                # Saved conversation histories (not committed)
│   └── logs/                    # Usage logs (not committed)
└── frontend/               # Bun + React + assistant-ui web UI
    ├── package.json
    └── src/
```

## Migrating to local hardware later

When you're ready to self-host, only two things need to change in
`backend/.env`:

- `BASE_URL`: point this at your local server (e.g. `http://localhost:11434/v1`
  for Ollama)
- `OPENROUTER_API_KEY` / `API_KEY`: local servers often don't require a real
  key, but the client still expects the field to be present

No changes to `backend/src/assistant.py`, `backend/main.py`, or
`backend/server.py` should be necessary, since all are written against the
OpenAI-compatible interface that both OpenRouter and common self-hosting
tools (Ollama, vLLM) support.
