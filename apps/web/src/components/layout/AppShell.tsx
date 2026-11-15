import { PanelLeft, SquarePen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Outlet } from 'react-router';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { AppMark } from '@/components/ui/app-mark';
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
import { routePaths } from '@/routes/routePaths';
import { BootSplash } from './BootSplash';
import { SidebarContent } from './Sidebar';
import { useTopBand } from './topBand';

/** The id of the region the skip link moves to. */
const CONTENT_ID = 'content';

/**
 * Below md and under 520 px of height, how far a page's first row starts from
 * the left, clear of the floating menu button (ModelSelector, the section
 * layouts' page header). 0 everywhere else.
 */
const SHORT_PHONE_INSET = 'max-md:[@media(max-height:520px)]:[--shell-menu-inset:2.25rem]';
/** The phone bar folding away on a short screen, leaving its menu button floating at the top left. */
const SHORT_PHONE_BAR = 'max-md:[@media(max-height:520px)]:contents';
const SHORT_PHONE_MENU =
	'max-md:[@media(max-height:520px)]:bg-surface-2 max-md:[@media(max-height:520px)]:border-border-divider max-md:[@media(max-height:520px)]:fixed max-md:[@media(max-height:520px)]:top-2 max-md:[@media(max-height:520px)]:left-2 max-md:[@media(max-height:520px)]:z-40 max-md:[@media(max-height:520px)]:border';
/** What else the bar holds (the mark, the page's name, New chat) leaves with it. */
const SHORT_PHONE_HIDDEN = '[@media(max-height:520px)]:hidden';

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
	const { page, heading, foldsBar } = useRouteTitle();
	const closeDrawer = () => setMobileOpen(false);
	const setSearchOpen = useUIStore((state) => state.setSearchOpen);
	// A state, not a ref: the bar mounts only once the shell replaces the splash.
	const [bar, setBar] = useState<HTMLElement | null>(null);
	useTopBand(bar);

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
		<div className="flex h-svh w-full overflow-hidden">
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
			<aside
				aria-label="Sidebar"
				className={cn('hidden h-svh shrink-0 md:block', sidebarOpen ? 'w-64 border-r' : 'w-0 overflow-hidden')}
			>
				{/* Not just visually collapsed (w-0 + overflow-hidden): unmounted
				    entirely when closed. A flex child's default min-width is its
				    content's own intrinsic size, so a nav link's text can force
				    real (if visually clipped) width and stay a real click target
				    through several more layers of flex descendants than expected --
				    found by a Playwright smoke test clicking a "hidden" sidebar
				    link. Not rendering it at all sidesteps that whole chain. */}
				{sidebarOpen && <SidebarContent showCollapseToggle />}
			</aside>

			<div className={cn('flex min-w-0 flex-1 flex-col', foldsBar && SHORT_PHONE_INSET)}>
				{/* A11Y-5: on a short phone screen (200% zoom, landscape) the bar folds
				    away and only its menu button stays, floating at the top left, on
				    routes whose handle says foldsBar: their first row leaves room for
				    it (--shell-menu-inset). Other pages keep the bar. */}
				<header
					ref={setBar}
					className={cn('flex items-center gap-2 border-b p-2 md:hidden', foldsBar && SHORT_PHONE_BAR)}
				>
					<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
						<SheetTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								aria-label="Open navigation menu"
								className={cn(foldsBar && SHORT_PHONE_MENU)}
							>
								<PanelLeft className="h-5 w-5" />
							</Button>
						</SheetTrigger>
						{/* 256 px, as the desktop sidebar: the variant's own width is `data-[side=left]:w-3/4`. */}
						<SheetContent side="left" className="gap-0 p-0 data-[side=left]:w-64">
							<SheetTitle className="sr-only">Navigation</SheetTitle>
							<SidebarContent onNavigate={closeDrawer} />
						</SheetContent>
					</Sheet>
					{/* The page's name, so the bar says where you are; the app's name is the mark's (WRD-3). */}
					<AppMark size={24} label={appName} className={cn(foldsBar && SHORT_PHONE_HIDDEN)} />
					<span className={cn('text-body font-title min-w-0 flex-1 truncate', foldsBar && SHORT_PHONE_HIDDEN)}>
						{page ?? appName}
					</span>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								asChild
								variant="ghost"
								size="icon"
								aria-label="New chat"
								className={cn(foldsBar && SHORT_PHONE_HIDDEN)}
							>
								<Link to={routePaths.home}>
									<SquarePen aria-hidden className="h-5 w-5" />
								</Link>
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">New chat</TooltipContent>
					</Tooltip>
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
