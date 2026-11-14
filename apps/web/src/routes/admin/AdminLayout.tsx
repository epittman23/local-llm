import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { SectionSkeleton, type SectionTab, SectionTabs } from '@/components/layout/SectionTabs';
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
	return (
		<div className="flex h-full min-w-0 flex-col">
			<div className="flex flex-col gap-3 border-b px-4 pt-4">
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

/** A sub-tab bar (Users: Overview/Groups; Evaluations: Leaderboard/Feedback). */
export function SubTabs({
	tabs,
	active
}: {
	tabs: { id: string; to: string; label: string; count?: string | null; countClassName?: string }[];
	active: string;
}) {
	return (
		<div className="tabs flex max-w-full flex-row gap-2.5 overflow-x-auto px-2 text-left text-sm font-normal lg:w-50 lg:flex-none lg:flex-col lg:gap-0">
			{tabs.map((tab) => (
				<NavLink
					key={tab.id}
					id={tab.id}
					to={tab.to}
					draggable={false}
					className={cn(
						'flex min-w-fit items-center gap-1.5 rounded-lg px-0.5 py-1 text-right transition select-none lg:flex-none',
						active === tab.id ? '' : 'text-foreground-muted hover:text-foreground'
					)}
				>
					<span>{tab.label}</span>
					{tab.count != null && (
						<span className={cn('text-sm', tab.countClassName ?? 'text-muted-foreground')}>{tab.count}</span>
					)}
				</NavLink>
			))}
		</div>
	);
}
