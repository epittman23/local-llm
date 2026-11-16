import type { CalendarEventForm, CalendarEventModel } from '@/lib/apis/calendar';
import { runTarget } from '@/routes/automations/automationModel';

// The date arithmetic behind the Calendar page (routes/(app)/calendar and
// components/calendar/*.svelte). The backend stores times in *nanoseconds*
// since the epoch; everything shown is in the browser's local time zone.

export type CalendarViewMode = 'month' | 'week' | 'day';

export const NS = 1_000_000;

// --- the locale (S6-D12, #1107) --------------------------------------------
// Day and month names, times and the first day of the week come from the
// browser's locale through Intl: Monday for most of Europe, Sunday for en-US,
// "9:00 AM" with its space. There is no setting.

/** Regions whose week starts on Sunday (0) or Saturday (6), from CLDR, for a browser without `Intl.Locale` week info. */
const SUNDAY_REGIONS =
	'AG AS BD BR BS BT BW BZ CA CN CO DM DO ET GT GU HK HN ID IL IN JM JP KE KH KR LA MH MM MO MT MX MZ NI NP PA PE PH PK PR PT PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW';
const SATURDAY_REGIONS = 'AE AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY';

type WeekInfoLocale = Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };

/** The first day of the week in `locale` (the browser's by default), as a JS day: 0 Sunday to 6 Saturday. */
export function localeWeekStart(locale?: string): number {
	try {
		const loc = new Intl.Locale(locale ?? navigator.language) as WeekInfoLocale;
		const info = loc.getWeekInfo?.() ?? loc.weekInfo;
		// Intl numbers the days 1 (Monday) to 7 (Sunday).
		if (info) return info.firstDay % 7;
		const region = loc.maximize().region ?? '';
		return SUNDAY_REGIONS.includes(region) ? 0 : SATURDAY_REGIONS.includes(region) ? 6 : 1;
	} catch {
		return 0;
	}
}

/** A day's name in the locale: "Monday", "Mon" or "M". */
export const weekdayName = (d: Date, style: 'long' | 'short' | 'narrow' = 'long') =>
	d.toLocaleDateString(undefined, { weekday: style });

/** "November 2026". */
export const monthLabel = (d: Date) => d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

/** A time of day in the locale's own format: "9:00 AM", "09:00". */
export const formatTime = (ms: number) =>
	new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** An hour's label on the time grid, in the locale's format: "12 AM", "9 AM", or "00", "09". */
export const formatHour = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });

/** The system calendar that holds automation runs: shown, never offered as a place to put an event. */
export const SCHEDULED_TASKS_ID = '__scheduled_tasks__';

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number) => {
	const r = new Date(d);
	r.setDate(r.getDate() + n);
	return r;
};

/** How far `d` is into its week, in days, for a week that starts on `weekStart` (0 Sunday to 6 Saturday). */
const intoWeek = (d: Date, weekStart: number) => (d.getDay() - weekStart + 7) % 7;

/** The first cell of a six-week month grid: the first day of the week on or before the 1st of `date`'s month. */
export const monthGridStart = (date: Date, weekStart = 0) => {
	const first = new Date(date.getFullYear(), date.getMonth(), 1);
	return addDays(first, -intoWeek(first, weekStart));
};

/** The 42 days of the month grid. */
export const monthGrid = (date: Date, weekStart = 0) =>
	Array.from({ length: 42 }, (_, i) => addDays(monthGridStart(date, weekStart), i));

/** The seven days of `date`'s week, from `weekStart`. */
export const weekDays = (date: Date, weekStart = 0) => {
	const start = addDays(midnight(date), -intoWeek(date, weekStart));
	return Array.from({ length: 7 }, (_, i) => addDays(start, i));
};

