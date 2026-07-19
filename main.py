"""
Simple command-line entrypoint for the personal assistant.

Usage:
    python main.py "your question here"                   # defaults to reasoning
    python main.py --task coding "write a function..."
    python main.py --task reasoning_alt "solve this..."    # test QwQ-32B instead
    python main.py --session math-help "what's a p-value?" # remembers this session
    python main.py --chat --session math-help              # interactive mode
"""

import argparse

from src.assistant import ask
from src.memory import Conversation


def main():
    parser = argparse.ArgumentParser(description="Personal AI assistant CLI")
    parser.add_argument(
        "prompt", nargs="?", help="The question or request to send (omit if using --chat)"
    )
    parser.add_argument(
        "--task",
        choices=["coding", "reasoning", "reasoning_alt"],
        default="reasoning",
        help="Which model to route this request to (default: reasoning)",
    )
    parser.add_argument(
        "--session",
        default=None,
        help="Name of a session to remember across calls (persisted to sessions/<name>.json). "
        "Omit for a one-off, memory-less query.",
    )
    parser.add_argument(
        "--chat",
        action="store_true",
        help="Start an interactive REPL instead of a single query. Requires --session.",
    )
    args = parser.parse_args()

    conversation = Conversation(session=args.session) if args.session else None

    if args.chat:
        if conversation is None:
            parser.error("--chat requires --session so the conversation can be tracked")
        print(f"Chatting in session '{args.session}' with task '{args.task}'. "
              f"Type 'exit' to quit.")
        while True:
            try:
                user_input = input("\nyou> ").strip()
            except (EOFError, KeyboardInterrupt):
                break
            if user_input.lower() in {"exit", "quit"}:
                break
            if not user_input:
                continue
            reply = ask(user_input, task=args.task, conversation=conversation)
            print(f"\nassistant> {reply}")
        return

    if not args.prompt:
        parser.error("a prompt is required unless --chat is used")

    response = ask(args.prompt, task=args.task, conversation=conversation)
    print(response)


if __name__ == "__main__":
    main()
