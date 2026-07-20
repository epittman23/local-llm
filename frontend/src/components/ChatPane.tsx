import type { FC } from "react";
import { AssistantRuntimeProvider, useLocalRuntime, type ChatModelAdapter, type ThreadMessageLike } from "@assistant-ui/react";
import { Thread } from "./thread";

export const ChatPane: FC<{
  adapter: ChatModelAdapter;
  initialMessages: ThreadMessageLike[];
}> = ({ adapter, initialMessages }) => {
  const runtime = useLocalRuntime(adapter, { initialMessages });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
};
