# Personal AI Assistant

A personal AI assistant running on cloud-hosted open-weight models via
OpenRouter, using [Open WebUI](https://github.com/open-webui/open-webui) as
the chat interface. See `CLAUDE.md` for the full project rationale.

Open WebUI runs in Docker and talks directly to OpenRouter's OpenAI-compatible
API — there is no custom backend or frontend code in this repo; Open WebUI
*is* the app.

## Running it

Requires Docker Desktop with WSL integration enabled for this distro
(Docker Desktop → Settings → Resources → WSL Integration).

```bash
docker run -d \
  -p 3000:8080 \
  -e OPENAI_API_BASE_URL=https://openrouter.ai/api/v1 \
  -e OPENAI_API_KEY=<your OpenRouter API key, from https://openrouter.ai/keys> \
  -v open-webui:/app/backend/data \
  --name open-webui \
  --restart unless-stopped \
  ghcr.io/open-webui/open-webui:main
```

Then open `http://localhost:3000`. The first account you create becomes the
admin. Chat history, settings, and the model list are persisted in the
`open-webui` Docker volume.

## Model setup

Under **Workspace → Models**, this project defines one Open WebUI model entry
per task, each wrapping a specific OpenRouter model id:

- **Coding** → `qwen/qwen-2.5-coder-32b-instruct`
- **Reasoning** → `qwen/qwen3.6-27b`

Both models are configured (per-model, in the System Prompt field) with the
following instructions:

```
Please use a formal, professional tone. When applicable, try to explain solutions and their steps.
Be informative and delve into topics to enhance learning and further understanding.
Please prioritize accuracy and correctness for all responses.
If there are any assumptions you make for any response please clearly state them and do not hesitate to ask clarifying questions before providing a full response.
Never use em-dashes, instead use standard punctuation such as colons and semicolons.
```

Model choices and reasoning for changing them are logged in the "Decisions
log" section of `CLAUDE.md`.

## Migrating to local hardware later

When ready to self-host (e.g. Ollama, vLLM), update the connection under
**Admin Panel → Settings → Connections**: change the base URL to your local
server's OpenAI-compatible endpoint (e.g. `http://localhost:11434/v1` for
Ollama), and update the API key if your local server requires one. No other
changes should be necessary, since Open WebUI talks to any OpenAI-compatible
endpoint.
