import type { CalendarEventForm, CalendarEventModel } from '@/lib/apis/calendar';

// The date arithmetic behind the Calendar page (routes/(app)/calendar and
// components/calendar/*.svelte). The backend stores times in *nanoseconds*
// since the epoch; everything shown is in the browser's local time zone.

export type CalendarViewMode = 'month' | 'week' | 'day';

export const NS = 1_000_000;
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The system calendar that holds automation runs: shown, never offered as a place to put an event. */
export const SCHEDULED_TASKS_ID = '__scheduled_tasks__';

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => {
	const r = new Date(d);
	r.setDate(r.getDate() + n);
	return r;
};

/** The Sunday on or before the 1st of `date`'s month: the first cell of a six-week month grid. */
export const monthGridStart = (date: Date) => {
	const first = new Date(date.getFullYear(), date.getMonth(), 1);
	return addDays(first, -first.getDay());
};

/** The 42 days of the month grid. */
export const monthGrid = (date: Date) => Array.from({ length: 42 }, (_, i) => addDays(monthGridStart(date), i));

/** The seven days (Sunday first) of `date`'s week. */
export const weekDays = (date: Date) => {
	const start = addDays(midnight(date), -date.getDay());
	return Array.from({ length: 7 }, (_, i) => addDays(start, i));
};

/** The window of events to fetch for a view, as ISO strings: the whole grid for a month, the week, or the day. */
export function visibleRange(view: CalendarViewMode, date: Date): { start: string; end: string } {
	const start = view === 'month' ? monthGridStart(date) : view === 'week' ? weekDays(date)[0] : midnight(date);
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

export const headerText = (view: CalendarViewMode, d: Date) =>
	view === 'day' ? `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}` : `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;

/** A local-midnight key for a day, for grouping events. */
export const dayKey = (d: Date) => String(midnight(d).getTime());

/** Events grouped by every local day they touch (an event spanning three days is under all three). */
export function eventsByDay(events: CalendarEventModel[]): Record<string, CalendarEventModel[]> {
	const map: Record<string, CalendarEventModel[]> = {};
	for (const e of events) {
		const start = midnight(new Date(e.start_at / NS));
		const last = Math.max(start.getTime(), midnight(new Date((e.end_at || e.start_at) / NS)).getTime());
		for (let d = start; d.getTime() <= last; d = addDays(d, 1)) (map[dayKey(d)] ??= []).push(e);
	}
	return map;
}

/** Events that *start* in a given local hour of a day (the week and day grids). */
export function eventsInHour(events: CalendarEventModel[], day: Date, hour: number): CalendarEventModel[] {
	const from = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour).getTime();
	return events.filter((e) => e.start_at / NS >= from && e.start_at / NS < from + 3_600_000);
}

export const formatHour = (h: number) => (h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`);

export const isSameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** A time in nanoseconds at a local date and hour. */
export const nsAt = (day: Date, hour: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour).getTime() * NS;

// --- the event form ------------------------------------------------------

export const REPEAT_RRULES: Record<string, string> = {
	daily: 'FREQ=DAILY',
	weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
	weekly: 'FREQ=WEEKLY',
	monthly: 'FREQ=MONTHLY',
	yearly: 'FREQ=YEARLY'
};

/** The repeat option for a stored RRULE; '' (no repeat) for none or for a rule the form cannot express. */
export function repeatFromRrule(rrule: string | null | undefined): string {
	if (!rrule) return '';
	const normalized = rrule.toUpperCase().replace(/\s/g, '');
	return Object.entries(REPEAT_RRULES).find(([, v]) => v === normalized)?.[0] ?? '';
}

/** `YYYY-MM-DD` and `HH:MM` in local time, for date/time inputs. */
export const nsToDate = (ns: number) => {
	const d = new Date(ns / NS);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const nsToTime = (ns: number) => new Date(ns / NS).toTimeString().slice(0, 5);
export const dateTimeToNs = (date: string, time: string) => new Date(`${date}T${time || '00:00'}`).getTime() * NS;

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

/**
 * The form's starting values: the event being edited; or a new one-hour event
 * at `defaultStartAt` (a clicked day or hour); or at the current time.
 */
export function eventFields(event: CalendarEventModel | null, defaultCalendarId: string, defaultStartAt: number | null, now = new Date()): EventFields {
	if (event) {
		return {
			title: event.title,
			description: event.description || '',
			calendarId: event.calendar_id,
			startDate: nsToDate(event.start_at),
			startTime: nsToTime(event.start_at),
			endDate: event.end_at ? nsToDate(event.end_at) : '',
			endTime: event.end_at ? nsToTime(event.end_at) : '',
			allDay: event.all_day,
			location: event.location || '',
			alertMinutes: event.meta?.alert_minutes ?? 10,
			repeat: repeatFromRrule(event.rrule)
		};
	}
	const start = defaultStartAt ?? now.getTime() * NS;
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

/**
 * The event to send, or the message to show. An all-day event runs 00:00 to
 * 23:59; an end before the start keeps the event's old length (0 for a new one).
 */
export function eventPayload(f: EventFields, editing: CalendarEventModel | null): { error: string } | { form: CalendarEventForm } {
	if (!f.title.trim()) return { error: 'Title is required' };
	if (!f.startDate) return { error: 'Date is required' };
	const start = dateTimeToNs(f.startDate, f.allDay ? '00:00' : f.startTime);
	let end = f.endDate ? dateTimeToNs(f.endDate, f.allDay ? '23:59' : f.endTime) : undefined;
	if (end !== undefined && end < start) end = start + (editing?.end_at && editing.end_at > editing.start_at ? editing.end_at - editing.start_at : 0);
	return {
		form: {
			calendar_id: f.calendarId,
			title: f.title.trim(),
			description: f.description.trim() || undefined,
			start_at: start,
			end_at: end,
			all_day: f.allDay,
			rrule: REPEAT_RRULES[f.repeat] || undefined,
			location: f.location.trim() || undefined,
			meta: { alert_minutes: f.alertMinutes }
		}
	};
}

/** The calendar a new event goes into: the default one, else the first real one. */
export const defaultCalendarId = (calendars: { id: string; is_default: boolean }[]) =>
	(calendars.find((c) => c.is_default) ?? calendars.find((c) => c.id !== SCHEDULED_TASKS_ID))?.id ?? '';

/** Where clicking an automation's run goes: its chat if it produced one, else the automation. Null for an ordinary event. */
export function automationTarget(e: CalendarEventModel): string | null {
	if (!e.meta?.automation_id) return null;
	return e.meta.chat_id ? `/c/${e.meta.chat_id}` : `/automations/${e.meta.automation_id}`;
}

