import { PanelLeft } from 'lucide-react';
import { useState } from 'react';
import { Outlet } from 'react-router';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuthGate } from '@/lib/auth/useAuthGate';
import { useUIStore } from '@/lib/stores/uiStore';
import { cn } from '@/lib/utils';
import { SidebarContent } from './Sidebar';

/**
 * The persistent shell every React route renders inside (see AppRouter.tsx):
 * a collapsible desktop sidebar, a Sheet-based mobile drawer sharing the same
 * nav content, and the route's own element in <Outlet />. Reach-for-this-first
 * per the shadcn skill's own mobile-nav recipe (Sheet + Button + Separator).
 *
 * Also the route gate: every route in AppRouter.tsx is a child of AppShell,
 * so gating here (rather than per-route) covers all of them at once, the
 * same way apps/openwebui/src/routes/(app)/+layout.svelte gates every page
 * under its route group in one place.
 */
export function AppShell() {
	const authStatus = useAuthGate();
	const sidebarOpen = useUIStore((state) => state.sidebarOpen);
	const setSidebarOpen = useUIStore((state) => state.setSidebarOpen);
	const [mobileOpen, setMobileOpen] = useState(false);

	// 'pending': the session bootstrap (lib/auth/session.ts) hasn't resolved
	// yet -- render nothing rather than flash the shell before we know if
	// there's a user. 'anonymous': useAuthGate's effect is already navigating
	// away to /auth; still render nothing so nothing protected flashes during
	// that redirect's own round trip.
	if (authStatus !== 'authenticated') {
		return (
			<div className="flex h-svh w-full items-center justify-center">
				<p className="text-muted-foreground text-sm">Loading…</p>
			</div>
		);
	}

	return (
		<div className="flex h-svh w-full">
			<aside
				className={cn(
					'hidden shrink-0 md:block',
					sidebarOpen ? 'w-64 border-r' : 'w-0 overflow-hidden'
				)}
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

			<div className="flex min-w-0 flex-1 flex-col">
				<header className="flex items-center gap-2 border-b p-2 md:hidden">
					<Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
						<SheetTrigger asChild>
							<Button variant="ghost" size="icon" aria-label="Open navigation menu">
								<PanelLeft className="h-5 w-5" />
							</Button>
						</SheetTrigger>
						<SheetContent side="left" className="w-64 p-0">
							<SheetTitle className="sr-only">Navigation</SheetTitle>
							<SidebarContent onNavigate={() => setMobileOpen(false)} />
						</SheetContent>
					</Sheet>
					<span className="text-sm font-semibold">local-llm</span>
				</header>

				{!sidebarOpen && (
					<div className="hidden p-2 md:block">
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									aria-label="Open sidebar"
									onClick={() => setSidebarOpen(true)}
								>
									<PanelLeft className="h-5 w-5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="right">Open sidebar</TooltipContent>
						</Tooltip>
					</div>
				)}

				<main className="min-h-0 flex-1 overflow-auto">
					<Outlet />
				</main>
			</div>
		</div>
	);
}