/** The window of events to fetch for a view, as ISO strings: the whole grid for a month, the week, or the day. */
export function visibleRange(view: CalendarViewMode, date: Date, weekStart = 0): { start: string; end: string } {
	const start =
		view === 'month'
			? monthGridStart(date, weekStart)
			: view === 'week'
				? weekDays(date, weekStart)[0]
				: midnight(date);
	const end = addDays(start, view === 'month' ? 42 : view === 'week' ? 7 : 1);
	return { start: start.toISOString(), end: end.toISOString() };
}

/** One step back or forward: a month (from the 1st, so Jan 31 + 1 is February, not March), a week, or a day. */
export function stepDate(view: CalendarViewMode, date: Date, delta: number): Date {
	const d = new Date(date);
	if (view === 'month') {
		d.setDate(1);
		d.setMonth(d.getMonth() + delta);
	} else d.setDate(d.getDate() + delta * (view === 'week' ? 7 : 1));
	return d;
}

/** The toolbar's heading: the month, or the whole date in Day view, abbreviated where space is `short`. */
export const headerText = (view: CalendarViewMode, d: Date, short = false) =>
	view === 'day'
		? d.toLocaleDateString(undefined, {
				weekday: short ? 'short' : 'long',
				day: 'numeric',
				month: short ? 'short' : 'long',
				year: 'numeric'
			})
		: monthLabel(d);

/** "16 November 2026": the visible day number first, so a day's name contains what it shows (A11Y-2). */
export const dayName = (day: Date) => `${day.getDate()} ${monthLabel(day)}`;

/** A local-midnight key for a day, for grouping events. */
export const dayKey = (d: Date) => String(midnight(d).getTime());

/** The last moment an event covers: its end, which is exclusive, or its start when it has no length. */
const lastMoment = (e: CalendarEventModel) => (e.end_at && e.end_at > e.start_at ? e.end_at / NS - 1 : e.start_at / NS);

/**
 * Events grouped by every local day they touch (an event spanning three days is under all three).
 * The end is exclusive, so an event that ends at midnight is not on the day that midnight starts.
 */
export function eventsByDay(events: CalendarEventModel[]): Record<string, CalendarEventModel[]> {
	const map: Record<string, CalendarEventModel[]> = {};
	for (const e of events) {
		const start = midnight(new Date(e.start_at / NS));
		const last = Math.max(start.getTime(), midnight(new Date(lastMoment(e))).getTime());
		for (let d = start; d.getTime() <= last; d = addDays(d, 1)) {
			const key = dayKey(d);
			map[key] = [...(map[key] ?? []), e];
		}
	}
	return map;
}

export const isSameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

// --- what a day shows (#936) ---------------------------------------------

export const eventKey = (e: CalendarEventModel) => e.instance_id || e.id;
const isRun = (e: CalendarEventModel) => Boolean(e.meta?.automation_id);
/** All-day events first, then by start. */
const byStart = (a: CalendarEventModel, b: CalendarEventModel) =>
	Number(b.all_day) - Number(a.all_day) || a.start_at - b.start_at;

/** One thing a day shows: an event, or one automation's runs that day collapsed into one (#936). */
export type DayItem =
	| { kind: 'event'; key: string; event: CalendarEventModel }
	| { kind: 'runs'; key: string; automationId: string; count: number; event: CalendarEventModel };

/**
 * A day's events in the order a cell shows them (#936): your own events first (all-day ones, then by
 * start), then automation runs. An automation that runs more than once that day is one item with a
 * count ("Daily digest ×24"), so a frequent automation never pushes your own events out of a cell.
 */
export function dayItems(events: CalendarEventModel[]): DayItem[] {
	const own: DayItem[] = events
		.filter((e) => !isRun(e))
		.sort(byStart)
		.map((e) => ({ kind: 'event', key: eventKey(e), event: e }));
	const runs = new Map<string, CalendarEventModel[]>();
	for (const e of events) {
		if (!isRun(e)) continue;
		const id = String(e.meta?.automation_id);
		runs.set(id, [...(runs.get(id) ?? []), e]);
	}
	const collapsed = [...runs].map(([automationId, list]): DayItem => {
		const sorted = [...list].sort(byStart);
		return sorted.length === 1
			? { kind: 'event', key: eventKey(sorted[0]), event: sorted[0] }
			: { kind: 'runs', key: `runs-${automationId}`, automationId, count: sorted.length, event: sorted[0] };
	});
	return [...own, ...collapsed.sort((a, b) => a.event.start_at - b.event.start_at)];
}

