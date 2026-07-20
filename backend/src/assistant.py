"""
Core assistant client.

Routes each request to the appropriate model based on task type, using a
single OpenAI-compatible client pointed at OpenRouter. Swapping to a local,
self-hosted endpoint later only requires changing config.BASE_URL and
config.API_KEY; this module does not need to change.

Supports optional conversation memory (via src.memory.Conversation) and logs
latency/token usage for every query (via src.logging_utils) so different
models can be compared empirically on real usage rather than benchmarks alone.
"""

import time
from typing import cast, Iterator
from openai import OpenAI

from src import config
from src.logging_utils import log_query
from src.memory import Conversation

client = OpenAI(base_url=config.BASE_URL, api_key=config.API_KEY)

# Maps a task type to the model responsible for it. Add more task types here
# as the assistant's use cases grow.
TASK_MODELS = {
    "coding": config.CODING_MODEL,
    "reasoning": config.REASONING_MODEL,
    "reasoning_alt": config.REASONING_MODEL_ALT,
}


def _resolve_model(task: str) -> str:
    if task not in TASK_MODELS:
        raise ValueError(f"Unknown task '{task}'. Expected one of {list(TASK_MODELS)}.")
    return TASK_MODELS[task]


def _prepare_messages(
    prompt: str,
    system: str | None,
    conversation: Conversation | None,
) -> list[dict]:
    if system is None:
        system = config.INSTRUCTIONS

    if conversation is not None:
        if not conversation.messages and system:
            conversation.add("system", system)
        conversation.add("user", prompt)
        return conversation.as_list()

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    return messages


def ask(
    prompt: str,
    task: str = "reasoning",
    system: str | None = None,
    conversation: Conversation | None = None,
) -> str | None:
    """
    Send a prompt to the model assigned to the given task type.

    Args:
        prompt: The user's message.
        task: One of "coding", "reasoning", or "reasoning_alt".
        system: System prompt to prepend. Only used if no conversation is
            supplied, or if the conversation is brand new. Defaults to the
            standing instructions in INSTRUCTIONS.txt (config.INSTRUCTIONS).
        conversation: Optional Conversation instance. If supplied, prior
            turns are included and the new turn is appended and persisted.

    Returns:
        The model's text response.
    """
    model = _resolve_model(task)
    messages = _prepare_messages(prompt, system, conversation)

    start = time.monotonic()
    response = client.chat.completions.create(model=model, messages=messages)
    latency = time.monotonic() - start

    reply = response.choices[0].message.content

    usage = getattr(response, "usage", None)
    log_query(
        task=task,
        model=model,
        prompt=prompt,
        latency_seconds=latency,
        prompt_tokens=getattr(usage, "prompt_tokens", None),
        completion_tokens=getattr(usage, "completion_tokens", None),
    )

    if conversation is not None:
        conversation.add("assistant", cast(str,reply))

    return reply


def ask_stream(
    prompt: str,
    task: str = "reasoning",
    system: str | None = None,
    conversation: Conversation | None = None,
) -> Iterator[str]:
    """
    Like ask(), but yields the reply incrementally as it streams in from the
    model, for UIs that want a token-by-token typing effect. Appends the full
    reply to conversation and logs usage once the stream completes, same as
    ask().

    Args:
        prompt: The user's message.
        task: One of "coding", "reasoning", or "reasoning_alt".
        system: System prompt to prepend. Same semantics as ask().
        conversation: Optional Conversation instance. Same semantics as ask().

    Yields:
        Successive text chunks of the model's response.
    """
    model = _resolve_model(task)
    messages = _prepare_messages(prompt, system, conversation)

    start = time.monotonic()
    stream = client.chat.completions.create(
        model=model,
        messages=messages,
        stream=True,
        stream_options={"include_usage": True},
    )

    chunks: list[str] = []
    usage = None
    for piece in stream:
        if piece.choices and piece.choices[0].delta.content:
            delta = piece.choices[0].delta.content
            chunks.append(delta)
            yield delta
        if getattr(piece, "usage", None):
            usage = piece.usage
    latency = time.monotonic() - start

    reply = "".join(chunks)
    log_query(
        task=task,
        model=model,
        prompt=prompt,
        latency_seconds=latency,
        prompt_tokens=getattr(usage, "prompt_tokens", None),
        completion_tokens=getattr(usage, "completion_tokens", None),
    )

    if conversation is not None:
        conversation.add("assistant", reply)
