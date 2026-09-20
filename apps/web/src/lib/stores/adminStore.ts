import { create } from 'zustand';

// Ports `adminUserCount`, `adminGroupCount`, `adminLeaderboardCount` and
// `adminFeedbackCount` from apps/openwebui/src/lib/stores/index.ts: the
// numbers shown beside the Users and Evaluations sub-tabs. Each list page
// writes its own total here as it loads; the tab wrappers seed all of them once.
type AdminCounts = {
	users: number | null;
	groups: number | null;
	leaderboard: number | null;
	feedback: number | null;
};

type AdminState = {
	counts: AdminCounts;
	setCount: (key: keyof AdminCounts, value: number | null) => void;
};

export const useAdminStore = create<AdminState>((set) => ({
	counts: { users: null, groups: null, leaderboard: null, feedback: null },
	setCount: (key, value) => set((s) => ({ counts: { ...s.counts, [key]: value } }))
}));