/** Where a collapsed set of runs goes: its automation. */
export const runsTarget = (automationId: string) => `/automations/${automationId}`;

/**
 * The items in a day's band above the hours of the week and day grids: all-day events, timed events
 * that began on an earlier day and continue into this one, which have no start time here (#319), and
 * an automation's runs collapsed into one (#936), which have no single time.
 */
export function bandItems(items: DayItem[], day: Date): DayItem[] {
	const dayStart = midnight(day).getTime();
	return items.filter((i) => i.kind === 'runs' || i.event.all_day || i.event.start_at / NS < dayStart);
}

// --- the month grid's bars (#1107) ---------------------------------------

/** Whether an event is drawn as a bar across its days: all-day, or running past the day it starts. */
export function isSpanning(e: CalendarEventModel): boolean {
	if (e.all_day) return true;
	return midnight(new Date(e.start_at / NS)).getTime() !== midnight(new Date(lastMoment(e))).getTime();
}

/** One event's bar in one week of the month grid: its lane (row), and the days it covers, 0 to 6. */
export type WeekBar = {
	event: CalendarEventModel;
	lane: number;
	from: number;
	span: number;
	/** It began in an earlier week, or continues into a later one. */
	startsBefore: boolean;
	endsAfter: boolean;
};

/**
 * The bars of one week (`days`, seven local midnights): every all-day and multi-day event drawn once,
 * across the days it covers, each in the first lane free over all of them. Longer events take the
 * upper lanes, as they start.
 */
export function weekBars(events: CalendarEventModel[], days: Date[]): WeekBar[] {
	const first = midnight(days[0]).getTime();
	const last = midnight(days[days.length - 1]).getTime();
	const index = (ms: number) => days.findIndex((d) => midnight(d).getTime() === ms);
	const spans = events
		.filter(isSpanning)
		.map((event) => ({
			event,
			start: midnight(new Date(event.start_at / NS)).getTime(),
			end: Math.max(midnight(new Date(event.start_at / NS)).getTime(), midnight(new Date(lastMoment(event))).getTime())
		}))
		.filter((s) => s.end >= first && s.start <= last)
		.sort((a, b) => a.start - b.start || b.end - a.end);
	const lanes: boolean[][] = [];
	return spans.map(({ event, start, end }) => {
		const from = start < first ? 0 : index(start);
		const to = end > last ? days.length - 1 : index(end);
		let lane = lanes.findIndex((taken) => taken.slice(from, to + 1).every((t) => !t));
		if (lane < 0) lane = lanes.push(Array(days.length).fill(false)) - 1;
		for (let i = from; i <= to; i++) lanes[lane][i] = true;
		return { event, lane, from, span: to - from + 1, startsBefore: start < first, endsAfter: end > last };
	});
}

// --- the time grid (#937) --------------------------------------------------

/** A timed event placed on a day's time grid, in minutes from midnight; overlapping events share the width in columns. */
export type Placed = { event: CalendarEventModel; top: number; height: number; col: number; cols: number };

/**
 * The timed events that start on `day`, placed by their start and end on the local clock. An event is
 * at least `minMinutes` tall so it can be read and pressed; one that runs past midnight stops at the
 * day's end. Events that overlap, as drawn, are a cluster: each takes the first column free at its
 * start, and every event in the cluster is as wide as its number of columns allows.
 */
