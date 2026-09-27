import { create } from 'zustand';

// Mirrors d863707:apps/openwebui/src/lib/stores/index.ts's `showSidebar` writable +
// its localStorage.sidebar persistence (see layout/Sidebar.svelte's own
// onMount/subscribe pair) -- boolean, defaulting closed, one localStorage key.
const readPersistedSidebarOpen = () => {
	if (typeof localStorage === 'undefined') return false;
	return localStorage.sidebar === 'true';
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
