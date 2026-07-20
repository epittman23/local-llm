"""
FastAPI entrypoint for the web frontend.

Thin app shell: CORS + router registration only. All request handling lives
in src/api/; all assistant logic lives in src/assistant.py, shared with the
CLI (main.py). Run with: uvicorn server:app --reload --port 8000
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.api.routes_chat import router as chat_router
from src.api.routes_sessions import router as sessions_router

app = FastAPI(title="home-llm API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat_router)
app.include_router(sessions_router)