export function layoutDay(events: CalendarEventModel[], day: Date, minMinutes: number): Placed[] {
	const dayStart = midnight(day).getTime();
	const next = addDays(midnight(day), 1).getTime();
	const clock = (ms: number) => {
		const d = new Date(ms);
		return d.getHours() * 60 + d.getMinutes();
	};
	const items = events
		.filter((e) => !e.all_day && e.start_at / NS >= dayStart && e.start_at / NS < next)
		.map((event) => {
			const start = clock(event.start_at / NS);
			const endMs = event.end_at && event.end_at > event.start_at ? event.end_at / NS : event.start_at / NS;
			const end = endMs >= next ? 24 * 60 : Math.max(start, clock(endMs));
			const height = Math.min(Math.max(end - start, minMinutes), 24 * 60);
			// A short event late in the day is drawn up from midnight rather than past it.
			return { event, top: Math.min(start, 24 * 60 - height), height };
		})
		.sort((a, b) => a.top - b.top || b.height - a.height);
	const placed: Placed[] = [];
	let cluster: Placed[] = [];
	let columns: number[] = [];
	let clusterEnd = -1;
	const close = () => {
		for (const p of cluster) p.cols = columns.length;
		placed.push(...cluster);
		cluster = [];
		columns = [];
	};
	for (const item of items) {
		if (cluster.length && item.top >= clusterEnd) close();
		let col = columns.findIndex((end) => end <= item.top);
		if (col < 0) col = columns.push(0) - 1;
		columns[col] = item.top + item.height;
		clusterEnd = cluster.length ? Math.max(clusterEnd, columns[col]) : columns[col];
		cluster.push({ ...item, col, cols: 0 });
	}
	close();
	return placed;
}

/** "9:00 AM – 11:00 AM"; the start alone for an event with no length. */
export function timeRange(e: CalendarEventModel): string {
	const start = formatTime(e.start_at / NS);
	return e.end_at && e.end_at > e.start_at ? `${start} – ${formatTime(e.end_at / NS)}` : start;
}

/** A time in nanoseconds at a local date and hour. */
export const nsAt = (day: Date, hour: number) =>
	new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour).getTime() * NS;

// --- the event form ------------------------------------------------------

export const REPEAT_RRULES: Record<string, string> = {
	daily: 'FREQ=DAILY',
	weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
	weekly: 'FREQ=WEEKLY',
	monthly: 'FREQ=MONTHLY',
	yearly: 'FREQ=YEARLY'
};

/** The Repeat choice for a stored rule the menu cannot show: it keeps the rule as it is. */
export const CUSTOM_REPEAT = 'custom';

/**
 * The repeat option for a stored RRULE: '' (no repeat) for none, and
 * CUSTOM_REPEAT for a rule the form cannot express, so choosing No Repeat can
 * clear it (#510). A DTSTART line and an `RRULE:` prefix are ignored, as the
 * server ignores them when it repeats the event from its own start (#707).
 */
export function repeatFromRrule(rrule: string | null | undefined): string {
	if (!rrule) return '';
	const normalized = rrule
		.split('\n')
		.filter((line) => !line.trim().toUpperCase().startsWith('DTSTART'))
		.join('')
		.toUpperCase()
		.replace(/\s/g, '')
		.replace(/^RRULE:/, '');
	return Object.entries(REPEAT_RRULES).find(([, v]) => v === normalized)?.[0] ?? CUSTOM_REPEAT;
}

