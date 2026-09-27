import type { BackendConfig } from '@/lib/stores/configStore';
import type { SessionUser } from '@/lib/stores/authStore';

// Who may open the Phase 9 surfaces. Ported from layout/Sidebar.svelte's
// `isMenuItemVisible`, which is the only place the Svelte app spells these
// out (its pages mostly trust that the link was hidden). Here the sidebar and
// the routes read the same rules, so a URL typed by hand is gated too.
//
// Each is "the backend feature is on, and the user is an admin or holds the
// permission". Notes defaults the permission to allowed; the others do not
// (as in the original).

export type Feature = 'notes' | 'calendar' | 'automations' | 'playground' | 'channels';

type Perms = { features?: Record<string, boolean | undefined> } & Record<string, unknown>;

export function canUseFeature(feature: Feature, user: SessionUser | null, config: BackendConfig | null): boolean {
	if (!user || !config) return false;
	const admin = user.role === 'admin';
	const f = config.features ?? {};
	const perm = (user.permissions as Perms | undefined)?.features ?? {};
	switch (feature) {
		case 'notes':
			return Boolean(f.enable_notes) && (admin || (perm.notes ?? true));
		case 'calendar':
			return Boolean(f.enable_calendar) && (admin || Boolean(perm.calendar));
		case 'automations':
			return Boolean(f.enable_automations) && (admin || Boolean(perm.automations));
		case 'channels':
			return Boolean(f.enable_channels) && (admin || Boolean(perm.channels));
		case 'playground':
			return admin;
	}
}
