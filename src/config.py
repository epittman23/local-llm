"""
Central configuration for the assistant.

Model names and the API key are read from environment variables (via .env),
never hardcoded, so switching models -- during A/B evaluation now, or during
the eventual migration to a local, self-hosted endpoint -- requires no code
changes elsewhere in the project.
"""

import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# OpenRouter is OpenAI-API-compatible. When migrating to a local, self-hosted
# server (e.g. Ollama, vLLM), only BASE_URL and API_KEY should need to change.
BASE_URL = os.getenv("BASE_URL", "https://openrouter.ai/api/v1")
API_KEY = os.getenv("OPENROUTER_API_KEY")

CODING_MODEL = os.getenv("CODING_MODEL", "qwen/qwen-2.5-coder-32b-instruct")
REASONING_MODEL = os.getenv("REASONING_MODEL", "deepseek/deepseek-r1-distill-qwen-32b")
REASONING_MODEL_ALT = os.getenv("REASONING_MODEL_ALT", "qwen/qwq-32b")

if not API_KEY:
    raise RuntimeError(
        "OPENROUTER_API_KEY is not set. Copy .env.example to .env and fill in your key."
    )

# Standing instructions sent as the system message at the start of every
# session (and every one-off query). Edit INSTRUCTIONS.txt directly; no code
# change needed to update it.
INSTRUCTIONS_PATH = Path(__file__).resolve().parent.parent / "INSTRUCTIONS.txt"
INSTRUCTIONS = INSTRUCTIONS_PATH.read_text().strip() if INSTRUCTIONS_PATH.exists() else ""