/** `YYYY-MM-DD` and `HH:MM` in local time, for date/time inputs. */
export const nsToDate = (ns: number) => {
	const d = new Date(ns / NS);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const nsToTime = (ns: number) => new Date(ns / NS).toTimeString().slice(0, 5);
export const dateTimeToNs = (date: string, time: string) => new Date(`${date}T${time || '00:00'}`).getTime() * NS;

/** The reminder choices the event form offers, as minutes before (-1: none). */
export const REMINDERS: [number, string][] = [
	[-1, 'None'],
	[0, 'At time of event'],
	[5, '5 minutes before'],
	[10, '10 minutes before'],
	[15, '15 minutes before'],
	[30, '30 minutes before'],
	[60, '1 hour before']
];

/**
 * The reminder choices, with the given values (the event's saved one and the
 * form's current one) added when they are not among them (#324). A reminder set elsewhere (the assistant's calendar tool, say,
 * at 120 minutes) showed as "None", and picking None then changed nothing.
 */
export function reminderOptions(...values: number[]): [number, string][] {
	const own = [...new Set(values)]
		.filter((minutes) => minutes >= 0 && !REMINDERS.some(([listed]) => listed === minutes))
		.map((minutes): [number, string] => [minutes, reminderLabel(minutes)]);
	return own.length ? [...REMINDERS, ...own].sort((a, b) => a[0] - b[0]) : REMINDERS;
}

/** The server sends a reminder at most this long before the event (`MAX_ALERT_LEAD_MINUTES`). */
const MAX_REMINDER_MINUTES = 22 * 60;

const leadLabel = (minutes: number) =>
	minutes % 60 === 0
		? `${minutes / 60} hour${minutes === 60 ? '' : 's'} before`
		: `${minutes} minute${minutes === 1 ? '' : 's'} before`;

const reminderLabel = (minutes: number) =>
	minutes > MAX_REMINDER_MINUTES
		? `${leadLabel(minutes)} (sent ${leadLabel(MAX_REMINDER_MINUTES)})`
		: leadLabel(minutes);

export type EventFields = {
	title: string;
	description: string;
	calendarId: string;
	startDate: string;
	startTime: string;
	endDate: string;
	endTime: string;
	allDay: boolean;
	location: string;
	alertMinutes: number;
	repeat: string;
};

/** The next :00 or :30 on the local clock at or after `now` (S6-D14, #1105): where a new event starts. */
export function nextHalfHour(now: Date): Date {
	const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());
	if (d.getTime() < now.getTime()) d.setMinutes(d.getMinutes() + 1);
	const m = d.getMinutes();
	if (m % 30) d.setMinutes(m + 30 - (m % 30));
	return d;
}

/**
 * The form's starting values: the event being edited; or a new one-hour event
 * at `defaultStartAt` (a clicked day or hour); or at the next :00 or :30.
 */
export function eventFields(
	event: CalendarEventModel | null,
	defaultCalendarId: string,
	defaultStartAt: number | null,
	now = new Date()
): EventFields {
	if (event) {
		// The grids read an end as exclusive, so an all-day event that ends at
		// midnight (as one made in chat can) ends on the day before it; the
		// form, which saves an all-day end as 23:59 of its date, shows that day.
		const lastAllDayMoment = event.all_day && event.end_at && event.end_at > event.start_at ? event.end_at - NS : null;
		return {
			title: event.title,
			description: event.description || '',
			calendarId: event.calendar_id,
			startDate: nsToDate(event.start_at),
			startTime: nsToTime(event.start_at),
			endDate: lastAllDayMoment ? nsToDate(lastAllDayMoment) : event.end_at ? nsToDate(event.end_at) : '',
			endTime: event.end_at ? nsToTime(event.end_at) : '',
			allDay: event.all_day,
			location: event.location || '',
			// Any negative means no reminder, as the server reads it.
			alertMinutes: Math.max(event.meta?.alert_minutes ?? 10, -1),
			repeat: repeatFromRrule(event.rrule)
		};
	}
	const start = defaultStartAt ?? nextHalfHour(now).getTime() * NS;
	const end = start + 3_600_000 * NS;
	return {
		title: '',
		description: '',
		calendarId: defaultCalendarId,
		startDate: nsToDate(start),
		startTime: nsToTime(start),
		endDate: nsToDate(end),
		endTime: nsToTime(end),
		allDay: false,
		location: '',
		alertMinutes: 10,
		repeat: ''
	};
}

