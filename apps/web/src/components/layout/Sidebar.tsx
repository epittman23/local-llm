import {
	Archive,
	Calendar,
	ChartBar,
	Clock,
	FlaskConical,
	LayoutGrid,
	LogOut,
	type LucideIcon,
	NotebookText,
	PanelLeft,
	Search,
	Settings,
	ShieldCheck,
	SquarePen,
	SunMoon
} from 'lucide-react';
import { Link, NavLink } from 'react-router';
import { Tip } from '@/components/common/Tip';
import { implementedTabIds } from '@/components/settings/adminTabComponents';
import { availableTabs } from '@/components/settings/settingsTabs';
import { AppMark } from '@/components/ui/app-mark';
import { ProfileAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { ImageButton } from '@/components/ui/image-button';
import { RowButton } from '@/components/ui/row-button';
import { Separator } from '@/components/ui/separator';
import { canUseFeature } from '@/lib/access/features';
import { signOut } from '@/lib/auth/session';
import { useThemeChoice } from '@/lib/settings/useThemeChoice';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore, useWebUIName } from '@/lib/stores/configStore';
import { useSettingsModalStore } from '@/lib/stores/settingsModalStore';
import { useUIStore } from '@/lib/stores/uiStore';
import { isThemeId, THEMES } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { SidebarChannels } from '@/routes/channels/SidebarChannels';
import { ChatSidebar } from '@/routes/chat/sidebar/ChatSidebar';
import { routePaths } from '@/routes/routePaths';

/**
 * Opens or closes the desktop sidebar from its own toggle, then moves focus
 * to the toggle that replaces it (Close sidebar in the header, Open sidebar
 * on the rail), since the one pressed is unmounted (NAV-4).
 */
function toggleSidebarFrom(open: boolean) {
	useUIStore.getState().setSidebarOpen(open);
	requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-sidebar-toggle]')?.focus());
}

/**
 * The account menu: Settings, Archived chats, Theme (saved with the account,
 * #1089) and Sign out. In the sidebar its trigger is the user's row; on the
 * closed sidebar's rail (`compact`) it is the avatar alone, named and
 * tooltipped with the user's name (ACT-4).
 */
