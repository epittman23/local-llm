import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { RowButton } from '@/components/ui/row-button';
import type { CalendarEventModel, CalendarModel } from '@/lib/apis/calendar';
import { cn } from '@/lib/utils';
import {
	addDays,
	bandItems,
	type CalendarViewMode,
	calendarColour,
	type DayItem,
	dayItems,
	dayKey,
	dayName,
	eventsByDay,
	formatHour,
	formatTime,
	isSameDay,
	isSpanning,
	layoutDay,
	monthGrid,
	NS,
	nsAt,
	runsTarget,
	timeRange,
	type WeekBar,
	weekBars,
	weekDays,
	weekdayName
} from './calendarModel';

const HOURS = Array.from({ length: 24 }, (_, i) => i);
/** A month cell shows this many rows of events, "+N more" included. */
const MONTH_SLOTS = 3;
/** Of them, at most this many are lanes of bars (all-day and multi-day events). */
const MONTH_LANES = 2;

/** A day's name with its weekday and how many things it holds: "16 November 2026, Monday, 3 events". */
export const monthCellName = (day: Date, count: number) =>
	`${dayName(day)}, ${weekdayName(day)}, ${count === 0 ? 'no events' : count === 1 ? '1 event' : `${count} events`}`;

/** Whether the pointer is coarse (touch), so targets grow to 44 px (LAY-3). Fine without `matchMedia`. */
function useCoarsePointer(): boolean {
	return useSyncExternalStore(
		(onChange) => {
			const mq = window.matchMedia?.('(pointer: coarse)');
			mq?.addEventListener('change', onChange);
			return () => mq?.removeEventListener('change', onChange);
		},
		() => window.matchMedia?.('(pointer: coarse)').matches ?? false,
		() => false
	);
}

/** The time now, updated each minute, for the now-line. */
function useNow(): Date {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const id = window.setInterval(() => setNow(new Date()), 60_000);
		return () => window.clearInterval(id);
	}, []);
	return now;
}

/**
 * NAV-5: a grid of day buttons is one tab stop. The arrow keys move a day or a
 * week, Home and End go to the ends of the week, and a move past the grid's
 * edge asks for that date (`onNavigate`), whose grid then holds it. The stop is
 * the day last focused while it is in the grid, else `current`, else the first.
 */
export function useRovingDays(days: Date[], current: Date, onNavigate?: (day: Date) => void) {
	const [cursor, setCursor] = useState<Date | null>(null);
	const pending = useRef<string | null>(null);
	const buttons = useRef(new Map<string, HTMLElement>());
	const inGrid = (d: Date | null) => d !== null && days.some((day) => isSameDay(day, d));
	const active = inGrid(cursor) ? (cursor as Date) : inGrid(current) ? current : days[0];

	useEffect(() => {
		if (pending.current === null) return;
		const button = buttons.current.get(pending.current);
		if (button) {
			pending.current = null;
			button.focus();
		}
	});

	const move = (to: Date) => {
		pending.current = dayKey(to);
		setCursor(to);
		if (!inGrid(to)) onNavigate?.(to);
	};

	return (day: Date) => ({
		ref: (el: HTMLElement | null) => {
			if (el) buttons.current.set(dayKey(day), el);
			else buttons.current.delete(dayKey(day));
		},
		tabIndex: isSameDay(day, active) ? 0 : -1,
		onFocus: () => setCursor(day),
		onKeyDown: (e: KeyboardEvent) => {
			const i = days.findIndex((d) => isSameDay(d, day));
			const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
			const to =
				step !== undefined
					? addDays(day, step)
					: e.key === 'Home'
						? days[i - (i % 7)]
						: e.key === 'End'
							? days[i - (i % 7) + 6]
							: null;
			if (!to) return;
			e.preventDefault();
			move(to);
		}
	});
}

/** The colour an event is drawn in: its own, else its calendar's. */
const eventColour = (e: CalendarEventModel, calendars: Record<string, CalendarModel>) =>
	e.color || calendarColour(calendars[e.calendar_id] ?? { id: e.calendar_id });

