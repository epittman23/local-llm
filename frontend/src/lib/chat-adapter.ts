import { createParser } from "eventsource-parser";
import type {
  ChatModelAdapter,
  ChatModelRunOptions,
  TextMessagePart,
  ThreadMessage,
} from "@assistant-ui/react";
import type { Task } from "./api";

function lastUserText(messages: readonly ThreadMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  return last.content
    .filter((p): p is TextMessagePart => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export function createBackendAdapter(
  getState: () => { session: string | null; task: Task },
  onComplete?: () => void,
): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }: ChatModelRunOptions) {
      const { session, task } = getState();
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        signal: abortSignal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session,
          task,
          prompt: lastUserText(messages),
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`Chat request failed: ${res.status}`);
      }

      let text = "";
      let error: string | null = null;
      let done = false;

      const parser = createParser({
        onEvent(event) {
          const payload = JSON.parse(event.data) as StreamEvent;
          if (payload.type === "delta") {
            text += payload.text;
          } else if (payload.type === "error") {
            error = payload.message;
          } else if (payload.type === "done") {
            done = true;
          }
        },
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { value, done: readerDone } = await reader.read();
        if (value) {
          parser.feed(decoder.decode(value, { stream: true }));
        }
        if (error) throw new Error(error);
        if (text) yield { content: [{ type: "text" as const, text }] };
        if (done || readerDone) break;
      }

      onComplete?.();
    },
  };
}
