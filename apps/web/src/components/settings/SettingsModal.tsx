import { ChevronLeft, Search } from 'lucide-react';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { Spinner } from '@/components/common/Spinner';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { cn } from '@/lib/utils';
import { AdminTabIcon } from './AdminTabIcon';
import { adminTabComponents, implementedTabIds } from './adminTabComponents';
import { adminTabSegment, availableTabs, filterTabs, resolveTab, startsGroup } from './settingsTabs';

const tabButtonClass = (active: boolean) =>
	cn(
		'flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-left text-xs transition-colors duration-75 md:w-full',
		active ? 'bg-muted text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'
	);

/**
 * Ports chat/SettingsModal.svelte, the admin half: a searchable, grouped tab
 * list beside the selected tab. It is mounted once by AppShell and opened from
 * the store (`?settings=admin:<tab>` deep links, the user menu). The personal
 * tabs -- General, Interface, Account, ... -- arrive with the chat surface
 * (Phase 10) as more entries in the same registry.
 *
 * Search filters as you type (100ms in the original; instant here, the list is
 * sixteen strings). If the selected tab is filtered away the first match is
 * shown, and a non-admin gets no admin tabs.
 */
export function SettingsModal() {
	const open = useSettingsModalStore((s) => s.open);
	const requestedTab = useSettingsModalStore((s) => s.requestedTab);
	const closeSettings = useSettingsModalStore((s) => s.closeSettings);
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	const [search, setSearch] = useState('');
	const [selected, setSelected] = useState<string | null>(null);

	const tabs = useMemo(() => availableTabs(user, config, implementedTabIds), [user, config]);
	const filtered = useMemo(() => filterTabs(tabs, search), [tabs, search]);

	// A fresh open starts unfiltered on the requested tab.
	useEffect(() => {
		if (!open) return;
		setSearch('');
		setSelected(resolveTab(requestedTab, null, tabs));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, requestedTab]);

	// The selection follows the filter (and the tab list, when config changes it).
	useEffect(() => {
		setSelected((current) => resolveTab(null, current, filtered));
	}, [filtered]);

	if (tabs.length === 0) return null;
	const Active = selected ? adminTabComponents[selected] : null;

	return (
		<Dialog open={open} onOpenChange={(o) => !o && closeSettings()}>
			<DialogContent
				showCloseButton={false}
				className="flex h-[min(max(54rem,80dvh),calc(100dvh-4rem))] max-h-[calc(100dvh-4rem)] w-[calc(100vw-2rem)] max-w-[80rem] gap-0 overflow-hidden p-0 sm:max-w-[80rem] max-md:flex-col"
			>
				<DialogTitle className="sr-only">Settings</DialogTitle>
				<DialogDescription className="sr-only">Administrator settings.</DialogDescription>

				<nav id="settings-tabs-container" className="flex min-w-0 shrink-0 border-b md:min-h-0 md:w-[15rem] md:flex-col md:border-r md:border-b-0">
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground m-1 flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs transition-colors md:mb-0 md:w-[calc(100%-0.5rem)]"
						onClick={closeSettings}
					>
						<ChevronLeft className="size-3" strokeWidth={2} />
						<span>Back</span>
					</button>
					<div className="bg-muted/60 mx-1 mt-1 mb-0.5 hidden h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs md:flex">
						<Search className="size-3.5" strokeWidth={1.5} />
						<label className="sr-only" htmlFor="search-input-settings-modal">
							Search
						</label>
						<input
							id="search-input-settings-modal"
							className="w-full bg-transparent py-1 text-xs outline-hidden"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Search"
						/>
					</div>
					<div role="tablist" aria-orientation="vertical" className="flex min-h-0 min-w-0 flex-1 gap-px overflow-x-auto p-1 pl-0 md:flex-col md:overflow-x-hidden md:overflow-y-auto md:pl-1">
						<span className="text-muted-foreground mt-1.5 mb-0.5 hidden px-2 text-[0.625rem] md:block">Admin</span>
						{filtered.map((tab, index) => (
							<div key={tab.id} className="contents">
								{startsGroup(filtered, index) && (
									<span className={cn('text-muted-foreground hidden shrink-0 px-2 text-[0.625rem] md:block', index === 0 ? 'mt-0.5' : 'mt-2', 'mb-0.5')}>{tab.group}</span>
								)}
								<button
									type="button"
									role="tab"
									aria-selected={selected === tab.id}
									aria-controls={`tab-${tab.id.replace(':', '-')}`}
									className={tabButtonClass(selected === tab.id)}
									onClick={() => setSelected(tab.id)}
								>
									<AdminTabIcon id={adminTabSegment(tab.id)} />
									<span>{tab.title}</span>
								</button>
							</div>
						))}
						{filtered.length === 0 && <div className="text-muted-foreground px-2 py-1 text-xs">No matches</div>}
					</div>
				</nav>

				<div className="flex min-h-0 min-w-0 flex-1 flex-col p-4 md:px-5">
					<div id={selected ? `tab-${selected.replace(':', '-')}` : undefined} role="tabpanel" className="min-h-0 flex-1 overflow-hidden">
						{Active && (
							<Suspense
								fallback={
									<div className="flex h-full items-center justify-center">
										<Spinner className="size-6" />
									</div>
								}
							>
								<Active key={selected} />
							</Suspense>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