/** A tint of a colour on the panel, for a bar or block whose words are in the strong foreground (COL-2). */
const tint = (colour: string) => `color-mix(in srgb, ${colour} 24%, var(--surface-1))`;

/** For collapsed runs, "×24" after the title, read as ", 24 runs". It never truncates, so the count stays in view. */
function RunCount({ item }: { item: DayItem }) {
	if (item.kind !== 'runs') return null;
	return (
		<span className="shrink-0">
			<span aria-hidden>×{item.count}</span>
			<span className="sr-only">, {item.count} runs</span>
		</span>
	);
}

const tipText = (e: CalendarEventModel) => `${e.title}${e.location ? ` · ${e.location}` : ''}`;

/**
 * One item in a month cell or a band: a coloured dot, the start time (not for
 * all-day events, collapsed runs, or the band, where the start may be on an
 * earlier day), the title. Automation runs are in the muted foreground, never
 * dimmed (COL-2). 24 px tall, 44 on touch (LAY-3).
 */
function Chip({
	item,
	colour,
	onOpen,
	showTime
}: {
	item: DayItem;
	colour: string;
	onOpen: (item: DayItem) => void;
	showTime: boolean;
}) {
	const e = item.event;
	const time = showTime && item.kind === 'event' && !e.all_day ? formatTime(e.start_at / NS) : null;
	return (
		<Tip content={tipText(e)}>
			<RowButton
				className={cn(
					'pointer-events-auto flex min-h-6 items-center gap-1.5 px-1 pointer-coarse:min-h-11',
					e.meta?.automation_id && 'text-foreground-muted'
				)}
				onClick={(ev) => {
					ev.stopPropagation();
					onOpen(item);
				}}
			>
				<span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: colour }} />
				<span className="min-w-0 truncate">
					{time && <span className="text-foreground-muted">{time} </span>}
					{e.title}
				</span>
				<RunCount item={item} />
			</RowButton>
		</Tip>
	);
}

function More({ count, day, onClick }: { count: number; day: Date; onClick: () => void }) {
	return (
		<RowButton
			aria-label={`${count} more on ${dayName(day)}`}
			className="text-foreground-muted pointer-events-auto flex min-h-6 items-center px-1 pointer-coarse:min-h-11"
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
		>
			+{count} more
		</RowButton>
	);
}

type ViewProps = {
	view: CalendarViewMode;
	date: Date;
	events: CalendarEventModel[];
	calendars: CalendarModel[];
	weekStart: number;
	/** Below 768 px: month cells show dots and a count, with the chosen day's agenda below (S6-D11). */
	compact: boolean;
	onCreate: (startNs: number) => void;
	onEventClick: (e: CalendarEventModel) => void;
	onOpenDay: (day: Date) => void;
	/** A day chosen in the compact month, or reached with the arrow keys past the grid's edge. */
	onSelectDay: (day: Date) => void;
};

/**
 * Ports components/calendar/CalendarView.svelte: the month grid and the week
 * and day time grids.
 *
 * Month: each week is a CSS grid. A day's button fills its cell (pressing empty
 * space there asks for a 9 AM event that day, or chooses the day on a phone),
 * all-day and multi-day events are bars across their days (#1107), and the
 * day's own events, then automation runs collapsed per automation (#936),
 * fill the rest. Event chips sit beside the day button, never in it (#987),
 * and the day buttons are one tab stop (NAV-5).
 *
 * Week and day: events placed by start and end on a 24-hour grid (#937), with
 * overlapping events side by side, a now-line on today, and the grid opened
 * at 7 AM, or an hour before now on a day that includes today.
 */
export function CalendarViews(props: ViewProps) {
	const { events, calendars } = props;
	const byId = useMemo(() => Object.fromEntries(calendars.map((c) => [c.id, c])), [calendars]);
	const byDay = useMemo(() => eventsByDay(events), [events]);
	const navigate = useNavigate();
	const open = (item: DayItem) => {
		if (item.kind === 'runs') navigate(runsTarget(item.automationId));
		else props.onEventClick(item.event);
	};
	const colour = (item: DayItem) => eventColour(item.event, byId);
	if (props.view === 'month') return <MonthView {...props} byDay={byDay} colour={colour} open={open} byId={byId} />;
	return <TimeGrid {...props} byDay={byDay} colour={colour} open={open} byId={byId} />;
}

