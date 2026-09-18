import {
	Calendar,
	ChartBar,
	LayoutGrid,
	LogOut,
	NotebookText,
	PanelLeft,
	Search,
	ShieldCheck,
	SquarePen
} from 'lucide-react';
import { Link, NavLink } from 'react-router';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { signOut } from '@/lib/auth/session';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useUIStore } from '@/lib/stores/uiStore';
import { routePaths } from '@/routes/routePaths';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
	cn(
		'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
		isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50'
	);

// A plain <a>, not react-router's <Link>: these paths have no React route
// (routePaths.ts) to hand them to, so this is a full-page navigation to the
// still-SvelteKit-owned surface, exactly like LegacyFallback's own default
// case for a path nobody typed a Link for.
function LegacyNavLink({
	href,
	icon: Icon,
	children
}: {
	href: string;
	icon: typeof ChartBar;
	children: React.ReactNode;
}) {
	return (
		<a
			href={href}
			className="text-muted-foreground hover:bg-accent/50 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
		>
			<Icon className="h-4 w-4" />
			{children}
		</a>
	);
}

/**
 * The nav content shared by the desktop persistent aside and the mobile
 * Sheet (see AppShell.tsx) -- one component, two containers, so the two
 * can't silently drift apart the way a hand-duplicated copy would.
 */
export function SidebarContent({
	onNavigate,
	showCollapseToggle = false
}: {
	onNavigate?: () => void;
	showCollapseToggle?: boolean;
}) {
	const user = useAuthStore((state) => state.user);
	const config = useConfigStore((state) => state.config);
	const setSidebarOpen = useUIStore((state) => state.setSidebarOpen);
	const isAdmin = user?.role === 'admin';
	const benchmarksEnabled = isAdmin && config?.features?.enable_benchmarks !== false;

	return (
		<div className="flex h-full w-full flex-col">
			<div className="flex items-center justify-between px-3 py-3">
				<span className="text-sm font-semibold">local-llm</span>
				{showCollapseToggle && (
					<Button
						variant="ghost"
						size="icon"
						aria-label="Close sidebar"
						onClick={() => setSidebarOpen(false)}
					>
						<PanelLeft className="h-4 w-4" />
					</Button>
				)}
			</div>

			<div className="flex flex-col gap-1 px-2">
				<Link
					to={routePaths.home}
					onClick={onNavigate}
					className="hover:bg-accent/50 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
				>
					<SquarePen className="h-4 w-4" />
					New Chat
				</Link>
				<button
					type="button"
					className="hover:bg-accent/50 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
				>
					<Search className="h-4 w-4" />
					Search
				</button>
			</div>

			<Separator className="my-2" />

			<ScrollArea className="flex-1 px-2">
				<nav className="flex flex-col gap-1">
					<NavLink to={routePaths.workspace} onClick={onNavigate} className={navLinkClass}>
						<LayoutGrid className="h-4 w-4" />
						Workspace
					</NavLink>
					<NavLink to={routePaths.notes} onClick={onNavigate} className={navLinkClass}>
						<NotebookText className="h-4 w-4" />
						Notes
					</NavLink>
					<NavLink to={routePaths.calendar} onClick={onNavigate} className={navLinkClass}>
						<Calendar className="h-4 w-4" />
						Calendar
					</NavLink>
					{benchmarksEnabled && (
						<NavLink to={routePaths.benchmarks} onClick={onNavigate} className={navLinkClass}>
							<ChartBar className="h-4 w-4" />
							Benchmarks
						</NavLink>
					)}
					{isAdmin && (
						<LegacyNavLink href="/admin" icon={ShieldCheck}>
							Admin
						</LegacyNavLink>
					)}
				</nav>
			</ScrollArea>

			<Separator />

			<div className="p-2">
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							className="h-auto w-full justify-start gap-2 px-2 py-1.5"
						>
							<Avatar className="h-6 w-6">
								<AvatarImage src={user?.profile_image_url} alt={user?.name ?? ''} />
								<AvatarFallback>{user?.name?.at(0)?.toUpperCase() ?? '?'}</AvatarFallback>
							</Avatar>
							<span className="truncate text-sm">{user?.name ?? 'Signed out'}</span>
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="w-56">
						<DropdownMenuLabel className="truncate">{user?.email}</DropdownMenuLabel>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => void signOut()}>
							<LogOut className="h-4 w-4" />
							Sign out
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	);
}
