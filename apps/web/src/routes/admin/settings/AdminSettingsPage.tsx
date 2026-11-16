import { ChevronLeft, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { SettingsPageHost } from '@/components/settings/controls';
import { SETTINGS_PANEL_ID, SettingsNav, settingsTabId } from '@/components/settings/SettingsNav';
import { SettingsTabContent } from '@/components/settings/SettingsTabContent';
import { filterTabs, plainTabTitle, serverTabPath } from '@/components/settings/settingsTabs';
import { useServerTabs } from '@/components/settings/useServerTabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDocumentTitle } from '@/lib/stores/configStore';
import { cn } from '@/lib/utils';

/** The width from which the list and the open tab sit side by side (the Settings dialog's own breakpoint). */
const SIDE_BY_SIDE = '(min-width: 768px)';

/**
 * `/admin/settings[/<tab>]`, the server's settings as pages under Admin
 * (S5-D1, #932): the server half of the Settings tab list beside the open tab,
 * in the Admin layout, so closing nothing leaves Admin. The address names the
 * tab (NAV-1) and the page is titled "<Tab> · Settings" (LAY-5).
 *
 * Below 768 px it is two levels, as the dialog is (#1000): the list with its
 * search at `/admin/settings`, then the tab with a way back. From 768 px the
 * bare address opens the first tab. Unsaved changes are guarded once, by the
 * page (`SettingsPageHost`): another tab is a navigation, so it asks too
 * (FRM-3, #951). A tab this admin cannot open (Pipelines with no pipelines
 * server, an unknown name) goes back to the list.
 */
export function AdminSettingsPage() {
	const { tab: segment } = useParams();
	const navigate = useNavigate();
	const server = useServerTabs();
	const pending = server.pending;
	// Every tab here is the server's: the region says so, so names drop "Server: ".
	const tabs = server.tabs.map((t) => ({ ...t, title: plainTabTitle(t) }));
	const [search, setSearch] = useState('');
	const selected = segment ? `admin:${segment}` : null;
	const open = tabs.find((t) => t.id === selected) ?? null;
	const first = tabs[0]?.id ?? null;

	useDocumentTitle(open ? `${open.title} · Settings` : null);

	useEffect(() => {
		if (selected || !first || !window.matchMedia?.(SIDE_BY_SIDE).matches) return;
		navigate(serverTabPath(first), { replace: true });
	}, [selected, first, navigate]);

	if (selected && !open && !pending) return <Navigate to={serverTabPath()} replace />;

	const listed = filterTabs(tabs, search);
	const searching = search.trim() !== '';
	return (
		// `relative`: what a tab positions out of the flow (a switch's hidden input, a screen-reader-only
		// span) stays inside the page, so the document itself never scrolls.
		<section aria-label="Server settings" className="relative flex h-full min-h-0 max-md:flex-col">
			<div
				className={cn(
					'flex min-h-0 min-w-0 flex-col pt-3 md:w-60 md:shrink-0 md:border-r max-md:flex-1',
					open && 'max-md:hidden'
				)}
			>
				<div className="relative mx-2 mb-2 shrink-0">
					<Search
						aria-hidden
						className="text-foreground-muted pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
					/>
					<Input
						type="search"
						aria-label="Search server settings"
						placeholder="Search server settings"
						className="pl-8"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						autoComplete="off"
					/>
				</div>
				{listed.length > 0 ? (
					<SettingsNav
						tabs={listed}
						selected={open?.id ?? null}
						onSelect={(id) => {
							setSearch('');
							navigate(serverTabPath(id));
						}}
						className="min-h-0 flex-1"
					/>
				) : (
					<div role="status" className="px-4 py-2">
						<p className="text-foreground-muted">
							{searching ? `No server settings match ‘${search.trim()}’.` : 'No server settings to show.'}
						</p>
						{searching && (
							<Button type="button" variant="link" className="px-0" onClick={() => setSearch('')}>
								Clear search
							</Button>
						)}
					</div>
				)}
			</div>
			{open && (
				<div className="flex min-h-0 min-w-0 flex-1 flex-col p-6 max-md:p-4">
					<Button asChild variant="ghost" className="mb-2 self-start md:hidden">
						<Link to={serverTabPath()}>
							<ChevronLeft aria-hidden />
							All server settings
						</Link>
					</Button>
					<div
						id={SETTINGS_PANEL_ID}
						role="tabpanel"
						aria-labelledby={settingsTabId(open.id)}
						className="relative min-h-0 flex-1 overflow-hidden"
					>
						<SettingsPageHost>
							<SettingsTabContent id={open.id} />
						</SettingsPageHost>
					</div>
				</div>
			)}
		</section>
	);
}

/**
 * `/admin/analytics`: Analytics as an Admin tab of its own (S5-D1), no longer
 * a tab of the Settings dialog. Shown while `enable_admin_analytics` is on;
 * `adminGate` sends the address to /admin otherwise.
 */
export function AdminAnalyticsPage() {
	return (
		<section aria-label="Analytics" className="relative h-full min-h-0 px-4 pt-4">
			<SettingsTabContent id="admin:analytics" />
		</section>
	);
}
