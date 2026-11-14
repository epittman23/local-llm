import { PanelLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuthGate } from '@/lib/auth/useAuthGate';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useSettingsUrl } from '@/lib/settings/useSettingsUrl';
import { useSocketReady } from '@/lib/socket/SocketProvider';
import { useWebUIName } from '@/lib/stores/configStore';
import { useUIStore } from '@/lib/stores/uiStore';
import { useRouteTitle } from '@/lib/ui/pageTitle';
import { useShortcuts } from '@/lib/useShortcuts';
import { cn } from '@/lib/utils';
import { setAppFontFamily, setTextScale } from '@/lib/utils/textScale';
import { useCalendarAlerts } from '@/routes/calendar/useCalendarAlerts';
import { useChannelUnreadEvents } from '@/routes/channels/useChannels';
import { PendingWorkspacesDialog } from '@/routes/chat/PendingWorkspacesDialog';
import { SearchChatsDialog } from '@/routes/chat/sidebar/ChatDialogs';
import { BootSplash } from './BootSplash';
import { SidebarContent } from './Sidebar';

/** The id of the region the skip link moves to. */
const CONTENT_ID = 'content';

/**
 * Below md and under 520 px of height, how far a page's first row starts from
 * the left, clear of the floating menu button (ModelSelector, the section
 * layouts' page header). 0 everywhere else.
 */
const SHORT_PHONE_INSET = 'max-md:[@media(max-height:520px)]:[--shell-menu-inset:2.25rem]';

/**
 * The persistent shell every React route renders inside (see AppRouter.tsx):
 * a collapsible desktop sidebar, a Sheet-based mobile drawer sharing the same
 * nav content, and the route's own element in <Outlet />. Reach-for-this-first
 * per the shadcn skill's own mobile-nav recipe (Sheet + Button + Separator).
 *
 * Also the route gate: every route in AppRouter.tsx is a child of AppShell,
 * so gating here (rather than per-route) covers all of them at once, the
 * same way d863707:apps/openwebui/src/routes/(app)/+layout.svelte gates every page
 * under its route group in one place.
 */
export function AppShell() {
	const authStatus = useAuthGate();
	useSettingsUrl();
	useChannelUnreadEvents();
	useCalendarAlerts();
	// The socket connects once the shell and its route have attached their
	// listeners, so nothing sent right after a sign-in is lost (#674).
	useSocketReady(authStatus === 'authenticated');
	const sidebarOpen = useUIStore((state) => state.sidebarOpen);
	const setSidebarOpen = useUIStore((state) => state.setSidebarOpen);
	const [mobileOpen, setMobileOpen] = useState(false);
	const searchOpen = useUIStore((state) => state.searchOpen);
	const appName = useWebUIName();
	const { page, heading } = useRouteTitle();
	const setSearchOpen = useUIStore((state) => state.setSearchOpen);

	// The user's keyboard shortcuts (Ctrl/Cmd+K search, Ctrl/Cmd+Shift+O new chat, ...).
	useShortcuts();

	// The saved UI scale and font apply on every load, as +layout.svelte does,
	// not only while they are changed in Settings (docs/history/code-review.md M7).
	const { settings } = useUserSettings();
	const textScale = (settings as Record<string, unknown> | null)?.textScale;
	const fontFamily = (settings as Record<string, unknown> | null)?.fontFamily;
	useEffect(() => {
		setTextScale(typeof textScale === 'number' ? textScale : 1);
		setAppFontFamily(typeof fontFamily === 'string' ? fontFamily : null);
	}, [textScale, fontFamily]);

	// 'pending': the session bootstrap (lib/auth/session.ts) hasn't resolved
	// yet -- show the boot splash rather than flash the shell before we know if
	// there's a user. 'anonymous': useAuthGate's effect is already navigating
	// away to /auth; still show only the splash so nothing protected flashes
	// during that redirect's own round trip.
	if (authStatus !== 'authenticated') return <BootSplash />;

	return (
		<div className="flex h-svh w-full">
			{/* A11Y-3: the first stop for Tab, so the keyboard can pass the navigation. */}
			<a
				href={`#${CONTENT_ID}`}
				onClick={(e) => {
					e.preventDefault();
					document.getElementById(CONTENT_ID)?.focus();
				}}
				className="bg-brand text-brand-foreground sr-only rounded-lg px-3 py-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50"
			>
				Skip to content
			</a>
			<aside className={cn('hidden shrink-0 md:block', sidebarOpen ? 'w-64 border-r' : 'w-0 overflow-hidden')}>
				{/* Not just visually collapsed (w-0 + overflow-hidden): unmounted
				    entirely when closed. A flex child's default min-width is its
				    content's own intrinsic size, so a nav link's text can force
				    real (if visually clipped) width and stay a real click target
				    through several more layers of flex descendants than expected --
				    found by a Playwright smoke test clicking a "hidden" sidebar
				    link. Not rendering it at all sidesteps that whole chain. */}
				{sidebarOpen && <SidebarContent showCollapseToggle />}
			</aside>

			<div className={cn('flex min-w-0 flex-1 flex-col', SHORT_PHONE_INSET)}>
				{/* A11Y-5: on a short phone screen (200% zoom, landscape) the bar folds
				    away and only its menu button stays, floating at the top left; the
				    page's first row leaves room for it (--shell-menu-inset). */}
				<header
					className={cn('flex items-center gap-2 border-b p-2 md:hidden', 'max-md:[@media(max-height:520px)]:contents')}
				>
					<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
						<SheetTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								aria-label="Open navigation menu"
								className="max-md:[@media(max-height:520px)]:bg-surface-2 max-md:[@media(max-height:520px)]:border-border-divider max-md:[@media(max-height:520px)]:fixed max-md:[@media(max-height:520px)]:top-2 max-md:[@media(max-height:520px)]:left-2 max-md:[@media(max-height:520px)]:z-40 max-md:[@media(max-height:520px)]:border"
							>
								<PanelLeft className="h-5 w-5" />
							</Button>
						</SheetTrigger>
						<SheetContent side="left" className="w-64 p-0">
							<SheetTitle className="sr-only">Navigation</SheetTitle>
							<SidebarContent onNavigate={() => setMobileOpen(false)} />
						</SheetContent>
					</Sheet>
					<span className="text-body font-title [@media(max-height:520px)]:hidden">{appName}</span>
				</header>

				{!sidebarOpen && (
					<div className="hidden p-2 md:block">
						<Tooltip>
							<TooltipTrigger asChild>
								<Button variant="ghost" size="icon" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}>
									<PanelLeft className="h-5 w-5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="right">Open sidebar</TooltipContent>
						</Tooltip>
					</div>
				)}

				<main id={CONTENT_ID} tabIndex={-1} className="min-h-0 flex-1 overflow-auto">
					{heading === 'sr' && <h1 className="sr-only">{page}</h1>}
					<Outlet />
				</main>
				<SettingsModal />
				<SearchChatsDialog open={searchOpen} onOpenChange={setSearchOpen} />
				<PendingWorkspacesDialog />
			</div>
		</div>
	);
}
