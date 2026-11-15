import { useQuery } from '@tanstack/react-query';
import { CalendarDays, MessageSquare, NotebookPen, Pin, Search, SquarePen } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { RowButton } from '@/components/ui/row-button';
import { canUseFeature } from '@/lib/access/features';
import { type CalendarEventModel, getCalendarEvents } from '@/lib/apis/calendar';
import type { ChatListItem } from '@/lib/chat/chatList';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { useUIStore } from '@/lib/stores/uiStore';
import { dayjs, shownTime } from '@/lib/utils/dates';
import { automationTarget, dayKey, eventsByDay, NS, visibleRange } from '@/routes/calendar/calendarModel';
import { useChatPages, usePinnedChats } from '@/routes/chat/sidebar/useChatList';
import { routePaths } from '@/routes/routePaths';

/** How many of the most recent chats Home lists below the pinned ones. */
export const RECENT_CHATS = 8;

/** A list's loading skeleton: rows in the shape of what is coming (STA-2). */
function RowsSkeleton({ testId, rows }: { testId: string; rows: number }) {
	return (
		<div aria-hidden className="flex flex-col gap-1" data-testid={testId}>
			{Array.from({ length: rows }, (_, i) => i).map((row) => (
				<div key={row} className="bg-surface-3 h-9 animate-pulse rounded-lg" />
			))}
		</div>
	);
}

function ChatRow({ chat, pinned }: { chat: ChatListItem; pinned: boolean }) {
	const navigate = useNavigate();
	const time = chat.updated_at ? shownTime(chat.updated_at) : null;
	const Icon = pinned ? Pin : MessageSquare;
	return (
		<li>
			<RowButton className="flex items-center gap-3 px-3 py-2" onClick={() => navigate(`/c/${chat.id}`)}>
				<Icon aria-hidden className="text-foreground-muted size-4 shrink-0" />
				{pinned && <span className="sr-only">Pinned: </span>}
				<span className="min-w-0 flex-1 truncate" title={chat.title}>
					{chat.title}
				</span>
				{time && (
					<time dateTime={time.iso} title={time.exact} className="text-caption text-foreground-muted shrink-0">
						{time.label}
					</time>
				)}
			</RowButton>
		</li>
	);
}

/**
 * Pinned chats, then the most recent ones (the server's main list, which
 * leaves out pinned chats and chats in folders), read from the sidebar's own
 * queries so both show the same thing and refresh together.
 */
function ChatsBlock() {
	const pages = useChatPages();
	const pinned = usePinnedChats();
	const failed = [pages, pinned].filter((q) => q.isError);
	const pinnedList = pinned.data ?? [];
	const pinnedIds = new Set(pinnedList.map((c) => c.id));
	const recent = (pages.data?.pages[0] ?? []).filter((c) => !pinnedIds.has(c.id)).slice(0, RECENT_CHATS);

	return (
		<section aria-labelledby="home-chats" className="flex flex-col gap-2">
			<h2 id="home-chats" className="text-title font-title tracking-tight">
				Pinned and recent chats
			</h2>
			{failed.length ? (
				<LoadFailed
					what="chats"
					error={failed[0].error}
					onRetry={() => {
						for (const q of failed) void q.refetch();
					}}
					retrying={failed.some((q) => q.isFetching)}
				/>
			) : pages.isLoading || pinned.isLoading ? (
				<RowsSkeleton testId="home-chats-loading" rows={5} />
			) : pinnedList.length + recent.length === 0 ? (
				<div className="flex flex-col items-start gap-3 py-2">
					<p className="text-foreground-muted">
						Nothing here yet. Your pinned chats and your most recent chats outside folders appear here.
					</p>
					<Button variant="outline" asChild>
						<Link to={routePaths.home}>
							<SquarePen aria-hidden /> Start a chat
						</Link>
					</Button>
				</div>
			) : (
				<ul className="flex flex-col">
					{pinnedList.map((chat) => (
						<ChatRow key={chat.id} chat={chat} pinned />
					))}
					{recent.map((chat) => (
						<ChatRow key={chat.id} chat={chat} pinned={false} />
					))}
				</ul>
			)}
		</section>
	);
}

/** When an event happens today, in words: "All day", "09:00–10:00", "Until 10:00", "From 22:00". */
export function eventTime(e: CalendarEventModel, dayStartMs: number): string {
	const dayEndMs = dayStartMs + 86_400_000;
	const startMs = e.start_at / NS;
	const endMs = e.end_at && e.end_at > e.start_at ? e.end_at / NS : null;
	const hm = (ms: number) => dayjs(ms).format('HH:mm');
	const before = startMs < dayStartMs;
	const after = endMs !== null && endMs > dayEndMs;
	if (e.all_day || (before && (endMs === null || after))) return 'All day';
	if (before && endMs !== null) return `Until ${hm(endMs)}`;
	if (after) return `From ${hm(startMs)}`;
	return endMs === null ? hm(startMs) : `${hm(startMs)}–${hm(endMs)}`;
}