/** `date` (YYYY-MM-DD) moved by `days` calendar days. */
const addDaysToDate = (date: string, days: number) => {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
};
/** Calendar days from one YYYY-MM-DD date to another. */
const daysBetween = (from: string, to: string) =>
	Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * The fields once the start has moved (#966): the end moves with it, so the
 * event keeps its length. An end that is blank, or not after the start, is
 * left where it is, and so is everything while a date or time is half typed.
 */
export function withStart(f: EventFields, patch: Partial<Pick<EventFields, 'startDate' | 'startTime'>>): EventFields {
	const next = { ...f, ...patch };
	if (!f.endDate || !f.startDate || !next.startDate || (!f.allDay && (!f.startTime || !next.startTime))) return next;
	if (f.allDay) {
		if (f.endDate < f.startDate) return next;
		return { ...next, endDate: addDaysToDate(f.endDate, daysBetween(f.startDate, next.startDate)) };
	}
	const oldStart = dateTimeToNs(f.startDate, f.startTime);
	const oldEnd = dateTimeToNs(f.endDate, f.endTime);
	if (!(oldEnd > oldStart)) return next;
	const end = dateTimeToNs(next.startDate, next.startTime) + (oldEnd - oldStart);
	return { ...next, endDate: nsToDate(end), endTime: nsToTime(end) };
}

/** The event form's fields that can be wrong, in page order. */
export const EVENT_FIELDS = ['title', 'start', 'end'] as const;
export type EventField = (typeof EVENT_FIELDS)[number];

/** What is wrong with the form now, by field (FRM-2): a title, a start, and an end after the start. */
export function eventProblems(f: EventFields): Partial<Record<EventField, string>> {
	const problems: Partial<Record<EventField, string>> = {};
	if (!f.title.trim()) problems.title = 'Enter a title';
	if (!f.startDate) problems.start = 'Enter a start date';
	else if (f.endDate) {
		const start = dateTimeToNs(f.startDate, f.allDay ? '00:00' : f.startTime);
		const end = dateTimeToNs(f.endDate, f.allDay ? '23:59' : f.endTime);
		if (!(end > start)) problems.end = 'End must be after start';
	}
	return problems;
}

/**
 * The event to send, or the message to show (the first of `eventProblems`).
 * An all-day event runs 00:00 to 23:59. An end before the start is refused,
 * never rewritten (#966): it was saved as a zero-length event.
 *
 * An occurrence of a repeating event (one with an `instance_id`) carries the
 * series' id but its own times, and saving it saves the series. With
 * `seriesStartAt`, the stored series' start, the series keeps its own first
 * date, moved by as many calendar days as the form moved the occurrence, at
 * the form's times; so a rename leaves the series where it was instead of
 * restarting it at this occurrence (#318). Days, not a duration, so a DST
 * change between the two dates does not shift it by an hour. A changed
 * repeat rule starts at the occurrence being edited instead.
 */
export function eventPayload(
	f: EventFields,
	editing: CalendarEventModel | null,
	seriesStartAt?: number
): { error: string } | { form: CalendarEventForm } {
	const problem = EVENT_FIELDS.map((field) => eventProblems(f)[field]).find(Boolean);
	if (problem) return { error: problem };
	let startDate = f.startDate;
	let endDate = f.endDate;
	if (editing?.instance_id && seriesStartAt !== undefined && f.repeat === repeatFromRrule(editing.rrule)) {
		const moved = daysBetween(nsToDate(editing.start_at), f.startDate);
		startDate = addDaysToDate(nsToDate(seriesStartAt), moved);
		if (endDate) endDate = addDaysToDate(startDate, daysBetween(f.startDate, endDate));
	}
	const start = dateTimeToNs(startDate, f.allDay ? '00:00' : f.startTime);
	const end = endDate ? dateTimeToNs(endDate, f.allDay ? '23:59' : f.endTime) : undefined;
	// An update keeps every field the request leaves out, so a field cleared
	// on an existing event is sent as null; left out, the old value stayed (#158).
	const blank = editing ? null : undefined;
	return {
		form: {
			calendar_id: f.calendarId,
			title: f.title.trim(),
			description: f.description.trim() || blank,
			start_at: start,
			end_at: end ?? blank,
			all_day: f.allDay,
			// A rule the Repeat menu cannot show opens as "Custom rule"; left out
			// while that is chosen, so the update keeps it. No Repeat clears it.
			// An unchanged choice sends the rule as it was stored (#707).
			rrule:
				f.repeat === CUSTOM_REPEAT
					? undefined
					: (editing && f.repeat === repeatFromRrule(editing.rrule) ? editing.rrule : REPEAT_RRULES[f.repeat]) || blank,
			location: f.location.trim() || blank,
			meta: { alert_minutes: f.alertMinutes }
		}
	};
}

/**
 * The calendar a new event goes into: the user's own default, else their
 * first own calendar, else the first real one. `is_default` is the owner's
 * flag, so a calendar shared with the user can carry it; listed first, it
 * took the event (#182).
 */
export function defaultCalendarId(
	calendars: { id: string; is_default: boolean; user_id?: string }[],
	userId?: string
): string {
	const real = calendars.filter((c) => c.id !== SCHEDULED_TASKS_ID);
	const own = userId ? real.filter((c) => c.user_id === userId) : real;
	return (own.find((c) => c.is_default) ?? own[0] ?? real[0])?.id ?? '';
}

/** The series token the Automations calendar is drawn in (S6-D10), whatever colour the server sends. */
export const AUTOMATIONS_COLOUR = 'var(--series-6)';

/** A calendar's colour: the Automations calendar's token, a stored colour, or `--series-1` for none (D1b). */
export const calendarColour = (c: { id: string; color?: string | null }) =>
	c.id === SCHEDULED_TASKS_ID ? AUTOMATIONS_COLOUR : c.color || 'var(--series-1)';

/** A `#rrggbb` colour's hue in degrees; null for a grey or anything else. */
function hue(colour: string): number | null {
	const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour.trim());
	if (!m) return null;
	const [r, g, b] = m.slice(1).map((x) => Number.parseInt(x, 16) / 255);
	const max = Math.max(r, g, b);
	const d = max - Math.min(r, g, b);
	if (d < 0.08) return null;
	const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return (h * 60 + 360) % 360;
}

