import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import {
	type CalendarEventModel,
	type CalendarModel,
	deleteCalendar,
	getCalendarEvents,
	getCalendars
} from '@/lib/apis/calendar';
import { useAuthStore } from '@/lib/stores/authStore';
import { useDocumentTitle } from '@/lib/stores/configStore';
import { cn } from '@/lib/utils';
import { FeatureGate } from '@/routes/common/FeatureGate';
import { CreateCalendarDialog, EventDialog } from './CalendarDialogs';
import { CalendarViews } from './CalendarViews';
import {
	automationTarget,
	type CalendarViewMode,
	defaultCalendarId,
	headerText,
	isSameDay,
	MONTH_NAMES,
	monthGrid,
	stepDate,
	visibleRange
} from './calendarModel';

/** Ports components/calendar/CalendarSidebar.svelte: a mini month to jump around in, and the calendar list with show/hide and delete. */
function CalendarSidebar({
	calendars,
	hidden,
	date,
	onToggle,
	onCreate,
	onDelete,
	onSelectDate
}: {
	calendars: CalendarModel[];
	hidden: Set<string>;
	date: Date;
	onToggle: (id: string) => void;
	onCreate: () => void;
	onDelete: (c: CalendarModel) => void;
	onSelectDate: (d: Date) => void;
}) {
	// The mini calendar pages on its own, and follows the main date when that changes.
	const [mini, setMini] = useState(() => new Date(date.getFullYear(), date.getMonth(), 1));
	useEffect(() => setMini(new Date(date.getFullYear(), date.getMonth(), 1)), [date]);
	const today = new Date();
	return (
		<div className="flex flex-col gap-4">
			<div>
				<div className="mt-1.5 mb-1.5 flex items-center justify-between px-1">
					<div className="text-caption">
						{MONTH_NAMES[mini.getMonth()]} {mini.getFullYear()}
					</div>
					<div className="flex items-center gap-0.5">
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label="Previous month"
							onClick={() => setMini(new Date(mini.getFullYear(), mini.getMonth() - 1, 1))}
						>
							<ChevronLeft className="size-3" />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label="Next month"
							onClick={() => setMini(new Date(mini.getFullYear(), mini.getMonth() + 1, 1))}
						>
							<ChevronRight className="size-3" />
						</Button>
					</div>
				</div>
				<div className="text-muted-foreground grid grid-cols-7 text-center text-caption">
					{['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
						<div key={i} className="py-0.5">
							{d}
						</div>
					))}
				</div>
				<div className="grid grid-cols-7 text-center text-caption">
					{monthGrid(mini).map((day) => (
						<Button
							key={day.toISOString()}
							type="button"
							variant={isSameDay(day, today) ? 'default' : isSameDay(day, date) ? 'secondary' : 'ghost'}
							size="icon-xs"
							aria-label={day.toDateString()}
							className={cn('rounded-full text-caption', day.getMonth() !== mini.getMonth() && 'text-foreground-muted')}
							onClick={() => onSelectDate(day)}
						>
							{day.getDate()}
						</Button>
					))}
				</div>
			</div>
			<div>
				<div className="mb-1 flex items-center justify-between px-1">
					<div className="text-muted-foreground text-caption tracking-wider uppercase">Calendars</div>
					<Button type="button" variant="ghost" size="icon-xs" aria-label="New calendar" onClick={onCreate}>
						<Plus className="size-3.5" />
					</Button>
				</div>
				<ul>
					{calendars.map((c) => {
						const shown = !hidden.has(c.id);
						return (
							<li key={c.id} className="group flex items-center">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									aria-pressed={shown}
									className="min-w-0 flex-1 justify-start gap-2 text-left shrink"
									onClick={() => onToggle(c.id)}
								>
									<span
										className="size-2.5 shrink-0 rounded-sm"
										style={{ backgroundColor: c.color || '#3b82f6', opacity: shown ? 1 : 0.25 }}
									/>
									<span className={cn('flex-1 truncate', !shown && 'text-muted-foreground')}>{c.name}</span>
								</Button>
								{!c.is_default && !c.is_system && (
									<Button
										type="button"
										variant="ghost"
										size="icon-xs"
										aria-label={`Delete calendar ${c.name}`}
										className="opacity-0 group-hover:opacity-100 focus:opacity-100"
										onClick={() => onDelete(c)}
									>
										<X className="size-3" />
									</Button>
								)}
							</li>
						);
					})}
				</ul>
			</div>
		</div>
	);
}

/**
 * Ports routes/(app)/calendar/+page.svelte: month/week/day views of the
 * user's calendars, with a sidebar to jump to a date and show or hide each
 * calendar. Clicking empty space creates an event there; clicking an
 * automation's run opens what it produced. Events are fetched per visible
 * window (TanStack Query, keyed by the window), so paging back is instant.
 *
 * Hidden calendars are remembered as "hidden", not "visible", so a calendar
 * created later shows up without a reload (the Svelte page rebuilt the visible
 * set from scratch after each create, re-showing everything hidden).
 */
