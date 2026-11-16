import { useEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { SectionSkeleton, type SectionTab, SectionTabs } from '@/components/layout/SectionTabs';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { cn } from '@/lib/utils';
import { routePaths } from '@/routes/routePaths';
import { adminGate, adminSectionOfPath } from './adminAccess';

/**
 * Ports d863707:apps/openwebui/src/routes/(app)/admin/+layout.svelte: the admin-only
 * gate (plus the plugins-off bounce off /admin/functions) and the tab bar.
 *
 * The Svelte "Users" tab links to bare `/admin` and is active for any
 * `/admin/users*` path; that is kept, so a bookmark to `/admin` keeps working
 * through the index redirect. The Settings "tab" is not a page in this fork:
 * it opens the Settings modal (a `?settings=admin:general` deep link), so it
 * is a link to `/admin/settings` whose redirect does exactly that.
 */
export function AdminLayout() {
	const authStatus = useAuthStore((s) => s.status);
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	const { pathname } = useLocation();
	const navigate = useNavigate();
	const redirected = useRef(false);

	const settled = authStatus === 'authenticated' && config !== null;
	const gate = settled ? adminGate(user, config, pathname) : null;
	const allowed = gate?.allowed === true;
	const redirectTo = gate && !gate.allowed ? gate.redirectTo : null;

	useEffect(() => {
		if (!redirectTo || redirected.current) return;
		redirected.current = true;
		navigate(redirectTo, { replace: true });
	}, [redirectTo, navigate]);

	// A later navigation (e.g. /admin/functions after plugins go off) may need
	// to redirect again, so the once-only latch resets whenever access is fine.
	useEffect(() => {
		if (allowed) redirected.current = false;
	}, [allowed, pathname]);

	if (!allowed) return <SectionSkeleton label="admin" />;

	const section = adminSectionOfPath(pathname);
	const tabs: SectionTab[] = [
		{ to: routePaths.admin, label: 'Users', active: section === 'users' },
		{ to: routePaths.adminEvaluations, label: 'Evaluations', active: section === 'evaluations' },
		...(config?.features?.enable_plugins
			? [{ to: routePaths.adminFunctions, label: 'Functions', active: section === 'functions' }]
			: []),
		{ to: routePaths.adminSettings, label: 'Settings', active: section === 'settings' }
	];
	// LAY-4: on a phone the function editor gets the height the Admin header and
	// tabs would take, as the workspace editors do; its own header has Back.
	const editing = /^\/admin\/functions\/(create|edit)$/.test(pathname);
	return (
		<div className="flex h-full min-w-0 flex-col">
			{editing && <h1 className="sr-only sm:hidden">Admin</h1>}
			<div className={cn('flex flex-col gap-3 border-b px-4 pt-4', editing && 'max-sm:hidden')}>
				<div className="ps-[var(--shell-menu-inset,0px)]">
					<PageHeader title="Admin" description="Accounts, evaluations, functions and settings for this server." />
				</div>
				<SectionTabs label="Admin" tabs={tabs} />
			</div>
			<div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto pb-1">
				<Outlet />
			</div>
		</div>
	);
}

/**
 * A section's sub-tabs (Users: Overview, Groups; Evaluations: Leaderboard,
 * Feedback), #1102, NAV-2: a strip above the content in the `SectionTabs`
 * look, a navigation landmark named by `label`, each count a small secondary
 * badge. It sits in the page gutter (LAY-1).
 */
export function SubTabs({
	tabs,
	active,
	label = 'Sections'
}: {
	tabs: { id: string; to: string; label: string; count?: string | null; countClassName?: string }[];
	active: string;
	/** The landmark's name: "Users sections". */
	label?: string;
}) {
	return (
		<SectionTabs
			label={label}
			className="shrink-0 px-4 pt-2"
			tabs={tabs.map((tab) => ({
				to: tab.to,
				active: active === tab.id,
				label: (
					<>
						<span>{tab.label}</span>
						{/* Names the link "Overview 12", not "Overview12"; the flex gap draws the space. */}
						{tab.count != null && ' '}
						{tab.count != null && (
							<Badge variant="secondary" className={cn('tabular-nums', tab.countClassName)}>
								{tab.count}
							</Badge>
						)}
					</>
				)
			}))}
		/>
	);
}
