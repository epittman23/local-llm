import { create } from 'zustand';
import { isAdminTab, serverTabPath } from '@/components/settings/settingsTabs';

// Ports `showSettings` (boolean | tab-id string | { tab, state }) from
// d863707:apps/openwebui/src/lib/stores/index.ts, split into what it really carries:
// whether the modal is open, which tab it was asked for, and an opaque `state`
// handed to that tab (only Admin > Models reads one -- "open on this model").
// Since #951 it also holds the open tab, whether that tab has unsaved changes,
// and a tab switch or close waiting on "Discard changes?". Since S5-D1 the
// server's tabs are pages under Admin: asking for one (`openSettings('admin:…')`,
// a search result, "Server settings") closes the modal and leaves for the page
// (`leaveTo`, which `useSettingsUrl` navigates to, asking first when dirty).
export type SettingsRequest = { tab: string; state?: Record<string, unknown> | null };

/** What waits on the "Discard changes?" question: closing Settings, or opening another tab. */
export type PendingLeave =
	| { kind: 'close' }
	| { kind: 'tab'; tab: string; setting?: string | null }
	| { kind: 'leave'; to: string; state?: Record<string, unknown> | null };

type SettingsModalState = {
	open: boolean;
	/** The tab the modal was last asked to show (a deep link, the user menu); the modal resolves it into `tab`. */
	requestedTab: string | null;
	/** The tab on show; `?settings=` follows it (NAV-1). */
	tab: string | null;
	/** A setting (its `data-setting` slug) to scroll to and flash once its tab has rendered (#1001). */
	setting: string | null;
	tabState: Record<string, unknown> | null;
	/** The open tab has changes that are not saved (FRM-3); leaving it asks first. */
	dirty: boolean;
	pending: PendingLeave | null;
	/** A page to go to now that the modal has closed (a server tab); `useSettingsUrl` navigates and clears it. */
	leaveTo: string | null;
	openSettings: (request?: string | SettingsRequest) => void;
	/** Closes at once, unsaved changes or not: for a tab that navigates away itself. */
	closeSettings: () => void;
	setTab: (tab: string | null, setting?: string | null) => void;
	clearSetting: () => void;
	setTabState: (state: Record<string, unknown> | null) => void;
	setDirty: (dirty: boolean) => void;
	/** Close, unless the tab is dirty: then ask "Discard changes?" first. */
	requestClose: () => void;
	/** Open `tab`, unless the current tab is dirty: then ask first. */
	requestTab: (tab: string, setting?: string | null) => void;
	/**
	 * Close and go to the page at `to`, unless the tab is dirty: then ask first.
	 * `state` is kept as `tabState` for the page's tab ("open on this model").
	 */
	requestLeave: (to: string, state?: Record<string, unknown> | null) => void;
	clearLeave: () => void;
	/** "Discard changes": do what was waiting. */
	confirmLeave: () => void;
	/** "Keep editing": forget it. */
	cancelLeave: () => void;
};

const closed = {
	open: false,
	requestedTab: null,
	tab: null,
	setting: null,
	tabState: null,
	dirty: false,
	pending: null,
	leaveTo: null
};

export const useSettingsModalStore = create<SettingsModalState>((set, get) => ({
	...closed,
	openSettings: (request) => {
		const req = typeof request === 'string' ? { tab: request } : request;
		if (req?.tab && isAdminTab(req.tab)) return get().requestLeave(serverTabPath(req.tab), req.state);
		set({ open: true, requestedTab: req?.tab ?? null, tabState: req?.state ?? null });
	},
	closeSettings: () => set(closed),
	setTab: (tab, setting = null) => set({ tab, setting, dirty: tab === get().tab ? get().dirty : false }),
	clearSetting: () => set({ setting: null }),
	setTabState: (tabState) => set({ tabState }),
	setDirty: (dirty) => set({ dirty }),
	requestClose: () => (get().dirty ? set({ pending: { kind: 'close' } }) : set(closed)),
	requestTab: (tab, setting = null) => {
		if (tab === get().tab) return set({ setting });
		if (get().dirty) return set({ pending: { kind: 'tab', tab, setting } });
		set({ tab, setting, dirty: false });
	},
	requestLeave: (to, state = null) =>
		get().open && get().dirty
			? set({ pending: { kind: 'leave', to, state } })
			: set({ ...closed, leaveTo: to, tabState: state }),
	clearLeave: () => set({ leaveTo: null }),
	confirmLeave: () => {
		const pending = get().pending;
		if (!pending) return;
		if (pending.kind === 'close') return set(closed);
		if (pending.kind === 'leave') return set({ ...closed, leaveTo: pending.to, tabState: pending.state ?? null });
		set({ tab: pending.tab, setting: pending.setting ?? null, dirty: false, pending: null });
	},
	cancelLeave: () => set({ pending: null })
}));
