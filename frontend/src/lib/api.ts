export type Task = "coding" | "reasoning" | "reasoning_alt";

export type SessionInfo = {
  name: string;
  message_count: number;
  updated_at: number;
};

export type SessionMessage = {
  role: string;
  content: string;
};

export async function listSessions(): Promise<SessionInfo[]> {
  const res = await fetch("/api/sessions");
  if (!res.ok) throw new Error(`Failed to list sessions: ${res.status}`);
  return res.json();
}

export async function createSession(name?: string): Promise<{ name: string }> {
  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name ?? null }),
  });
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
  return res.json();
}

export async function getSessionMessages(name: string): Promise<SessionMessage[]> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(name)}/messages`);
  if (!res.ok) throw new Error(`Failed to load session '${name}': ${res.status}`);
  return res.json();
}