/** Whether two colours would be taken for each other on the calendar: the same, or hues within 30°. */
function alike(a: string, b: string): boolean {
	if (a.toLowerCase() === b.toLowerCase()) return true;
	const [x, y] = [hue(a), hue(b)];
	if (x === null || y === null) return false;
	const d = Math.abs(x - y);
	return Math.min(d, 360 - d) < 30;
}

/**
 * A new calendar's starting colour (#1106): the first of `presets` (the series
 * tokens' values, `--series-1` first) unlike every colour a calendar is drawn
 * in, so a new calendar never looks like Personal (stored #3b82f6 and the
 * first preset are both blue). A calendar with no stored colour is drawn in
 * the first preset, and Automations in the sixth.
 */
export function firstFreeColour(presets: string[], calendars: { id: string; color?: string | null }[]): string {
	const used = calendars.map((c) => (c.id === SCHEDULED_TASKS_ID ? presets[5] : c.color || presets[0]));
	return presets.find((p) => !used.some((u) => alike(p, u))) ?? presets[0];
}

/** Where the calendars hidden in this browser are kept (S6-D9): only here, never on the server. */
export const HIDDEN_KEY = 'calendar.hidden';

/** The calendars hidden in this browser; none when storage cannot be read. */
export function readHidden(): Set<string> {
	try {
		const stored: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]');
		return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []);
	} catch {
		return new Set();
	}
}

/** Remembers the hidden calendars; where storage is refused they are kept for the visit only. */
export function writeHidden(hidden: Set<string>) {
	try {
		localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden]));
	} catch {
		// Private mode or storage turned off: the page keeps them until it is left.
	}
}

/**
 * Where clicking an automation's run goes: the chat or channel it posted to, else the
 * automation. Null for an ordinary event.
 */
export function automationTarget(e: CalendarEventModel): string | null {
	if (!e.meta?.automation_id) return null;
	return e.meta.chat_id ? runTarget(e.meta.chat_id) : `/automations/${e.meta.automation_id}`;
}