type Inner = ViewProps & {
	byDay: Record<string, CalendarEventModel[]>;
	colour: (item: DayItem) => string;
	open: (item: DayItem) => void;
	byId: Record<string, CalendarModel>;
};

function MonthView({ date, weekStart, compact, byDay, byId, colour, open, onCreate, onOpenDay, onSelectDay }: Inner) {
	const days = useMemo(() => monthGrid(date, weekStart), [date, weekStart]);
	const weeks = Array.from({ length: 6 }, (_, w) => days.slice(w * 7, w * 7 + 7));
	const roving = useRovingDays(days, date, onSelectDay);
	const today = new Date();
	const selected = dayItems(byDay[dayKey(date)] ?? []);

	return (
		<div className={cn('flex min-h-0 flex-1 flex-col px-4 pb-4', compact ? 'overflow-y-auto' : '')}>
			<div aria-hidden className="grid shrink-0 grid-cols-7">
				{days.slice(0, 7).map((d) => (
					<div key={dayKey(d)} className="text-foreground-muted truncate px-2 py-1 text-caption">
						{weekdayName(d, compact ? 'narrow' : 'short')}
					</div>
				))}
			</div>
			<div
				className={cn(
					'bg-background flex flex-col overflow-hidden rounded-panel border',
					compact ? 'shrink-0' : 'min-h-0 flex-1 overflow-y-auto'
				)}
			>
				{weeks.map((week, w) => {
					const bars = compact ? [] : weekBars(week.flatMap((d) => byDay[dayKey(d)] ?? []).filter(unique), week);
					const lanes = Math.min(
						MONTH_LANES,
						bars.reduce((n, b) => Math.max(n, b.lane + 1), 0)
					);
					return (
						<div
							key={dayKey(week[0])}
							className={cn('grid grid-cols-7', w > 0 && 'border-t', compact ? 'min-h-14' : 'min-h-28 flex-1')}
							style={{ gridTemplateRows: lanes ? `auto repeat(${lanes}, auto) 1fr` : 'auto 1fr' }}
						>
							{week.map((day, i) => {
								const all = byDay[dayKey(day)] ?? [];
								const count = dayItems(all).length;
								const outside = day.getMonth() !== date.getMonth();
								return (
									<RowButton
										key={dayKey(day)}
										{...roving(day)}
										aria-label={monthCellName(day, count)}
										aria-current={compact && isSameDay(day, date) ? 'true' : undefined}
										data-outside-month={outside || undefined}
										style={{ gridColumn: i + 1, gridRow: '1 / -1' }}
										className={cn(
											'flex flex-col items-start gap-1 rounded-none p-1',
											i > 0 && 'border-l',
											compact && 'items-center'
										)}
										onClick={() => (compact ? onSelectDay(day) : onCreate(nsAt(day, 9)))}
									>
										<span
											className={cn(
												'flex size-6 shrink-0 items-center justify-center rounded-full text-caption',
												// Another month's days are muted, never dimmed (COL-2).
												isSameDay(day, today)
													? 'bg-brand text-brand-foreground'
													: outside
														? 'text-foreground-muted'
														: 'text-foreground'
											)}
										>
											{day.getDate()}
										</span>
										{compact && count > 0 && <Dots items={dayItems(all)} colour={colour} />}
									</RowButton>
								);
							})}
							{!compact && (
								<>
									<div aria-hidden className="h-7" style={{ gridColumn: 1, gridRow: 1 }} />
									{bars
										.filter((b) => b.lane < lanes)
										.map((bar) => (
											<Bar
												key={`${bar.event.instance_id || bar.event.id}`}
												bar={bar}
												colour={eventColour(bar.event, byId)}
												onOpen={open}
											/>
										))}
									{week.map((day, i) => (
										<DayList
											key={dayKey(day)}
											day={day}
											column={i + 1}
											row={lanes + 2}
											events={byDay[dayKey(day)] ?? []}
											hiddenBars={bars.filter((b) => b.lane >= lanes && b.from <= i && i < b.from + b.span).length}
											free={MONTH_SLOTS - lanes}
											colour={colour}
											onOpen={open}
											onMore={() => onOpenDay(day)}
										/>
									))}
								</>
							)}
						</div>
					);
				})}
			</div>
			{compact && <Agenda day={date} items={selected} colour={colour} onOpen={open} onCreate={onCreate} />}
		</div>
	);
}

