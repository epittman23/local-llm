import { create } from 'zustand';

// Only the groups Phase 7 reads are typed: `workspace` (the section gate and
// the import/export toggles), `sharing` and `access_grants` (the Access
// button's gates). The backend sends more (chat, features, ...) under the same
// object, which stay untyped until a surface reads them.
export type UserPermissions = {
	workspace?: {
		models?: boolean;
		knowledge?: boolean;
		prompts?: boolean;
		skills?: boolean;
		tools?: boolean;
		[key: string]: boolean | undefined;
	};
	sharing?: { [key: string]: boolean | undefined };
	access_grants?: { allow_users?: boolean };
	[group: string]: unknown;
};

// Mirrors apps/openwebui/src/lib/stores/index.ts's `SessionUser` (the fields
// declared there), plus the two fields the SvelteKit app reads off the same
// object without ever declaring them (`+layout.svelte`'s `$user?.expires_at`
// and the sign-in response's own `token`/`token_type`) -- see this repo's
// docs/CLAUDE.md 2026-09-15 entry on that app's inherited type looseness.
// This is new code, not a port, so it types the whole shape properly.
export type SessionUser = {
	id: string;
	email: string;
	name: string;
	role: string;
	profile_image_url: string;
	permissions?: UserPermissions;
	expires_at?: number;
};

export type AuthStatus = 'pending' | 'authenticated' | 'anonymous';

type AuthState = {
	status: AuthStatus;
	token: string | null;
	user: SessionUser | null;
	setSession: (token: string, user: SessionUser) => void;
	clearSession: () => void;
};

export const useAuthStore = create<AuthState>((set) => ({
	status: 'pending',
	token: null,
	user: null,
	setSession: (token, user) => set({ status: 'authenticated', token, user }),
	clearSession: () => set({ status: 'anonymous', token: null, user: null })
}));