export function UserMenu({ compact = false }: { compact?: boolean }) {
	const user = useAuthStore((state) => state.user);
	const config = useConfigStore((state) => state.config);
	const openSettings = useSettingsModalStore((state) => state.openSettings);
	const tabs = availableTabs(user, config, implementedTabIds);
	const hasSettings = tabs.length > 0;
	const hasArchived = tabs.some((t) => t.id === 'archived_chats');
	const [theme, chooseTheme] = useThemeChoice();
	const name = user?.name ?? 'Signed out';

	const trigger = compact ? (
		<ImageButton shape="circle" aria-label={name} className="size-8 border-0">
			<ProfileAvatar src={user?.profile_image_url} name={user?.name} />
		</ImageButton>
	) : (
		<RowButton className="flex items-center justify-start gap-2 px-2 py-1.5">
			<ProfileAvatar src={user?.profile_image_url} name={user?.name} size="sm" />
			<span className="truncate text-sm">{name}</span>
		</RowButton>
	);

	return (
		<DropdownMenu>
			{compact ? (
				<Tip content={name} side="right">
					<DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
				</Tip>
			) : (
				<DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
			)}
			<DropdownMenuContent
				align={compact ? 'end' : 'start'}
				side={compact ? 'right' : undefined}
				sideOffset={compact ? 8 : undefined}
				className="w-56"
			>
				<DropdownMenuLabel className="truncate">{user?.email}</DropdownMenuLabel>
				<DropdownMenuSeparator />
				{hasSettings && (
					<DropdownMenuItem onSelect={() => openSettings()}>
						<Settings className="h-4 w-4" />
						Settings
					</DropdownMenuItem>
				)}
				{hasArchived && (
					<DropdownMenuItem onSelect={() => openSettings('archived_chats')}>
						<Archive className="h-4 w-4" />
						Archived chats
					</DropdownMenuItem>
				)}
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						<SunMoon className="size-4" />
						Theme
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent>
						<DropdownMenuRadioGroup value={theme} onValueChange={(id) => isThemeId(id) && chooseTheme(id)}>
							{THEMES.map(({ id, label, icon: Icon }) => (
								<DropdownMenuRadioItem key={id} value={id}>
									<Icon className="size-4" />
									{label}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={() => void signOut()}>
					<LogOut className="h-4 w-4" />
					Sign out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * The closed desktop sidebar (#930): a 48 px rail with Open sidebar, New chat
 * and Search at the top and the account menu at the foot, each an icon named
 * by its tooltip (ACT-4, OVL-4), so closing the sidebar loses none of them.
 * Phones have the drawer instead.
 */
export function SidebarRail() {
	const setSearchOpen = useUIStore((state) => state.setSearchOpen);
	return (
		<nav aria-label="Main" className="flex h-full flex-col items-center gap-1 py-3">
			<Tip content="Open sidebar" side="right">
				<Button
					variant="ghost"
					size="icon"
					aria-label="Open sidebar"
					data-sidebar-toggle
					onClick={() => toggleSidebarFrom(true)}
				>
					<PanelLeft aria-hidden className="size-4" />
				</Button>
			</Tip>
			<Tip content="New chat" side="right">
				<Button asChild variant="ghost" size="icon" aria-label="New chat">
					<Link to={routePaths.home}>
						<SquarePen aria-hidden className="size-4" />
					</Link>
				</Button>
			</Tip>
			<Tip content="Search" side="right">
				<Button variant="ghost" size="icon" aria-label="Search" onClick={() => setSearchOpen(true)}>
					<Search aria-hidden className="size-4" />
				</Button>
			</Tip>
			<div className="mt-auto">
				<UserMenu compact />
			</div>
		</nav>
	);
}

/**
 * A destination at the foot of the sidebar (#931). With a pointer it is an
 * icon whose name is its tooltip (ACT-4); on touch, where there are no
 * tooltips (OVL-4), the name shows beside the icon in a two-column grid.
 */
function Destination({
	to,
	icon: Icon,
	label,
	onNavigate
}: {
	to: string;
	icon: LucideIcon;
	label: string;
	onNavigate?: () => void;
}) {
	return (
		<Tip content={label} side="top">
			<NavLink
				to={to}
				onClick={onNavigate}
				className={({ isActive }) =>
					cn(
						'text-body flex h-8 min-w-0 items-center justify-center gap-2 rounded-lg transition-colors pointer-coarse:min-h-11 pointer-coarse:justify-start pointer-coarse:px-2',
						isActive ? 'bg-accent text-accent-foreground' : 'text-foreground-strong hover:bg-surface-3'
					)
				}
			>
				<Icon aria-hidden className="size-4 shrink-0" />
				<span className="truncate pointer-fine:sr-only">{label}</span>
			</NavLink>
		</Tip>
	);
}

/**
 * The nav content shared by the desktop persistent aside and the mobile
 * Sheet (see AppShell.tsx) -- one component, two containers, so the two
 * can't silently drift apart the way a hand-duplicated copy would.
 *
 * Exactly as tall as its container (LAY-7): the header, New chat and Search
 * at the top and the destinations and user row at the foot stay put; only
 * the chat list between them scrolls, and never sideways (#903, #904).
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
	const isAdmin = user?.role === 'admin';
	const benchmarksEnabled = isAdmin && config?.features?.enable_benchmarks !== false;
	const setSearchOpen = useUIStore((state) => state.setSearchOpen);
	const appName = useWebUIName();

	const destinations: { to: string; icon: LucideIcon; label: string }[] = [
		{ to: routePaths.workspace, icon: LayoutGrid, label: 'Workspace' },
		...(canUseFeature('notes', user, config) ? [{ to: routePaths.notes, icon: NotebookText, label: 'Notes' }] : []),
		...(canUseFeature('automations', user, config)
			? [{ to: routePaths.automations, icon: Clock, label: 'Automations' }]
			: []),
		...(canUseFeature('calendar', user, config)
			? [{ to: routePaths.calendar, icon: Calendar, label: 'Calendar' }]
			: []),
		...(canUseFeature('playground', user, config)
			? [{ to: routePaths.playground, icon: FlaskConical, label: 'Playground' }]
			: []),
		...(benchmarksEnabled ? [{ to: routePaths.benchmarks, icon: ChartBar, label: 'Benchmarks' }] : []),
		...(isAdmin ? [{ to: routePaths.admin, icon: ShieldCheck, label: 'Admin' }] : [])
	];

	return (
		<nav aria-label="Main" className="flex h-full min-h-0 w-full flex-col">
			<div className="flex items-center gap-2 px-3 py-3">
				<AppMark size={24} />
				<span className="text-body font-title min-w-0 flex-1 truncate">{appName}</span>
				{showCollapseToggle && (
					<Tip content="Close sidebar" side="right">
						<Button
							variant="ghost"
							size="icon"
							aria-label="Close sidebar"
							data-sidebar-toggle
							onClick={() => toggleSidebarFrom(false)}
						>
							<PanelLeft aria-hidden className="h-4 w-4" />
						</Button>
					</Tip>
				)}
			</div>

			<div className="flex flex-col gap-1 px-2">
				<Link
					to={routePaths.home}
					onClick={onNavigate}
					className="text-body font-strong text-foreground-strong hover:bg-surface-3 flex h-9 items-center gap-2 rounded-lg px-3 transition-colors pointer-coarse:min-h-11"
				>
					<SquarePen aria-hidden className="h-4 w-4" />
					New chat
				</Link>
				<Button type="button" onClick={() => setSearchOpen(true)} variant="ghost" className="w-full justify-start">
					<Search aria-hidden className="h-4 w-4" />
					Search
				</Button>
			</div>

			<Separator className="mt-2" />

			<div data-slot="sidebar-list" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-2">
				<SidebarChannels onNavigate={onNavigate} />
				<ChatSidebar onNavigate={onNavigate} />
			</div>

			<Separator />

			<ul aria-label="Destinations" className="grid grid-cols-7 gap-1 px-2 pt-2 pointer-coarse:grid-cols-2">
				{destinations.map((d) => (
					<li key={d.to} className="flex min-w-0 flex-col">
						<Destination {...d} onNavigate={onNavigate} />
					</li>
				))}
			</ul>

			<div className="p-2">
				<UserMenu />
			</div>
		</nav>
	);
}
