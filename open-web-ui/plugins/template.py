"""
title: Generic Open WebUI Plugin Scaffold
author: Your Name
author_url: https://github.com
version: 1.0.0
description: A modular boilerplate showcasing Valves, Filter Hooks, Actions, and Pipes.
required_open_webui_version: 0.3.10
"""

from pydantic import BaseModel, Field
from typing import List, Dict, Any, Generator, Iterator, Union, Optional
import logging

# Configure local logging to surface debugging statements in your server/Docker console
logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG)


class Pipe:
    class Valves(BaseModel):
        """
        Admin-configurable parameters. Open WebUI automatically converts these
        into UI forms (inputs, toggles, dropdowns) in the Admin Panel settings dashboard.
        """

        api_key: str = Field(
            default="",
            description="Your external service secret API key or authentication token.",
        )
        debug_mode: bool = Field(
            default=False,
            description="Enable detailed console output logging for debugging.",
        )
        output_limit: int = Field(
            default=3,
            description="A numerical configuration slider or value constraint.",
            ge=1,
            le=10,  # Enforces lower-bound and upper-bound constraints
        )

    def __init__(self):
        """
        Initializes the instance of the extension. Runs exactly once when the
        Open WebUI backend boots or when the code is hot-reloaded.
        """
        self.valves = self.Valves()
        # Allocate persistent shared memory or local database connections here
        if self.valves.debug_mode:
            logger.debug("Plugin initialized in debug mode.")

    async def on_startup(self):
        """Triggered asynchronously when the server starts up."""
        pass

    async def on_shutdown(self):
        """Triggered asynchronously when the server shuts down."""
        pass

    # =========================================================================
    # SECTION A: INLET & OUTLET FILTERS
    # Use filters to process or intercept text arrays mid-flight.
    # =========================================================================

    async def inlet(self, body: dict, __user__: Optional[dict] = None) -> dict:
        """
        Intercepts data incoming from the user client right before it hits the LLM engine.
        :param body: The entire request payload dictionary (contains model, messages, temperature, etc.)
        :param __user__: Extracted dictionary containing the current logged-in user profile attributes.
        """
        if self.valves.debug_mode:
            logger.debug(f"Intercepting user input. Current context user: {__user__}")

        # Example transformation: Append an internal system constraint instruction hidden from the user view
        messages = body.get("messages", [])
        if messages:
            # Modify the latest user message block
            pass

        return body

    async def outlet(self, body: dict, __user__: Optional[dict] = None) -> dict:
        """
        Intercepts raw LLM response chunks or final text arrays right before rendering on user screen.
        """
        # Example transformation: Strip, clean, or run analytics validation logic against output arrays
        return body

    # =========================================================================
    # SECTION B: MODEL ACTIONS / AGENTIC TOOLS
    # Functions that the LLM can actively choose to call based on their docstrings.
    # =========================================================================

    async def execute_sample_action(
        self, query: str, __event_emitter__: Optional[Any] = None
    ) -> str:
        """
        Execute an abstract sample system helper tool or API request lookup action.
        The LLM reads this exact docstring description text to determine when to call this.

        :param query: The contextual look-up search parameter extracted by the model.
        """
        if __event_emitter__:
            # Emits an interactive, real-time loading UI status bubble into the active user chat window
            await __event_emitter__(
                {
                    "type": "status",
                    "data": {
                        "description": f"Processing generic scaffold query: {query}",
                        "done": False,
                    },
                }
            )

        try:
            # Business logic goes here...
            result = f"Successfully executed tool function logic with input: '{query}'."

            if __event_emitter__:
                await __event_emitter__(
                    {
                        "type": "status",
                        "data": {"description": "Task complete!", "done": True},
                    }
                )
            return result

        except Exception as e:
            logger.error(f"Error executing sample action: {str(e)}")
            return f"Action execution failed due to an error: {str(e)}"

    # =========================================================================
    # SECTION C: UNIFIED PIPELINE (THE EXECUTION HANDLER)
    # Allows this class to manifest as a selectable 'Model' in the interface.
    # =========================================================================

    def pipe(self, body: dict, __user__: dict) -> Union[str, Generator, Iterator]:
        """
        Fires when a user selects this extension as their active Chat Model.
        It bypasses default LLM behavior, allowing your Python code to completely control the output loop.
        """
        if self.valves.debug_mode:
            logger.debug(f"Direct pipe executed by user: {__user__.get('name')}")

        # Returns string text directly to the UI panel layout natively
        return "Hello from the generic pipeline scaffold execution block!"
