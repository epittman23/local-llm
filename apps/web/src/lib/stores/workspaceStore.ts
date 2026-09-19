import { create } from 'zustand';

// Ports `workspaceCounts` / `workspaceActions` from
// apps/openwebui/src/lib/stores/index.ts. Each section page reports its own
// total up to the layout's tab bar and registers the actions the layout's
// split "Create" button shows -- the layout never asks a section what it
// contains, the section tells the layout.
export type WorkspaceSection = 'models' | 'knowledge' | 'prompts' | 'skills' | 'tools';

export type WorkspaceAction = {
	id: string;
	label: string;
	href?: string;
	onClick?: () => void | Promise<void>;
	visible?: boolean;
};

type WorkspaceState = {
	counts: Record<WorkspaceSection, number | null>;
	actions: WorkspaceAction[];
	setCount: (section: WorkspaceSection, count: number | null) => void;
	setCounts: (counts: Record<WorkspaceSection, number | null>) => void;
	setActions: (actions: WorkspaceAction[]) => void;
};

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
	counts: { models: null, knowledge: null, prompts: null, skills: null, tools: null },
	actions: [],
	setCount: (section, count) => set((s) => ({ counts: { ...s.counts, [section]: count } })),
	setCounts: (counts) => set({ counts }),
	setActions: (actions) => set({ actions })
}));
