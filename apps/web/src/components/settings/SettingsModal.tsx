import { ChevronLeft, Search } from 'lucide-react';
import {
	Component,
	type ComponentType,
	type KeyboardEvent,
	type LazyExoticComponent,
	lazy,
	type ReactNode,
	Suspense,
	useEffect,
	useMemo,
	useRef,
	useState
} from 'react';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore, useDocumentTitle } from '@/lib/stores/configStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { cn } from '@/lib/utils';
import { implementedTabIds, tabLoaders } from './adminTabComponents';
import { settingSlug } from './controls';
import { SETTINGS_PANEL_ID, SettingsNav, settingsTabId } from './SettingsNav';
import { searchSettings } from './settingsIndex';
import { availableTabs, filterTabs, personalSettingsRestricted, resolveTab } from './settingsTabs';

const lazyTabs = new Map<string, LazyExoticComponent<ComponentType>>();

/** The lazy component for a tab; a higher `attempt` makes a fresh one, so a failed import is retried. */
function lazyTab(id: string, attempt: number) {
	const key = `${id}:${attempt}`;
	let tab = lazyTabs.get(key);
	if (!tab) {
		tab = lazy(tabLoaders[id]);
		lazyTabs.set(key, tab);
	}
	return tab;
}

/** Keeps a tab that fails to load (server down, stale build) from taking the page down with it. */
class TabErrorBoundary extends Component<{ onRetry: () => void; children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	render() {
		if (!this.state.failed) return this.props.children;
		return (
			<div role="alert" className="flex h-full flex-col items-center justify-center gap-3 text-center">
				<p className="text-foreground-muted">This tab could not be loaded. Check your connection to the server.</p>
				<Button variant="secondary" size="sm" type="button" onClick={this.props.onRetry}>
					Retry
				</Button>
			</div>
		);
	}
}

/** A search result: a whole tab, or one setting on it (scrolled to and flashed when chosen). */
type Result = { key: string; tab: string; label: string; setting: string | null };

/** How long a setting chosen from search stays highlighted. */
const FLASH_MS = 1600;

/**
 * Ports chat/SettingsModal.svelte: a titled dialog with a searchable tab list
 * beside the open tab -- your settings, then (for an admin) the server's. It is
 * mounted once by AppShell and opened from the store; `useSettingsUrl` keeps
 * `?settings=<tab>` in the address while it is open (NAV-1).
 *
 * #999: 64 rem wide (a 15 rem list beside a 40 rem form), a visible title and
 * close button, focus starting on the open tab. #1000: below 768 px it is two
 * levels, the list (with search) and then the tab with a way back. #1001:
 * search finds settings by their label and description as well as tabs, and
 * a miss leaves the open tab where it is. #951: leaving a tab with unsaved
 * changes, by another tab, the close button or Escape, asks first.
 */
