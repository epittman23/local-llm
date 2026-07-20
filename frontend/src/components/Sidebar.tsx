import { useEffect, useState, type FC } from "react";
import { PlusIcon, MessageSquareIcon } from "lucide-react";
import { listSessions, type SessionInfo } from "../lib/api";
import { cn } from "../lib/utils";

export const Sidebar: FC<{
  currentSession: string | null;
  onSelectSession: (name: string) => void;
  onNewChat: () => void;
  refreshKey: number;
}> = ({ currentSession, onSelectSession, onNewChat, refreshKey }) => {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  useEffect(() => {
    listSessions()
      .then(setSessions)
      .catch(() => setSessions([]));
  }, [refreshKey]);

  return (
    <aside className="flex h-full w-64 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
      <div className="p-3">
        <button
          onClick={onNewChat}
          className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
        >
          <PlusIcon className="size-4" />
          New chat
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        <p className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">Sessions</p>
        <ul className="flex flex-col gap-0.5">
          {sessions.map((s) => (
            <li key={s.name}>
              <button
                onClick={() => onSelectSession(s.name)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent",
                  currentSession === s.name && "bg-accent font-medium",
                )}
              >
                <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{s.name}</span>
              </button>
            </li>
          ))}
          {sessions.length === 0 && (
            <li className="px-2.5 py-2 text-sm text-muted-foreground">No sessions yet</li>
          )}
        </ul>
      </nav>
    </aside>
  );
};
