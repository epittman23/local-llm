import { create } from 'zustand';

// Ports `showSettings` (boolean | tab-id string | { tab, state }) from
// apps/openwebui/src/lib/stores/index.ts, split into what it really carries:
// whether the modal is open, which tab it was asked for, and an opaque `state`
// handed to that tab (only Admin > Models reads one -- "open on this model").
export type SettingsRequest = { tab: string; state?: Record<string, unknown> | null };

type SettingsModalState = {
	open: boolean;
	/** The tab the modal was last asked to show; the modal keeps its own selection after that. */
	requestedTab: string | null;
	tabState: Record<string, unknown> | null;
	openSettings: (request?: string | SettingsRequest) => void;
	closeSettings: () => void;
	setTabState: (state: Record<string, unknown> | null) => void;
};

export const useSettingsModalStore = create<SettingsModalState>((set) => ({
	open: false,
	requestedTab: null,
	tabState: null,
	openSettings: (request) => {
		const req = typeof request === 'string' ? { tab: request } : request;
		set({ open: true, requestedTab: req?.tab ?? null, tabState: req?.state ?? null });
	},
	closeSettings: () => set({ open: false, requestedTab: null, tabState: null }),
	setTabState: (tabState) => set({ tabState })
}));
