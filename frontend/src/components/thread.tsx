import {
  ActionBarPrimitive,
  AuiIf,
  type AssistantState,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, CopyIcon, RefreshCwIcon, SquareIcon } from "lucide-react";
import type { FC } from "react";
import { MarkdownText } from "./markdown-text";
import { TooltipIconButton } from "./tooltip-icon-button";
import { cn } from "../lib/utils";

const isNewChatView = (s: AssistantState) => s.thread.messages.length === 0;

export const Thread: FC = () => {
  const isEmpty = useAuiState(isNewChatView);

  return (
    <ThreadPrimitive.Root className="flex h-full flex-col bg-background">
      <ThreadPrimitive.Viewport className="relative flex flex-1 flex-col overflow-y-scroll scroll-smooth">
        <div
          className={cn(
            "mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 pt-4",
            isEmpty && "justify-center",
          )}
        >
          <AuiIf condition={isNewChatView}>
            <ThreadWelcome />
          </AuiIf>

          <div className="mb-14 flex flex-col gap-y-6 empty:hidden">
            <ThreadPrimitive.Messages>{() => <ThreadMessage />}</ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn("flex flex-col gap-4 bg-background pb-4", !isEmpty && "sticky bottom-0 mt-auto")}
          >
            <ThreadScrollToBottom />
            <Composer />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadMessage: FC = () => {
  const role = useAuiState((s) => s.message.role);
  return role === "user" ? <UserMessage /> : <AssistantMessage />;
};

const ThreadScrollToBottom: FC = () => (
  <ThreadPrimitive.ScrollToBottom asChild>
    <TooltipIconButton
      tooltip="Scroll to bottom"
      className="absolute -top-12 self-center rounded-full border border-border bg-background p-4 disabled:invisible"
    >
      <ArrowDownIcon />
    </TooltipIconButton>
  </ThreadPrimitive.ScrollToBottom>
);

const ThreadWelcome: FC = () => (
  <div className="mb-6 flex flex-col items-center px-4 text-center">
    <h1 className="text-2xl font-semibold">How can I help you today?</h1>
  </div>
);

const Composer: FC = () => (
  <ComposerPrimitive.Root className="relative flex w-full flex-col">
    <div className="flex w-full flex-col gap-2 rounded-3xl border border-border bg-muted/40 p-2 shadow-sm">
      <ComposerPrimitive.Input
        placeholder="Send a message..."
        className="max-h-32 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base outline-none placeholder:text-muted-foreground/80"
        rows={1}
        autoFocus
      />
      <ComposerAction />
    </div>
  </ComposerPrimitive.Root>
);

const ComposerAction: FC = () => (
  <div className="flex items-center justify-end">
    <AuiIf condition={(s) => !s.thread.isRunning}>
      <ComposerPrimitive.Send asChild>
        <TooltipIconButton
          tooltip="Send message"
          className="size-7 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
        >
          <ArrowUpIcon />
        </TooltipIconButton>
      </ComposerPrimitive.Send>
    </AuiIf>
    <AuiIf condition={(s) => s.thread.isRunning}>
      <ComposerPrimitive.Cancel asChild>
        <TooltipIconButton
          tooltip="Stop generating"
          className="size-7 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
        >
          <SquareIcon className="fill-current" />
        </TooltipIconButton>
      </ComposerPrimitive.Cancel>
    </AuiIf>
  </div>
);

const MessageError: FC = () => (
  <MessagePrimitive.Error>
    <ErrorPrimitive.Root className="mt-2 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
      <ErrorPrimitive.Message className="line-clamp-2" />
    </ErrorPrimitive.Root>
  </MessagePrimitive.Error>
);

const AssistantMessage: FC = () => (
  <MessagePrimitive.Root className="relative -mb-4 pb-4">
    <div className="px-2 leading-relaxed text-foreground">
      <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      <AuiIf condition={(s) => s.message.status?.type === "running" && s.message.parts.length === 0}>
        <span className="animate-pulse font-sans" aria-label="Assistant is working">
          {"●"}
        </span>
      </AuiIf>
      <MessageError />
    </div>

    <div className="ms-2 flex min-h-7.5 items-center pt-1.5">
      <AssistantActionBar />
    </div>
  </MessagePrimitive.Root>
);

const AssistantActionBar: FC = () => (
  <ActionBarPrimitive.Root
    hideWhenRunning
    autohide="not-last"
    className="flex gap-1 text-muted-foreground"
  >
    <ActionBarPrimitive.Copy asChild>
      <TooltipIconButton tooltip="Copy">
        <AuiIf condition={(s) => s.message.isCopied}>
          <CheckIcon />
        </AuiIf>
        <AuiIf condition={(s) => !s.message.isCopied}>
          <CopyIcon />
        </AuiIf>
      </TooltipIconButton>
    </ActionBarPrimitive.Copy>
    <ActionBarPrimitive.Reload asChild>
      <TooltipIconButton tooltip="Regenerate">
        <RefreshCwIcon />
      </TooltipIconButton>
    </ActionBarPrimitive.Reload>
  </ActionBarPrimitive.Root>
);

const UserMessage: FC = () => (
  <MessagePrimitive.Root className="grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] gap-y-2 px-2 [&:where(>*)]:col-start-2">
    <div className="col-start-2 min-w-0">
      <div className="rounded-2xl bg-muted px-4 py-2 text-foreground empty:hidden">
        <MessagePrimitive.Parts />
      </div>
    </div>
  </MessagePrimitive.Root>
);
