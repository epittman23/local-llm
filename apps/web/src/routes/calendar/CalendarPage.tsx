import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, Check, ChevronLeft, ChevronRight, Ellipsis, ListChecks, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { toastFailure } from '@/components/common/failureToast';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { useMdUp } from '@/components/layout/SidePanel';
import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { PageHeader } from '@/components/ui/page-header';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import {
	type CalendarEventModel,
	type CalendarModel,
	deleteCalendar,
	getCalendarEvents,
	getCalendars,
	setDefaultCalendar
} from '@/lib/apis/calendar';
import { useAuthStore } from '@/lib/stores/authStore';
import { useDocumentTitle } from '@/lib/stores/configStore';
import { cn } from '@/lib/utils';
import { FeatureGate } from '@/routes/common/FeatureGate';
import { CalendarDialog, EventDialog } from './CalendarDialogs';
import { CalendarViews, useRovingDays } from './CalendarViews';
import {
	automationTarget,
	type CalendarViewMode,
	calendarColour,
	dayKey,
	dayName,
	defaultCalendarId,
	headerText,
	isSameDay,
	localeWeekStart,
	monthGrid,
	monthLabel,
	readHidden,
	SCHEDULED_TASKS_ID,
	stepDate,
	visibleRange,
	weekdayName,
	writeHidden
} from './calendarModel';

const VIEWS: { value: CalendarViewMode; label: string }[] = [
	{ value: 'month', label: 'Month' },
	{ value: 'week', label: 'Week' },
	{ value: 'day', label: 'Day' }
];

/** A row's menu button: shown on hover and on focus, always on touch (A11Y-4); transparent, not removed, so focus can return to it. */
const rowMenuButton =
	'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100';

/**
 * Ports components/calendar/CalendarSidebar.svelte: a mini month to jump
 * around in, and the calendar list: show or hide each one (remembered in this
 * browser, S6-D9), and a menu on each of your own (#1106).
 */