/** The events that touch `today`: all-day ones first, then by start time. */
export function todaysEvents(events: CalendarEventModel[], today: Date): CalendarEventModel[] {
	return [...(eventsByDay(events)[dayKey(today)] ?? [])].sort(
		(a, b) => Number(b.all_day) - Number(a.all_day) || a.start_at - b.start_at
	);
}

/**
 * Today's events. An event has no address of its own, so a row opens what an
 * automation's run posted to, or the calendar.
 */
function TodayBlock() {
	const token = useAuthStore((s) => s.token) ?? '';
	const navigate = useNavigate();
	const today = new Date();
	const range = visibleRange('day', today);
	// The Calendar page's key for its day view, so its changes refresh Home too.
	const events = useQuery({
		queryKey: ['calendar-events', range.start, range.end],
		enabled: Boolean(token),
		queryFn: () => getCalendarEvents(token, range.start, range.end)
	});
	const list = todaysEvents(events.data ?? [], today);
	const dayStartMs = new Date(range.start).getTime();

	return (
		<section aria-labelledby="home-today" className="flex flex-col gap-2">
			<div className="flex flex-wrap items-baseline justify-between gap-x-3">
				<h2 id="home-today" className="text-title font-title tracking-tight">
					Today
				</h2>
				<span className="text-caption text-foreground-muted">{dayjs(today).format('dddd, D MMMM')}</span>
			</div>
			{events.isError ? (
				<LoadFailed
					what="today’s calendar"
					error={events.error}
					onRetry={() => void events.refetch()}
					retrying={events.isFetching}
				/>
			) : events.isLoading ? (
				<RowsSkeleton testId="home-today-loading" rows={3} />
			) : list.length === 0 ? (
				<div className="flex flex-col items-start gap-3 py-2">
					<p className="text-foreground-muted">Nothing on your calendar today.</p>
					<Button variant="outline" asChild>
						<Link to={routePaths.calendar}>
							<CalendarDays aria-hidden /> Open calendar
						</Link>
					</Button>
				</div>
			) : (
				<ul className="flex flex-col">
					{list.map((e) => (
						<li key={e.instance_id ?? e.id}>
							<RowButton
								className="flex items-baseline gap-3 px-3 py-2"
								onClick={() => navigate(automationTarget(e) ?? routePaths.calendar)}
							>
								<span className="text-dense text-foreground-muted w-24 shrink-0 tabular-nums">
									{eventTime(e, dayStartMs)}
								</span>
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="truncate" title={e.title}>
										{e.title}
									</span>
									{e.location && (
										<span className="text-caption text-foreground-muted truncate" title={e.location}>
											{e.location}
										</span>
									)}
								</span>
							</RowButton>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

/**
 * /home (#1093, decision S2-D6): a start page. New chat is the page's one
 * primary action (LAY-5, ACT-1), so it is not repeated among the quick
 * actions under the header. Then the pinned and recent chats and today's
 * calendar, each in its four states (STA-1). Notes and the calendar appear
 * only for someone who may use them.
 */
export function HomePage() {
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	const setSearchOpen = useUIStore((s) => s.setSearchOpen);
	const notes = canUseFeature('notes', user, config);
	const calendar = canUseFeature('calendar', user, config);

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6 md:px-6 md:py-8">
			<div className="flex flex-col gap-4">
				<PageHeader
					title="Home"
					description="Your pinned and recent chats, today’s calendar, and a quick way to start something."
					action={
						<Button asChild>
							<Link to={routePaths.home}>
								<SquarePen aria-hidden /> New chat
							</Link>
						</Button>
					}
				/>
				<ul aria-label="Quick actions" className="flex flex-wrap gap-2">
					<li>
						<Button variant="outline" onClick={() => setSearchOpen(true)}>
							<Search aria-hidden /> Search chats
						</Button>
					</li>
					{notes && (
						<li>
							<Button variant="outline" asChild>
								<Link to={`${routePaths.notes}/new`}>
									<NotebookPen aria-hidden /> New note
								</Link>
							</Button>
						</li>
					)}
					{calendar && (
						<li>
							<Button variant="outline" asChild>
								<Link to={routePaths.calendar}>
									<CalendarDays aria-hidden /> Calendar
								</Link>
							</Button>
						</li>
					)}
				</ul>
			</div>
			<ChatsBlock />
			{calendar && <TodayBlock />}
		</div>
	);
}