export function SettingsModal() {
	const open = useSettingsModalStore((s) => s.open);
	const requestedTab = useSettingsModalStore((s) => s.requestedTab);
	const selected = useSettingsModalStore((s) => s.tab);
	const setting = useSettingsModalStore((s) => s.setting);
	const pending = useSettingsModalStore((s) => s.pending);
	const { requestTab, requestClose, confirmLeave, cancelLeave } = useSettingsModalStore.getState();
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	const [search, setSearch] = useState('');
	const [active, setActive] = useState(0);
	const [view, setView] = useState<'list' | 'tab'>('list');
	const [attempts, setAttempts] = useState<Record<string, number>>({});
	const content = useRef<HTMLDivElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const wasOpen = useRef(false);
	const escapeForLayerAbove = useRef(false);
	const retries = useRef(0);

	useDocumentTitle(open ? 'Settings' : null);

	const tabs = useMemo(() => availableTabs(user, config, implementedTabIds), [user, config]);
	const tabsNow = useRef(tabs);
	tabsNow.current = tabs;
	const results = useMemo<Result[]>(() => {
		if (!search.trim()) return [];
		const titles = new Map(tabs.map((t) => [t.id, t.title]));
		return [
			...filterTabs(tabs, search).map((t) => ({ key: t.id, tab: t.id, label: t.title, setting: null })),
			...searchSettings(search, new Set(titles.keys())).map((s) => ({
				key: `${s.tab}:${s.label}`,
				tab: s.tab,
				label: `${titles.get(s.tab)} › ${s.label}`,
				setting: settingSlug(s.label)
			}))
		];
	}, [tabs, search]);

	// A fresh open starts unsearched, on the requested tab; a phone shows the
	// list first unless a tab was asked for. A request while open (Back to an
	// earlier `?settings=`) only changes the tab.
	useEffect(() => {
		if (!open) {
			wasOpen.current = false;
			return;
		}
		if (!wasOpen.current) {
			setSearch('');
			setActive(0);
			setView(requestedTab ? 'tab' : 'list');
		}
		wasOpen.current = true;
		useSettingsModalStore.getState().setTab(resolveTab(requestedTab, null, tabsNow.current));
	}, [open, requestedTab]);

	// The tab list can change under an open modal (config, permissions).
	useEffect(() => {
		if (!open) return;
		const store = useSettingsModalStore.getState();
		const tab = resolveTab(null, store.tab, tabs);
		if (tab !== store.tab) store.setTab(tab);
	}, [open, tabs]);

	// A setting chosen from search: wait for its tab to render, then scroll to it and flash it.
	useEffect(() => {
		if (!open || !setting) return;
		let tries = 0;
		const find = setInterval(() => {
			const row = panel.current?.querySelector(`[data-setting="${setting}"]`);
			if (!row && ++tries < 60) return;
			clearInterval(find);
			useSettingsModalStore.getState().clearSetting();
			if (!row) return;
			row.scrollIntoView?.({ block: 'center' });
			row.setAttribute('data-flash', '');
			setTimeout(() => row.removeAttribute('data-flash'), FLASH_MS);
		}, 50);
		return () => clearInterval(find);
	}, [open, setting]);

	if (tabs.length === 0) return null;
	const attempt = selected ? (attempts[selected] ?? 0) : 0;
	const Active = selected && tabLoaders[selected] ? lazyTab(selected, attempt) : null;
	const selectedTitle = tabs.find((t) => t.id === selected)?.title ?? '';

	const changeSearch = (value: string) => {
		setSearch(value);
		setActive(0);
	};
	const choose = (tab: string, settingSlugToShow: string | null = null) => {
		changeSearch('');
		setView('tab');
		requestTab(tab, settingSlugToShow);
	};
	const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (!results.length) return;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			const step = event.key === 'ArrowDown' ? 1 : -1;
			setActive((i) => (i + step + results.length) % results.length);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			const r = results[active];
			if (r) choose(r.tab, r.setting);
		}
	};
	const searching = search.trim() !== '';

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (o) return;
				if (escapeForLayerAbove.current) escapeForLayerAbove.current = false;
				else requestClose();
			}}
		>
			<DialogContent
				ref={content}
				className="flex h-[min(54rem,calc(100dvh-4rem))] w-[calc(100vw-2rem)] max-w-256 gap-0 overflow-hidden p-0 sm:max-w-256 max-md:h-[calc(100dvh-2rem)] max-md:flex-col"
				onEscapeKeyDown={() => {
					// NAV-4, #950: an Escape pressed in a layer above Settings (a confirmation,
					// a menu: portals outside this content) is that layer's. Radix can still
					// hand it to Settings first while the new layer registers, and Settings'
					// handler then marks it handled, so the layer above ignores it. Settings
					// ignores it instead, and presses Escape again for the layer above once it
					// has registered (unless that layer closed after all, taking focus back).
					const focused = document.activeElement;
					const above = Boolean(focused && focused !== document.body && !content.current?.contains(focused));
					escapeForLayerAbove.current = above;
					if (!above || retries.current >= 3) {
						retries.current = 0;
						return;
					}
					retries.current += 1;
					setTimeout(() => {
						const still = document.activeElement;
						if (still && still === focused && still.isConnected)
							still.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
					}, 0);
				}}
				onOpenAutoFocus={(event) => {
					// Focus starts on the open tab (#999), or on the way back to the list
					// when a phone opens straight onto a tab.
					event.preventDefault();
					requestAnimationFrame(() => {
						const root = content.current;
						const tab = root?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
						const visible = (el: HTMLElement | null | undefined) => Boolean(el && el.offsetParent !== null);
						const target = visible(tab) ? tab : root?.querySelector<HTMLElement>('[data-settings-back]');
						(visible(target) ? target : root)?.focus();
					});
				}}
			>
				<DialogDescription className="sr-only">
					Your settings and, for administrators, the server settings.
				</DialogDescription>

				<nav
					aria-label="Settings tabs"
					className={cn(
						'flex min-h-0 min-w-0 flex-col md:w-60 md:shrink-0 md:border-r max-md:flex-1',
						view === 'tab' && 'max-md:hidden'
					)}
				>
					<DialogTitle className="text-title font-title px-4 pt-4 pb-3 tracking-tight">Settings</DialogTitle>
					<div className="relative mx-2 mb-2 shrink-0">
						<Search
							aria-hidden
							className="text-foreground-muted pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
						/>
						<Input
							id="search-input-settings-modal"
							role="combobox"
							aria-label="Search settings"
							aria-expanded={searching}
							aria-controls="settings-search-results"
							aria-autocomplete="list"
							aria-activedescendant={searching && results[active] ? `settings-result-${active}` : undefined}
							className="pl-8"
							value={search}
							onChange={(e) => changeSearch(e.target.value)}
							onKeyDown={onSearchKey}
							placeholder="Search settings"
							autoComplete="off"
						/>
					</div>
					{searching ? (
						<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
							{/* A listbox the input keeps focus over, pointing at the active option (NAV-5). */}
							<div
								id="settings-search-results"
								role="listbox"
								aria-label="Matching settings"
								className="flex flex-col gap-0.5"
							>
								{results.map((r, i) => (
									<div
										key={r.key}
										tabIndex={-1}
										id={`settings-result-${i}`}
										role="option"
										aria-selected={i === active}
										onMouseDown={(e) => e.preventDefault()}
										onClick={() => choose(r.tab, r.setting)}
										onKeyDown={() => {}}
										className={cn(
											'cursor-pointer rounded-lg px-2 py-2 text-body hover:bg-surface-3',
											i === active && 'bg-surface-3 text-foreground-strong'
										)}
									>
										{r.label}
									</div>
								))}
							</div>
							{results.length === 0 && (
								<div role="status" className="px-2 py-2">
									<p className="text-foreground-muted">No settings match ‘{search.trim()}’.</p>
									<Button type="button" variant="link" className="px-0" onClick={() => changeSearch('')}>
										Clear search
									</Button>
								</div>
							)}
						</div>
					) : (
						<SettingsNav tabs={tabs} selected={selected} onSelect={(id) => choose(id)} className="min-h-0 flex-1" />
					)}
					{personalSettingsRestricted(user) && (
						<p className="text-foreground-muted border-t px-4 py-2 text-dense">
							Your administrator has turned off access to your personal settings (General, Interface, Notifications,
							Keyboard, Personalization and Audio), so they are hidden.
						</p>
					)}
				</nav>

				<div
					className={cn(
						// md:pe-14 keeps the close button clear of a tab's own header controls.
						'flex min-h-0 min-w-0 flex-1 flex-col p-6 md:pe-14 max-md:p-4',
						view === 'list' && 'max-md:hidden'
					)}
				>
					<Button
						type="button"
						variant="ghost"
						data-settings-back
						className="mb-2 self-start md:hidden"
						onClick={() => {
							setView('list');
							// The list was hidden while the tab showed: bring the open tab into view and focus.
							requestAnimationFrame(() => {
								const tab = content.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
								tab?.scrollIntoView?.({ block: 'center' });
								tab?.focus();
							});
						}}
					>
						<ChevronLeft aria-hidden />
						All settings
					</Button>
					<div
						id={SETTINGS_PANEL_ID}
						ref={panel}
						role="tabpanel"
						aria-labelledby={selected ? settingsTabId(selected) : undefined}
						aria-label={selected ? undefined : selectedTitle}
						className="min-h-0 flex-1 overflow-hidden"
					>
						{Active && (
							<TabErrorBoundary
								key={`${selected}:${attempt}`}
								onRetry={() => selected && setAttempts((a) => ({ ...a, [selected]: (a[selected] ?? 0) + 1 }))}
							>
								<Suspense
									fallback={
										<div className="flex h-full items-center justify-center">
											<Spinner className="size-6" />
										</div>
									}
								>
									<Active key={selected} />
								</Suspense>
							</TabErrorBoundary>
						)}
					</div>
				</div>
				<ConfirmDialog
					open={pending !== null}
					onOpenChange={(o) => !o && cancelLeave()}
					title="Discard changes?"
					confirmLabel="Discard changes"
					cancelLabel="Keep editing"
					onConfirm={confirmLeave}
				>
					This tab has changes that are not saved. They are lost if you leave it.
				</ConfirmDialog>
			</DialogContent>
		</Dialog>
	);
}