function Calendar() {
	const token = useAuthStore((s) => s.token) ?? '';
	const userId = useAuthStore((s) => s.user?.id);
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	useDocumentTitle('Calendar');
	const [view, setView] = useState<CalendarViewMode>('month');
	const [date, setDate] = useState(() => new Date());
	const [hidden, setHidden] = useState<Set<string>>(new Set());
	const [eventDialog, setEventDialog] = useState<{ event: CalendarEventModel | null; startAt: number | null } | null>(
		null
	);
	const [creatingCalendar, setCreatingCalendar] = useState(false);
	const [deleting, setDeleting] = useState<CalendarModel | null>(null);

	const calendars = useQuery({
		queryKey: ['calendars'],
		queryFn: async () => (await getCalendars(token).catch(() => [])) ?? []
	});
	const range = visibleRange(view, date);
	const events = useQuery({
		queryKey: ['calendar-events', range.start, range.end],
		queryFn: () => getCalendarEvents(token, range.start, range.end),
		placeholderData: (prev) => prev
	});
	useEffect(() => {
		if (events.isError) toast.error(`${events.error}`);
	}, [events.isError, events.error]);

	const list = calendars.data ?? [];
	const visibleEvents = (events.data ?? []).filter((e) => !hidden.has(e.calendar_id));
	const refreshEvents = () => queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
	const refreshAll = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['calendars'] }), refreshEvents()]);

	const openEvent = (e: CalendarEventModel) => {
		const target = automationTarget(e);
		if (target) navigate(target);
		else setEventDialog({ event: e, startAt: null });
	};

	const removeCalendar = async () => {
		if (!deleting) return;
		try {
			const ok = await deleteCalendar(token, deleting.id);
			if (ok) {
				toast.success('Calendar deleted');
				await refreshAll();
			} else toast.error('Failed to delete calendar');
		} catch (err) {
			toast.error(`${err}`);
		}
		setDeleting(null);
	};

	if (calendars.isLoading) {
		return (
			<div className="flex flex-1 items-center justify-center">
				<Spinner className="size-5" />
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 w-full flex-col">
			<EventDialog
				open={eventDialog !== null}
				onOpenChange={(o) => !o && setEventDialog(null)}
				event={eventDialog?.event ?? null}
				calendars={list}
				defaultCalendarId={defaultCalendarId(list, userId)}
				defaultStartAt={eventDialog?.startAt ?? null}
				onSaved={refreshEvents}
			/>
			<CreateCalendarDialog open={creatingCalendar} onOpenChange={setCreatingCalendar} onCreated={refreshAll} />
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title="Delete Calendar"
				confirmLabel="Delete"
				onConfirm={removeCalendar}
			>
				This will permanently delete the calendar "{deleting?.name}" and all its events. This action cannot be undone.
			</ConfirmDialog>

			<nav className="flex shrink-0 items-center gap-1 px-3 py-2">
				<h1 className="px-1 text-sm">{headerText(view, date)}</h1>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label="Previous"
					onClick={() => setDate(stepDate(view, date, -1))}
				>
					<ChevronLeft className="text-muted-foreground size-3.5" />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label="Next"
					onClick={() => setDate(stepDate(view, date, 1))}
				>
					<ChevronRight className="text-muted-foreground size-3.5" />
				</Button>
				<div className="ml-auto flex items-center gap-1">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="hidden sm:inline-flex"
						onClick={() => setDate(new Date())}
					>
						Today
					</Button>
					<select
						aria-label="View"
						className="bg-transparent px-2 py-1 text-xs [&>option]:bg-popover"
						value={view}
						onChange={(e) => setView(e.target.value as CalendarViewMode)}
					>
						<option value="day">Day</option>
						<option value="week">Week</option>
						<option value="month">Month</option>
					</select>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => setEventDialog({ event: null, startAt: null })}
					>
						Create
					</Button>
				</div>
			</nav>

			<div className="flex min-h-0 flex-1">
				<aside className="hidden w-56 shrink-0 overflow-y-auto pr-1.5 pl-3 md:flex md:flex-col">
					<CalendarSidebar
						calendars={list}
						hidden={hidden}
						date={date}
						onToggle={(id) =>
							setHidden((prev) => {
								const next = new Set(prev);
								if (!next.delete(id)) next.add(id);
								return next;
							})
						}
						onCreate={() => setCreatingCalendar(true)}
						onDelete={setDeleting}
						onSelectDate={setDate}
					/>
				</aside>
				<div className="flex min-h-0 flex-1 flex-col">
					<CalendarViews
						view={view}
						date={date}
						events={visibleEvents}
						calendars={list}
						onCreate={(startAt) => setEventDialog({ event: null, startAt })}
						onEventClick={openEvent}
						onOpenDay={(day) => {
							setDate(day);
							setView('day');
						}}
					/>
				</div>
			</div>
		</div>
	);
}

export function CalendarPage() {
	return (
		<FeatureGate feature="calendar">
			<Calendar />
		</FeatureGate>
	);
}
