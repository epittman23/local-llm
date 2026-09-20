import { create } from 'zustand';
import { APP_NAME } from '@/lib/constants';

// A minimal slice of apps/openwebui/src/lib/stores/index.ts's much larger
// `Config` type -- that one carries every feature flag the whole app reads
// (65+ fields); this app only ports the fields an actual page reads so far:
// Phase 5's enable_benchmarks; Phase 6's auth/oauth/onboarding/metadata (all,
// per main.py's own comment, "Public: required by login/signup page
// pre-auth"); Phase 7's enable_plugins, enable_community_sharing and file.max_size. Extend as
// later phases need more of it, rather than porting the whole shape now for
// fields nothing reads yet.
export type BackendConfig = {
	name: string;
	version: string;
	/** Upload limits (max_size is in MB). */
	file?: { max_size?: number | null };
	/** Comma-separated model ids pinned for users who have not chosen their own. */
	default_pinned_models?: string | null;
	onboarding?: boolean;
	/** Present only on licensed builds; `seats` caps the user count. */
	license_metadata?: { seats?: number | null; [key: string]: unknown } | null;
	oauth?: {
		providers?: Record<string, string>;
		auto_redirect?: boolean;
	};
	metadata?: {
		auth_logo_position?: string;
		login_footer?: string;
		[key: string]: unknown;
	};
	features?: {
		enable_benchmarks?: boolean;
		enable_plugins?: boolean;
		enable_community_sharing?: boolean;
		enable_admin_analytics?: boolean;
		enable_admin_chat_access?: boolean;
		auth?: boolean;
		auth_trusted_header?: boolean;
		enable_signup_password_confirmation?: boolean;
		enable_ldap?: boolean;
		enable_signup?: boolean;
		enable_login_form?: boolean;
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

type ConfigState = {
	config: BackendConfig | null;
	setConfig: (config: BackendConfig) => void;
};

export const useConfigStore = create<ConfigState>((set) => ({
	config: null,
	setConfig: (config) => set({ config })
}));

// Ports apps/openwebui/src/lib/stores/index.ts's `WEBUI_NAME` writable: it
// seeds from APP_NAME and is overwritten with the backend's own configured
// instance name once config loads (main.py's `name` field), everywhere the
// SvelteKit app would read `$WEBUI_NAME` rather than the constant directly.
export const useWebUIName = () => useConfigStore((state) => state.config?.name || APP_NAME);