function CalendarSidebar({
	calendars,
	userId,
	hidden,
	date,
	weekStart,
	onToggle,
	onCreate,
	onEdit,
	onMakeDefault,
	onDelete,
	onSelectDate
}: {
	calendars: CalendarModel[];
	userId?: string;
	hidden: Set<string>;
	date: Date;
	weekStart: number;
	onToggle: (id: string) => void;
	onCreate: () => void;
	onEdit: (c: CalendarModel) => void;
	onMakeDefault: (c: CalendarModel) => void;
	onDelete: (c: CalendarModel) => void;
	onSelectDate: (d: Date) => void;
}) {
	// The mini calendar pages on its own, and follows the main date when that changes.
	const [mini, setMini] = useState(() => new Date(date.getFullYear(), date.getMonth(), 1));
	useEffect(() => setMini(new Date(date.getFullYear(), date.getMonth(), 1)), [date]);
	const days = useMemo(() => monthGrid(mini, weekStart), [mini, weekStart]);
	const roving = useRovingDays(days, date, (d) => setMini(new Date(d.getFullYear(), d.getMonth(), 1)));
	const today = new Date();
	return (
		<div className="flex flex-col gap-6">
			<div>
				<div className="mb-1 flex items-center justify-between gap-2 px-1">
					{/* Not a heading: it repeats the toolbar's month most of the time. */}
					<div className="text-body font-strong">{monthLabel(mini)}</div>
					<div className="flex items-center gap-0.5">
						<Tip content="Previous month">
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								aria-label="Previous month"
								onClick={() => setMini(new Date(mini.getFullYear(), mini.getMonth() - 1, 1))}
							>
								<ChevronLeft aria-hidden className="size-3.5" />
							</Button>
						</Tip>
						<Tip content="Next month">
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								aria-label="Next month"
								onClick={() => setMini(new Date(mini.getFullYear(), mini.getMonth() + 1, 1))}
							>
								<ChevronRight aria-hidden className="size-3.5" />
							</Button>
						</Tip>
					</div>
				</div>
				<div aria-hidden className="text-foreground-muted grid grid-cols-7 text-center text-caption">
					{days.slice(0, 7).map((d) => (
						<div key={dayKey(d)} className="py-0.5">
							{weekdayName(d, 'narrow')}
						</div>
					))}
				</div>
				<div className="grid grid-cols-7 justify-items-center text-caption">
					{days.map((day) => (
						<Button
							key={dayKey(day)}
							{...roving(day)}
							type="button"
							variant={isSameDay(day, today) ? 'default' : isSameDay(day, date) ? 'secondary' : 'ghost'}
							size="icon-xs"
							aria-label={dayName(day)}
							aria-current={isSameDay(day, date) ? 'true' : undefined}
							className={cn(
								'rounded-full text-caption font-normal',
								day.getMonth() !== mini.getMonth() && !isSameDay(day, today) && 'text-foreground-muted'
							)}
							onClick={() => onSelectDate(day)}
						>
							{day.getDate()}
						</Button>
					))}
				</div>
			</div>
			<div>
				<div className="mb-1 flex items-center justify-between px-1">
					<h2 className="text-body font-strong">Calendars</h2>
					<Tip content="New calendar">
						<Button type="button" variant="ghost" size="icon-xs" aria-label="New calendar" onClick={onCreate}>
							<Plus aria-hidden className="size-3.5" />
						</Button>
					</Tip>
				</div>
				<ul className="flex flex-col gap-0.5">
					{calendars.map((c) => {
						const shown = !hidden.has(c.id);
						const colour = calendarColour(c);
						const own = c.id !== SCHEDULED_TASKS_ID && !c.is_system && (!userId || !c.user_id || c.user_id === userId);
						return (
							<li key={c.id} className="group flex items-center gap-0.5">
								<Button
									type="button"
									variant="ghost"
									aria-pressed={shown}
									className="min-w-0 flex-1 shrink justify-start gap-2 px-2 text-left font-normal"
									onClick={() => onToggle(c.id)}
								>
									{/* Shown: a filled box with a tick. Hidden: an empty one in the same colour. */}
									<span
										aria-hidden
										className="flex size-4 shrink-0 items-center justify-center rounded border-2"
										style={{ borderColor: colour, backgroundColor: shown ? colour : 'transparent' }}
									>
										{shown && <Check className="text-page size-3" strokeWidth={3} />}
									</span>
									<span className={cn('flex-1 truncate', !shown && 'text-foreground-muted')}>{c.name}</span>
									{c.is_default && <span className="text-foreground-muted text-caption">Default</span>}
								</Button>
								{own && (
									<DropdownMenu>
										<Tip content={`More actions for ${c.name}`}>
											<DropdownMenuTrigger asChild>
												<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													aria-label={`More actions for ${c.name}`}
													className={rowMenuButton}
												>
													<Ellipsis aria-hidden />
												</Button>
											</DropdownMenuTrigger>
										</Tip>
										<DropdownMenuContent align="end">
											<DropdownMenuItem onSelect={() => onEdit(c)}>Edit calendar</DropdownMenuItem>
											{!c.is_default && (
												<>
													<DropdownMenuItem onSelect={() => onMakeDefault(c)}>Make default</DropdownMenuItem>
													<DropdownMenuSeparator />
													<DropdownMenuItem variant="destructive" onSelect={() => onDelete(c)}>
														Delete calendar
													</DropdownMenuItem>
												</>
											)}
										</DropdownMenuContent>
									</DropdownMenu>
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
 * Ports routes/(app)/calendar/+page.svelte: month, week and day views of the
 * user's calendars, under the page's header (#1040) and a toolbar with the
 * month, the arrows, Today and the view. Pressing empty space creates an event
 * there; an automation's run opens what it produced. Events are fetched per
 * visible window (TanStack Query, keyed by the window), so paging back is
 * instant. Weeks start on the locale's first day (S6-D12).
 *
 * Below 768 px the page opens in Day view (S6-D11), the month shows dots and
 * the chosen day's agenda, and the calendar list is a sheet from the toolbar
 * (#965). Hidden calendars are remembered in this browser (S6-D9), as
 * "hidden", not "visible", so a calendar created later shows up.
 */
function Calendar() {
	const token = useAuthStore((s) => s.token) ?? '';
	const userId = useAuthStore((s) => s.user?.id);
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	useDocumentTitle('Calendar');
	const wide = useMdUp();
	const weekStart = useMemo(() => localeWeekStart(), []);
	const [view, setView] = useState<CalendarViewMode>(() => (wide ? 'month' : 'day'));
	const [date, setDate] = useState(() => new Date());
	const [hidden, setHidden] = useState<Set<string>>(readHidden);
	const [eventDialog, setEventDialog] = useState<{ event: CalendarEventModel | null; startAt: number | null } | null>(
		null
	);
	const [calendarDialog, setCalendarDialog] = useState<{ calendar: CalendarModel | null } | null>(null);
	const [deleting, setDeleting] = useState<CalendarModel | null>(null);
	const [listOpen, setListOpen] = useState(false);

	const calendars = useQuery({
		queryKey: ['calendars'],
		queryFn: async () => (await getCalendars(token)) ?? []
	});
	const range = visibleRange(view, date, weekStart);
	const events = useQuery({
		queryKey: ['calendar-events', range.start, range.end],
		queryFn: () => getCalendarEvents(token, range.start, range.end),
		placeholderData: (prev) => prev
	});
	// A failed load is shown in place of what it would have filled (STA-4). The
	// events kept on screen while a new range loads belong to the old range, so
	// a range that cannot load is not shown as them.
	const calendarsFailed = calendars.isError || (calendars.isPaused && calendars.data === undefined);
	const eventsFailed = events.isError || (events.isPaused && (events.data === undefined || events.isPlaceholderData));

	const list = calendars.data ?? [];
	const visibleEvents = (events.data ?? []).filter((e) => !hidden.has(e.calendar_id));
	const refreshEvents = () => queryClient.invalidateQueries({ queryKey: ['calendar-events'] });
	const refreshAll = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['calendars'] }), refreshEvents()]);

	const openEvent = (e: CalendarEventModel) => {
		const target = automationTarget(e);
		if (target) navigate(target);
		else setEventDialog({ event: e, startAt: null });
	};

	const toggle = (id: string) =>
		setHidden((prev) => {
			const next = new Set(prev);
			if (!next.delete(id)) next.add(id);
			writeHidden(next);
			return next;
		});

	const makeDefault = async (c: CalendarModel) => {
		try {
			await setDefaultCalendar(token, c.id);
			toast.success(`“${c.name}” is now the default calendar`);
			await refreshAll();
		} catch (err) {
			toastFailure(`Couldn’t make “${c.name}” the default calendar`, err);
		}
	};

	const removeCalendar = async () => {
		if (!deleting) return;
		const name = deleting.name;
		try {
			const ok = await deleteCalendar(token, deleting.id);
			if (ok) {
				toast.success('Calendar deleted');
				await refreshAll();
			} else toastFailure(`Couldn’t delete “${name}”`);
		} catch (err) {
			toastFailure(`Couldn’t delete “${name}”`, err);
		}
		setDeleting(null);
	};

	if (calendarsFailed) {
		return (
			<LoadFailed
				what="calendars"
				error={calendars.error}
				onRetry={() => calendars.refetch()}
				retrying={calendars.isFetching}
			/>
		);
	}

	if (calendars.isLoading) {
		return (
			<div className="flex flex-1 items-center justify-center">
				<Spinner className="size-5" />
			</div>
		);
	}

	const sidebar = (onPicked?: () => void) => (
		<CalendarSidebar
			calendars={list}
			userId={userId}
			hidden={hidden}
			date={date}
			weekStart={weekStart}
			onToggle={toggle}
			onCreate={() => setCalendarDialog({ calendar: null })}
			onEdit={(c) => setCalendarDialog({ calendar: c })}
			onMakeDefault={makeDefault}
			onDelete={setDeleting}
			onSelectDate={(d) => {
				setDate(d);
				onPicked?.();
			}}
		/>
	);

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
			<CalendarDialog
				open={calendarDialog !== null}
				onOpenChange={(o) => !o && setCalendarDialog(null)}
				calendar={calendarDialog?.calendar ?? null}
				calendars={list}
				onSaved={refreshAll}
			/>
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title="Delete calendar"
				confirmLabel="Delete calendar"
				destructive
				onConfirm={removeCalendar}
			>
				Delete “{deleting?.name}”? Its events are deleted with it. This can’t be undone.
			</ConfirmDialog>
			{!wide && (
				<Sheet open={listOpen} onOpenChange={setListOpen}>
					<SheetContent
						side="left"
						className="w-80 max-w-[85%] overflow-y-auto p-4"
						// Focus the sheet itself, not its first button, whose tooltip would cover the close button.
						onOpenAutoFocus={(e) => {
							e.preventDefault();
							(e.currentTarget as HTMLElement | null)?.focus();
						}}
					>
						<SheetTitle className="text-title font-title tracking-tight">Calendars</SheetTitle>
						<SheetDescription className="sr-only">Jump to a date, and choose which calendars to show.</SheetDescription>
						{sidebar(() => setListOpen(false))}
					</SheetContent>
				</Sheet>
			)}

			<div className="px-4 pt-4 md:px-6">
				<PageHeader
					title="Calendar"
					description="Your events, and when your automations run, by month, week or day."
					action={
						<Button type="button" onClick={() => setEventDialog({ event: null, startAt: null })}>
							<Plus aria-hidden /> New event
						</Button>
					}
				/>
			</div>

			<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 md:px-6">
				<div className="flex min-w-0 items-center gap-1">
					<h2 className="text-title font-title min-w-0 truncate pr-1 tracking-tight">
						{headerText(view, date, !wide)}
					</h2>
					<Tip content="Previous">
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label="Previous"
							onClick={() => setDate(stepDate(view, date, -1))}
						>
							<ChevronLeft aria-hidden />
						</Button>
					</Tip>
					<Tip content="Next">
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label="Next"
							onClick={() => setDate(stepDate(view, date, 1))}
						>
							<ChevronRight aria-hidden />
						</Button>
					</Tip>
					<Tip content="Today">
						<Button type="button" variant="ghost" size="icon-sm" aria-label="Today" onClick={() => setDate(new Date())}>
							<CalendarCheck aria-hidden />
						</Button>
					</Tip>
				</div>
				<div className="ml-auto flex items-center gap-2 max-sm:w-full">
					<SegmentedControl aria-label="View" value={view} onValueChange={setView} options={VIEWS} />
					{!wide && (
						<Tip content="Calendars">
							<Button
								type="button"
								variant="outline"
								size="icon"
								aria-label="Calendars"
								onClick={() => setListOpen(true)}
							>
								<ListChecks aria-hidden />
							</Button>
						</Tip>
					)}
				</div>
			</div>

			<div className="flex min-h-0 flex-1">
				{wide && <aside className="w-60 shrink-0 overflow-y-auto pb-4 pl-6 pr-1">{sidebar()}</aside>}
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					{eventsFailed ? (
						<LoadFailed
							what="events"
							error={events.error}
							onRetry={() => events.refetch()}
							retrying={events.isFetching}
						/>
					) : (
						<CalendarViews
							view={view}
							date={date}
							events={visibleEvents}
							calendars={list}
							weekStart={weekStart}
							compact={!wide}
							onCreate={(startAt) => setEventDialog({ event: null, startAt })}
							onEventClick={openEvent}
							onOpenDay={(day) => {
								setDate(day);
								setView('day');
							}}
							onSelectDay={setDate}
						/>
					)}
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
