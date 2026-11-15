import { create } from 'zustand';

// Mirrors d863707:apps/openwebui/src/lib/stores/index.ts's `showSidebar` writable +
// its localStorage.sidebar persistence (see layout/Sidebar.svelte's own
// onMount/subscribe pair): a boolean in one localStorage key. Unlike Open
// WebUI it starts open (#930): only a person who has closed it finds it
// closed. Below md the aside is hidden and the drawer has its own state, so
// this decides nothing on a phone.
const readPersistedSidebarOpen = () => {
	try {
		return localStorage.sidebar !== 'false';
	} catch {
		return true;
	}
};

type UIState = {
	/** The chat controls panel (Phase 10g). */
	controlsOpen: boolean;
	setControlsOpen: (open: boolean) => void;
	/** The chat search dialog (Ctrl/Cmd+K, or Search in the sidebar). */
	searchOpen: boolean;
	setSearchOpen: (open: boolean) => void;
	sidebarOpen: boolean;
	setSidebarOpen: (open: boolean) => void;
	toggleSidebar: () => void;
};

export const useUIStore = create<UIState>((set, get) => ({
	controlsOpen: false,
	setControlsOpen: (controlsOpen) => set({ controlsOpen }),
	searchOpen: false,
	setSearchOpen: (searchOpen) => set({ searchOpen }),
	sidebarOpen: readPersistedSidebarOpen(),
	setSidebarOpen: (open) => {
		if (typeof localStorage !== 'undefined') localStorage.sidebar = String(open);
		set({ sidebarOpen: open });
	},
	toggleSidebar: () => get().setSidebarOpen(!get().sidebarOpen)
}));
