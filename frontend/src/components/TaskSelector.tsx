import type { FC } from "react";
import type { Task } from "../lib/api";
import { cn } from "../lib/utils";

const TASKS: { value: Task; label: string }[] = [
  { value: "reasoning", label: "Reasoning" },
  { value: "coding", label: "Coding" },
  { value: "reasoning_alt", label: "Reasoning (alt)" },
];

export const TaskSelector: FC<{
  value: Task;
  onChange: (task: Task) => void;
  className?: string;
}> = ({ value, onChange, className }) => (
  <select
    value={value}
    onChange={(e) => onChange(e.target.value as Task)}
    className={cn(
      "rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none",
      className,
    )}
  >
    {TASKS.map((t) => (
      <option key={t.value} value={t.value}>
        {t.label}
      </option>
    ))}
  </select>
);