/** Each event once, though a multi-day one is listed under every day it touches. */
function unique(e: CalendarEventModel, i: number, all: CalendarEventModel[]) {
	return all.findIndex((x) => (x.instance_id || x.id) === (e.instance_id || e.id)) === i;
}

/** A compact month cell's events: up to three coloured dots, then the count when there are more. */
function Dots({ items, colour }: { items: DayItem[]; colour: (item: DayItem) => string }) {
	return (
		<span aria-hidden className="text-foreground-muted flex items-center gap-0.5 text-caption">
			{items.slice(0, 3).map((item) => (
				<span key={item.key} className="size-1.5 rounded-full" style={{ backgroundColor: colour(item) }} />
			))}
			{/* The whole count, drawn by CSS: the day's name says it, so it is not text the name must contain (A11Y-2). */}
			{items.length > 3 && <span data-count={items.length} className="before:content-[attr(data-count)]" />}
		</span>
	);
}

/** An all-day or multi-day event's bar across the days it covers in one week. */
function Bar({ bar, colour, onOpen }: { bar: WeekBar; colour: string; onOpen: (item: DayItem) => void }) {
	const e = bar.event;
	const item: DayItem = { kind: 'event', key: e.instance_id || e.id, event: e };
	return (
		<div
			className="relative min-w-0 px-0.5 pb-0.5"
			style={{ gridColumn: `${bar.from + 1} / span ${bar.span}`, gridRow: bar.lane + 2 }}
		>
			<Tip content={tipText(e)}>
				<RowButton
					data-bar=""
					className={cn(
						'text-foreground-strong flex min-h-6 items-center gap-1.5 px-1.5 hover:brightness-110 pointer-coarse:min-h-11',
						bar.startsBefore && 'rounded-l-none',
						bar.endsAfter && 'rounded-r-none'
					)}
					style={{ backgroundColor: tint(colour) }}
					onClick={() => onOpen(item)}
				>
					<span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: colour }} />
					<span className="min-w-0 truncate">
						{!e.all_day && !bar.startsBefore && (
							<span className="text-foreground-muted">{formatTime(e.start_at / NS)} </span>
						)}
						{e.title}
					</span>
				</RowButton>
			</Tip>
		</div>
	);
}

/** A month cell's own events and runs, under the week's bars, with "+N more" when they do not fit. */
function DayList({
	day,
	column,
	row,
	events,
	hiddenBars,
	free,
	colour,
	onOpen,
	onMore
}: {
	day: Date;
	column: number;
	row: number;
	events: CalendarEventModel[];
	hiddenBars: number;
	free: number;
	colour: (item: DayItem) => string;
	onOpen: (item: DayItem) => void;
	onMore: () => void;
}) {
	const items = dayItems(events.filter((e) => !isSpanning(e)));
	const fits = items.length + hiddenBars <= free;
	const shown = fits ? items : items.slice(0, Math.max(free - 1, 0));
	const more = items.length - shown.length + hiddenBars;
	return (
		<div
			className="pointer-events-none relative flex min-w-0 flex-col gap-0.5 px-0.5 pb-1"
			style={{ gridColumn: column, gridRow: row }}
		>
			{shown.map((item) => (
				<Chip key={item.key} item={item} colour={colour(item)} onOpen={onOpen} showTime />
			))}
			{more > 0 && <More count={more} day={day} onClick={onMore} />}
		</div>
	);
}

