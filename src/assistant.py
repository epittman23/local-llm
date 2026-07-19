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
from typing import cast
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
    if task not in TASK_MODELS:
        raise ValueError(f"Unknown task '{task}'. Expected one of {list(TASK_MODELS)}.")

    model = TASK_MODELS[task]
    if system is None:
        system = config.INSTRUCTIONS

    if conversation is not None:
        if not conversation.messages and system:
            conversation.add("system", system)
        conversation.add("user", prompt)
        messages = conversation.as_list()
    else:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

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
