import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore, useWebUIName } from '@/lib/stores/configStore';
import { cn } from '@/lib/utils';
import { routePaths } from '@/routes/routePaths';
import { adminGate, adminSectionOfPath } from './adminAccess';

const tabClass = (active: boolean) =>
	cn(
		'min-w-fit border-b-2 px-1 pb-2 text-sm transition-colors select-none',
		active ? 'border-foreground text-foreground font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'
	);

/**
 * Ports apps/openwebui/src/routes/(app)/admin/+layout.svelte: the admin-only
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
	const webuiName = useWebUIName();
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

	useEffect(() => {
		document.title = `Admin Panel / ${webuiName}`;
	}, [webuiName]);

	if (!allowed) {
		return (
			<div className="flex flex-1 items-center justify-center p-8">
				<p className="text-muted-foreground text-sm">{settled ? 'Redirecting…' : 'Loading…'}</p>
			</div>
		);
	}

	const section = adminSectionOfPath(pathname);
	return (
		<div className="flex h-full min-w-0 flex-col">
			<nav className="flex gap-4 overflow-x-auto border-b px-4 pt-3">
				<NavLink to={routePaths.admin} className={() => tabClass(section === 'users')}>
					Users
				</NavLink>
				<NavLink to={routePaths.adminEvaluations} className={() => tabClass(section === 'evaluations')}>
					Evaluations
				</NavLink>
				{config?.features?.enable_plugins && (
					<NavLink to={routePaths.adminFunctions} className={() => tabClass(section === 'functions')}>
						Functions
					</NavLink>
				)}
				<NavLink to={routePaths.adminSettings} className={() => tabClass(section === 'settings')}>
					Settings
				</NavLink>
			</nav>
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
						active === tab.id ? '' : 'text-muted-foreground/60 hover:text-foreground'
					)}
				>
					<span>{tab.label}</span>
					{tab.count != null && <span className={cn('text-sm', tab.countClassName ?? 'opacity-60')}>{tab.count}</span>}
				</NavLink>
			))}
		</div>
	);
}