/** The chosen day's events under the compact month (S6-D11). */
function Agenda({
	day,
	items,
	colour,
	onOpen,
	onCreate
}: {
	day: Date;
	items: DayItem[];
	colour: (item: DayItem) => string;
	onOpen: (item: DayItem) => void;
	onCreate: (startNs: number) => void;
}) {
	const label = day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
	return (
		<section aria-labelledby="calendar-agenda" className="flex flex-col gap-2 pt-4">
			<h3 id="calendar-agenda" className="text-body font-strong">
				{label}
			</h3>
			{items.length === 0 ? (
				<div className="flex flex-col items-start gap-2">
					<p className="text-foreground-muted">Nothing on this day.</p>
					<Button type="button" variant="outline" onClick={() => onCreate(nsAt(day, 9))}>
						New event on this day
					</Button>
				</div>
			) : (
				<ul className="flex flex-col gap-1">
					{items.map((item) => (
						<li key={item.key}>
							<RowButton className="flex items-start gap-3 px-2 py-2" onClick={() => onOpen(item)}>
								<span
									aria-hidden
									className="mt-1.5 size-2.5 shrink-0 rounded-full"
									style={{ backgroundColor: colour(item) }}
								/>
								<span className="flex min-w-0 flex-col">
									<span className="flex min-w-0 gap-1.5 font-strong">
										<span className="truncate">{item.event.title}</span>
										<RunCount item={item} />
									</span>
									<span className="text-foreground-muted text-dense">
										{item.kind === 'runs'
											? `From ${formatTime(item.event.start_at / NS)}`
											: item.event.all_day
												? 'All day'
												: timeRange(item.event)}
									</span>
								</span>
							</RowButton>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function TimeGrid({ view, date, weekStart, byDay, colour, open, onCreate, onOpenDay }: Inner) {
	const coarse = useCoarsePointer();
	const hour = coarse ? 64 : 48;
	// A block is at least 24 px tall, 44 on touch (LAY-3): that many minutes on this grid.
	const minPx = coarse ? 44 : 24;
	const minMinutes = Math.ceil((minPx / hour) * 60);
	const days = useMemo(() => (view === 'week' ? weekDays(date, weekStart) : [date]), [view, date, weekStart]);
	const now = useNow();
	const scroller = useRef<HTMLDivElement>(null);
	// Opens at 7 AM, or an hour before now when today is shown; again for each new week or day, not each minute.
	useLayoutEffect(() => {
		const current = new Date();
		const target = days.some((d) => isSameDay(d, current)) ? Math.max(current.getHours() - 1, 0) : 7;
		if (scroller.current) scroller.current.scrollTop = target * hour;
	}, [days, hour]);

	const columns = view === 'week' ? 'grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]' : 'grid-cols-[3.5rem_minmax(0,1fr)]';
	const items = days.map((day) => dayItems(byDay[dayKey(day)] ?? []));
	const bands = days.map((day, i) => bandItems(items[i], day));
	return (
		<div className="flex min-h-0 flex-1 flex-col px-4 pb-4">
			<div
				ref={scroller}
				data-testid="time-grid"
				// No scroll anchoring: the band arriving with the events would push the opening hour out of view.
				className="bg-background min-h-0 flex-1 overflow-auto rounded-panel border [overflow-anchor:none]"
			>
				<div className={cn('flex flex-col', view === 'week' && 'min-w-[43.75rem]')}>
					{/* The day names and the band stay in view while the hours scroll under them. */}
					<div className="bg-background sticky top-0 z-10">
						{view === 'week' && (
							<div className={cn('grid border-b', columns)}>
								<div className="bg-background sticky left-0 z-1" />
								{days.map((day, i) => (
									<div key={dayKey(day)} className={cn('py-2 text-center', i > 0 && 'border-l')}>
										<div className="text-foreground-muted text-caption">{weekdayName(day, 'short')}</div>
										<div
											className={cn(
												'mx-auto mt-0.5 flex size-7 items-center justify-center rounded-full',
												isSameDay(day, now) && 'bg-brand text-brand-foreground'
											)}
										>
											{day.getDate()}
										</div>
									</div>
								))}
							</div>
						)}
						{bands.some((band) => band.length > 0) && (
							<section aria-label="All-day events and runs" className={cn('grid border-b', columns)}>
								<div className="text-foreground-muted bg-background sticky left-0 z-1 pt-1.5 pr-2 text-right text-caption select-none">
									All day
								</div>
								{days.map((day, i) => {
									const shown = view === 'week' ? bands[i].slice(0, 3) : bands[i];
									return (
										<ul
											key={dayKey(day)}
											aria-label={dayName(day)}
											className="flex min-w-0 flex-col gap-0.5 border-l p-0.5"
										>
											{shown.map((item) => (
												<li key={item.key}>
													<Chip item={item} colour={colour(item)} onOpen={open} showTime={false} />
												</li>
											))}
											{view === 'week' && bands[i].length > 3 && (
												<li>
													<More count={bands[i].length - 3} day={day} onClick={() => onOpenDay(day)} />
												</li>
											)}
										</ul>
									);
								})}
							</section>
						)}
					</div>
					<div className={cn('grid', columns)}>
						{/* The hours stay in view while a week wider than the screen scrolls sideways (a phone). */}
						<div
							aria-hidden
							data-testid="hour-column"
							className="bg-background sticky left-0 z-1"
							style={{ height: 24 * hour }}
						>
							{HOURS.map((h) => (
								<div
									key={h}
									className="text-foreground-muted absolute right-2 text-caption select-none"
									style={{ top: h * hour + 2 }}
								>
									{formatHour(h)}
								</div>
							))}
						</div>
						{days.map((day, i) => {
							const isToday = isSameDay(day, now);
							const timed = items[i].filter((item) => !bands[i].includes(item)).map((item) => item.event);
							return (
								<div
									key={dayKey(day)}
									data-today={isToday || undefined}
									className={cn('relative border-l', isToday && 'bg-surface-1')}
									style={{ height: 24 * hour }}
								>
									{HOURS.map((h) => (
										<RowButton
											key={h}
											tabIndex={-1}
											aria-label={`New event ${dayName(day)}, ${formatHour(h)}`}
											className={cn('absolute inset-x-0 rounded-none', h > 0 && 'border-t')}
											style={{ top: h * hour, height: hour }}
											onClick={() => onCreate(nsAt(day, h))}
										/>
									))}
									{layoutDay(timed, day, minMinutes).map((p) => {
										const item = items[i].find((it) => it.event === p.event) as DayItem;
										const c = colour(item);
										const short = p.height * (hour / 60) < 40;
										return (
											<Tip key={item.key} content={tipText(p.event)}>
												<RowButton
													data-block=""
													className={cn(
														'text-foreground-strong absolute flex overflow-hidden border-l-4 px-1.5 py-0.5 text-dense hover:brightness-110',
														short ? 'items-center gap-1.5' : 'flex-col',
														p.event.meta?.automation_id && 'text-foreground-muted'
													)}
													style={{
														top: p.top * (hour / 60),
														// A 1 px gap under a block, but never below the least height.
														height: Math.max(p.height * (hour / 60) - 1, minPx),
														left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
														width: `calc(${100 / p.cols}% - 4px)`,
														backgroundColor: tint(c),
														borderLeftColor: c
													}}
													onClick={() => open(item)}
												>
													<span className="min-w-0 truncate font-strong">{p.event.title}</span>
													<span className="min-w-0 truncate text-caption">{timeRange(p.event)}</span>
												</RowButton>
											</Tip>
										);
									})}
									{isToday && (
										<div
											aria-hidden
											data-now=""
											className="bg-brand pointer-events-none absolute inset-x-0 h-0.5"
											style={{ top: (now.getHours() * 60 + now.getMinutes()) * (hour / 60) }}
										>
											<span className="bg-brand absolute -top-1 -left-1 size-2.5 rounded-full" />
										</div>
									)}
								</div>
							);
						})}
					</div>
				</div>
			</div>
		</div>
	);
}
