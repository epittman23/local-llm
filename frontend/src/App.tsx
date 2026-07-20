import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { Sidebar } from "./components/Sidebar";
import { TaskSelector } from "./components/TaskSelector";
import { ChatPane } from "./components/ChatPane";
import { createBackendAdapter } from "./lib/chat-adapter";
import { createSession, getSessionMessages, type Task } from "./lib/api";

function App() {
  const [session, setSession] = useState<string | null>(null);
  const [task, setTask] = useState<Task>("reasoning");
  const [initialMessages, setInitialMessages] = useState<ThreadMessageLike[]>([]);
  const [chatKey, setChatKey] = useState(0);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);

  const stateRef = useRef({ session, task });
  stateRef.current = { session, task };

  const adapter = useRef(
    createBackendAdapter(
      () => stateRef.current,
      () => setSidebarRefreshKey((k) => k + 1),
    ),
  ).current;

  const handleNewChat = useCallback(async () => {
    const { name } = await createSession();
    setSession(name);
    setInitialMessages([]);
    setChatKey((k) => k + 1);
  }, []);

  const handleSelectSession = useCallback(async (name: string) => {
    const messages = await getSessionMessages(name);
    setSession(name);
    setInitialMessages(messages as ThreadMessageLike[]);
    setChatKey((k) => k + 1);
  }, []);

  // Start with a fresh session on first load, same as clicking "New chat".
  // Guarded against StrictMode's dev-mode double-invoke, which would
  // otherwise create two empty session directories per page load.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    handleNewChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-full w-full">
      <Sidebar
        currentSession={session}
        onSelectSession={handleSelectSession}
        onNewChat={handleNewChat}
        refreshKey={sidebarRefreshKey}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <span className="text-sm font-medium text-muted-foreground">
            {session ?? "New chat"}
          </span>
          <TaskSelector value={task} onChange={setTask} />
        </header>
        <div className="min-h-0 flex-1">
          <ChatPane key={chatKey} adapter={adapter} initialMessages={initialMessages} />
        </div>
      </div>
    </div>
  );
}

export default App;
