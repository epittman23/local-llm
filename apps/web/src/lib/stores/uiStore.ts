import { create } from 'zustand';

// Mirrors apps/openwebui/src/lib/stores/index.ts's `showSidebar` writable +
// its localStorage.sidebar persistence (see layout/Sidebar.svelte's own
// onMount/subscribe pair) -- boolean, defaulting closed, one localStorage key.
const readPersistedSidebarOpen = () => {
	if (typeof localStorage === 'undefined') return false;
	return localStorage.sidebar === 'true';
};

type UIState = {
	sidebarOpen: boolean;
	setSidebarOpen: (open: boolean) => void;
	toggleSidebar: () => void;
};

export const useUIStore = create<UIState>((set, get) => ({
	sidebarOpen: readPersistedSidebarOpen(),
	setSidebarOpen: (open) => {
		if (typeof localStorage !== 'undefined') localStorage.sidebar = String(open);
		set({ sidebarOpen: open });
	},
	toggleSidebar: () => get().setSidebarOpen(!get().sidebarOpen)
}));
