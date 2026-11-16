import { RRule } from 'rrule';
import type { AutomationForm, AutomationResponse } from '@/lib/apis/automations';
import { errorMessage } from '@/lib/apis/errors';
import { routePaths } from '@/routes/routePaths';

// The rules behind the Automations surface: the schedule picker's RRULE
// round-trip (components/automations/ScheduleDropdown.svelte), the one-line
// schedule and destination summaries (the list page and AutomationEditor
// each carry their own copy of the formatter), the form, and import/export.

export type Frequency = 'ONCE' | 'MINUTELY' | 'HOURLY' | 'DAILY' | 'WEEKDAYS' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM';

/** The frequencies whose rule repeats every `interval` steps (#1032). */
export const HAS_INTERVAL: Frequency[] = ['MINUTELY', 'HOURLY', 'DAILY'];

export type Schedule = {
	frequency: Frequency;
	interval: number;
	hour: number;
	minute: number;
	days: string[];
	monthDay: number;
	onceDate: string;
	onceTime: string;
	custom: string;
};

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const WORKDAYS = WEEKDAYS.slice(0, 5);

/** Today's weekday code, which Weekly starts on (#1104). */
export const weekdayOf = (d: Date) => WEEKDAYS[(d.getDay() + 6) % 7];

const pad = (n: number) => String(n).padStart(2, '0');
/** Local `YYYY-MM-DD` (the Svelte picker used `toISOString`, which is the UTC date and is a day off in the evening west of Greenwich). */
export const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** A fresh schedule: daily at 9:00; a one-time run defaults to five minutes from now. */
export function defaultSchedule(now = new Date()): Schedule {
	const soon = new Date(now.getTime() + 5 * 60_000);
	return {
		frequency: 'DAILY',
		interval: 1,
		hour: 9,
		minute: 0,
		days: [],
		monthDay: 1,
		onceDate: localDate(soon),
		onceTime: `${pad(soon.getHours())}:${pad(soon.getMinutes())}`,
		custom: ''
	};
}

/** The RRULE's `KEY=VALUE` parts, ignoring any DTSTART line. */
function ruleParts(rrule: string): Record<string, string> {
	const parts: Record<string, string> = {};
	rrule
		.split(/\s+/)
		.filter((line) => !line.toUpperCase().startsWith('DTSTART'))
		.join('')
		.replace('RRULE:', '')
		.split(';')
		.forEach((p) => {
			const [k, v] = p.split('=');
			if (k && v) parts[k] = v;
		});
	return parts;
}

/**
 * The parts with spelling that does not change the rule evened out
 * (`INTERVAL=1` dropped, `09` read as `9`), for comparing two rules.
 */
function canonical(parts: Record<string, string>): string {
	return Object.entries(parts)
		.filter(([k, v]) => !(k === 'INTERVAL' && Number(v) === 1))
		.map(([k, v]) => `${k}=${/^\d+$/.test(v) ? String(Number(v)) : k === 'BYDAY' ? v.split(',').sort().join(',') : v}`)
		.sort()
		.join(';');
}

const ONCE = /COUNT=1(?!\d)/;
const DTSTART_LINE = /^\s*DTSTART/im;
const DTSTART = /DTSTART:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/;

/** Builds the RRULE for a schedule. `frequency` may be given to build a visual schedule while CUSTOM is selected. */
export function buildRrule(s: Schedule, frequency: Frequency = s.frequency): string {
	if (frequency === 'CUSTOM') return s.custom;
	if (frequency === 'ONCE')
		return `DTSTART:${s.onceDate.replace(/-/g, '')}T${s.onceTime.replace(/:/g, '')}00\nRRULE:FREQ=DAILY;COUNT=1`;
	const parts = [`FREQ=${frequency === 'WEEKDAYS' ? 'WEEKLY' : frequency}`];
	if (s.interval > 1 && HAS_INTERVAL.includes(frequency)) parts.push(`INTERVAL=${s.interval}`);
	const days = frequency === 'WEEKDAYS' ? WORKDAYS : frequency === 'WEEKLY' ? s.days : [];
	if (days.length) parts.push(`BYDAY=${[...days].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b)).join(',')}`);
	if (frequency === 'MONTHLY') parts.push(`BYMONTHDAY=${s.monthDay}`);
	if (['DAILY', 'WEEKDAYS', 'WEEKLY', 'MONTHLY'].includes(frequency)) parts.push(`BYHOUR=${s.hour}`);
	// Every few minutes runs on the clock's grid (:00, :15, ...), so it states no minute.
	if (frequency !== 'MINUTELY') parts.push(`BYMINUTE=${s.minute}`);
	return `RRULE:${parts.join(';')}`;
}

/**
 * Reads an RRULE back into the picker. A rule it cannot show exactly becomes
 * CUSTOM with the text kept: SECONDLY or YEARLY, and also any rule saving
 * from the picker would change (a run count or end date, several hours, an
 * nth weekday of the month), since the picker rebuilds the rule on save (#159).
 */
export function parseRrule(rrule: string, now = new Date()): Schedule {
	const s = defaultSchedule(now);
	if (ONCE.test(rrule)) {
		const m = rrule.match(DTSTART);
		return {
			...s,
			frequency: 'ONCE',
			...(m ? { onceDate: `${m[1]}-${m[2]}-${m[3]}`, onceTime: `${m[4]}:${m[5]}` } : {})
		};
	}
	const p = ruleParts(rrule);
	const freq = p.FREQ || 'DAILY';
	const custom: Schedule = { ...s, frequency: 'CUSTOM', custom: rrule };
	if (!['MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) return custom;
	// The picker writes a DTSTART only for a one-time run, so saving would
	// drop this rule's start (its first date, weekday or hour) (#159).
	if (DTSTART_LINE.test(rrule)) return custom;
	const days = p.BYDAY ? p.BYDAY.split(',') : [];
	const workdays = freq === 'WEEKLY' && [...days].sort().join(',') === [...WORKDAYS].sort().join(',');
	const shown: Schedule = {
		...s,
		frequency: workdays ? 'WEEKDAYS' : (freq as Frequency),
		interval: Number.parseInt(p.INTERVAL || '1'),
		hour: Number.parseInt(p.BYHOUR || '9'),
		minute: Number.parseInt(p.BYMINUTE || '0'),
		days: workdays ? [] : days,
		monthDay: Number.parseInt(p.BYMONTHDAY || '1')
	};
	// An interval where the picker has no box for one, and a value the inputs
	// cannot hold, mean the picker cannot show it either, even when it would
	// rebuild the text.
	const representable =
		Number.isInteger(shown.interval) &&
		shown.interval >= 1 &&
		(shown.interval === 1 || HAS_INTERVAL.includes(shown.frequency)) &&
		days.every((d) => WEEKDAYS.includes(d)) &&
		shown.hour >= 0 &&
		shown.hour <= 23 &&
		shown.minute >= 0 &&
		shown.minute <= 59 &&
		shown.monthDay >= 1 &&
		shown.monthDay <= 31;
	// Without a DTSTART an hourly rule starts on the hour, as BYMINUTE=0 says.
	const stated = freq === 'HOURLY' && p.BYMINUTE === undefined ? { ...p, BYMINUTE: '0' } : p;
	return representable && canonical(ruleParts(buildRrule(shown))) === canonical(stated) ? shown : custom;
}

/**
 * Switching the picker to Custom starts the text from the schedule that was
 * showing, so it can be tweaked rather than typed from scratch. Every few
 * minutes starts at 15; Weekly with no day chosen starts on today (#1104).
 */
export function withFrequency(s: Schedule, next: Frequency, now = new Date()): Schedule {
	if (next === s.frequency) return s;
	if (next === 'CUSTOM') return { ...s, frequency: next, custom: buildRrule(s) };
	const interval = next === 'MINUTELY' ? 15 : 1;
	const days = next === 'WEEKLY' && !s.days.length ? [weekdayOf(now)] : s.days;
	return { ...s, frequency: next, interval, days };
}

const ordinal = (n: number) =>
	n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th';

/** A time of day in the reader's own format ("9:00 AM", "09:00"). */
export function timeText(hour: number, minute: number): string {
	return new Date(2000, 0, 1, hour, minute)
		.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
		.replace(/ /g, ' ');
}

/** A weekday's name from its RRULE code, in the reader's language ("Mon", "Monday"). */
const dayName = (code: string, weekday: 'short' | 'long') =>
	new Date(2024, 0, 1 + WEEKDAYS.indexOf(code)).toLocaleDateString(undefined, { weekday });

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What a rule the picker cannot show is called where it cannot be spelled out either. */
export const CUSTOM_SCHEDULE = 'Custom schedule';

/** The DTSTART a rule states, as a local date: a `Z` time is UTC, any other the reader's wall clock. */
function ruleStart(rrule: string): Date | null {
	const m = rrule.match(/DTSTART(?:;[^:]*)?:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)/i);
	if (!m) return null;
	const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
	return m[7] ? new Date(Date.UTC(y, mo - 1, d, h, mi, sec)) : new Date(y, mo - 1, d, h, mi, sec);
}

/** The rule's options, its DTSTART left aside; throws on a rule rrule.js cannot read. */
function ruleOptions(rrule: string) {
	const body = rrule
		.split(/\s+/)
		.filter((line) => line && !/^DTSTART/i.test(line))
		.join(';')
		.replace(/RRULE:/gi, '');
	if (/EXRULE|RDATE|EXDATE/i.test(body)) throw new Error('not one rule');
	const options = RRule.parseString(body);
	if (options.freq === undefined) throw new Error('no FREQ');
	return options;
}

const list = (v: number | number[] | null | undefined) =>
	v === null || v === undefined ? [] : Array.isArray(v) ? v : [v];

/**
 * Spells out a rule the picker does not make ("Every month on the last
 * Friday at 5:00 PM"), through rrule.js's `toText` with the times added,
 * which it leaves out. A rule it cannot describe whole is "Custom schedule",
 * never a summary that drops part of it (#159), and never the rule's own text
 * (WRD-2).
 */
function describeRule(rrule: string, now: Date): string {
	try {
		const { byhour, byminute, bysecond, ...rest } = ruleOptions(rrule);
		if (list(bysecond).some((x) => x !== 0)) return CUSTOM_SCHEDULE;
		const rule = new RRule(rest);
		if (!rule.isFullyConvertibleToText()) return CUSTOM_SCHEDULE;
		let text = rule.toText();
		const hours = list(byhour);
		const minutes = list(byminute);
		const start = ruleStart(rrule);
		const subDaily = rest.freq !== undefined && rest.freq >= RRule.HOURLY;
		if (hours.length && minutes.length && hours.length * minutes.length <= 4) {
			text += ` at ${hours.flatMap((h) => minutes.map((m) => timeText(h, m))).join(' and ')}`;
		} else if (!hours.length && minutes.length === 1 && rest.freq === RRule.HOURLY) {
			if (minutes[0] !== 0) text += ` at ${plural(minutes[0], 'minute')} past`;
		} else if (hours.length || minutes.length) {
			return CUSTOM_SCHEDULE;
		} else if (!subDaily) {
			// The time of day comes from the start, or, without one, from when it is saved.
			text += start ? ` at ${timeText(start.getHours(), start.getMinutes())}` : ', at the time it is saved';
		}
		if (start && start > now)
			text += `, starting ${start.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
		return text.charAt(0).toUpperCase() + text.slice(1);
	} catch {
		return CUSTOM_SCHEDULE;
	}
}

/**
 * A schedule in words (#1032): "Daily at 9:00 AM", "Mon, Wed, Fri at 7:30 AM",
 * "Every 15 minutes", "Once · Sep 30 9:00 AM", or, for a rule the picker does
 * not make, the rule spelled out ("Every month on the last Friday at 5:00 PM").
 */
export function formatSchedule(rrule: string, now = new Date()): string {
	const s = parseRrule(rrule, now);
	const at = timeText(s.hour, s.minute);
	switch (s.frequency) {
		case 'ONCE': {
			if (!DTSTART.test(rrule)) return 'Once';
			const d = new Date(`${s.onceDate}T${s.onceTime}`);
			return `Once · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${timeText(d.getHours(), d.getMinutes())}`;
		}
		case 'MINUTELY':
			return s.interval === 1 ? 'Every minute' : `Every ${s.interval} minutes`;
		case 'HOURLY': {
			const base = s.interval === 1 ? 'Hourly' : `Every ${s.interval} hours`;
			return s.minute ? `${base} at ${plural(s.minute, 'minute')} past` : base;
		}
		case 'DAILY':
			return s.interval === 1 ? `Daily at ${at}` : `Every ${s.interval} days at ${at}`;
		case 'WEEKDAYS':
			return `Weekdays at ${at}`;
		case 'WEEKLY':
			if (s.days.length === 1) return `Every ${dayName(s.days[0], 'long')} at ${at}`;
			if (s.days.length === 7) return `Every day at ${at}`;
			return `${s.days.map((d) => dayName(d, 'short')).join(', ')} at ${at}`;
		case 'MONTHLY':
			return `Monthly on the ${s.monthDay}${ordinal(s.monthDay)} at ${at}`;
		default:
			return describeRule(rrule, now);
	}
}

/** The schedule picker's chip: the frequency's name, with its time where it has one ("Daily at 9:00 AM"). */
export const scheduleChipLabel = (s: Schedule, now = new Date()) =>
	s.frequency === 'CUSTOM' ? 'Custom rule' : formatSchedule(buildRrule(s), now);

const toWall = (d: Date) =>
	new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()));
const fromWall = (w: Date) =>
	new Date(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds());

/**
 * The next `count` runs of a rule, worked out as the scheduler does
 * (utils/automations.py `_parse_rule`): a rule repeating more often than
 * daily without a DTSTART runs on the clock's grid from 2000-01-01, a longer
 * one takes the time it does not state from now (on the minute), and a
 * DTSTART is the reader's wall clock unless it ends in `Z`. rrule.js counts
 * in UTC, so wall-clock times go in and come out as UTC dates. Empty for a
 * rule that cannot be read or has no runs left. The detail page shows the
 * server's own `next_runs` instead.
 */
export function previewRuns(rrule: string, count = 3, now = new Date()): Date[] {
	try {
		const options = ruleOptions(rrule);
		const start = ruleStart(rrule);
		const wallNow = toWall(now);
		const step = { [RRule.MINUTELY]: 60_000, [RRule.HOURLY]: 3_600_000, [RRule.SECONDLY]: 1_000 }[options.freq ?? -1];
		let dtstart: Date;
		if (start) dtstart = toWall(start);
		else if (step) {
			const unit = step * (options.interval ?? 1);
			const epoch = Date.UTC(2000, 0, 1);
			dtstart = new Date(epoch + Math.floor((wallNow.getTime() - epoch) / unit) * unit);
		} else dtstart = new Date(Math.floor(wallNow.getTime() / 60_000) * 60_000);
		const rule = new RRule({ ...options, dtstart });
		const runs: Date[] = [];
		let after = wallNow;
		for (let i = 0; i < count; i++) {
			const next = rule.after(after, false);
			if (!next) break;
			runs.push(fromWall(next));
			after = next;
		}
		return runs;
	} catch {
		return [];
	}
}

/** "Mon, Nov 16, 9:00 AM": a run's time in the reader's format. */
export const runTimeText = (d: Date) =>
	d
		.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
		.replace(/ /g, ' ');

/** The reader's time zone, which the server reads schedules in. */
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const RULE_EXAMPLE = 'RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0';
export const RULE_HELP = `An iCalendar rule, for example ${RULE_EXAMPLE} for Mondays at 9:00 AM.`;
const RULE_UNREADABLE = `The scheduler can't read this rule. Write it like ${RULE_EXAMPLE}.`;
const RULE_COUNT = 'A rule with COUNT needs a DTSTART line before it, saying when the first run is.';
const RULE_NO_RUNS = 'This rule has no runs left. Move its start, or change its UNTIL or COUNT.';

/**
 * What is wrong with a custom rule, in words, or null (#1032, FRM-2). The
 * server checks again on save; `ruleProblemFromServer` words its refusals.
 */
export function customRuleProblem(rrule: string, now = new Date()): string | null {
	if (!rrule.trim()) return `Enter a rule, for example ${RULE_EXAMPLE}.`;
	if (/COUNT=/i.test(rrule) && !/DTSTART/i.test(rrule)) return RULE_COUNT;
	try {
		ruleOptions(rrule);
	} catch {
		return RULE_UNREADABLE;
	}
	return previewRuns(rrule, 1, now).length ? null : RULE_NO_RUNS;
}

/**
 * The server's refusal of a schedule (routers/automations.py, constants.py),
 * in the words the field shows, or null when the error is not about the
 * schedule. Its own text ("Invalid RRULE: not enough values to unpack") is
 * never shown as the message (FBK-4).
 */
export function ruleProblemFromServer(detail: string): string | null {
	if (/^Invalid RRULE/i.test(detail)) return RULE_UNREADABLE;
	if (/no future occurrences/i.test(detail)) return RULE_NO_RUNS;
	if (/COUNT requires/i.test(detail)) return RULE_COUNT;
	const often = detail.match(/too frequent\. Minimum interval is (\d+) seconds/i);
	if (often) {
		const seconds = Number(often[1]);
		const gap = seconds % 60 ? plural(seconds, 'second') : plural(seconds / 60, 'minute');
		return `This runs too often. Runs must be at least ${gap} apart (Admin Settings > Automations).`;
	}
	return null;
}

/** A one-time run must be in the future. */
export const oncePassed = (s: Schedule, now = new Date()) =>
	s.frequency === 'ONCE' && new Date(`${s.onceDate}T${s.onceTime}`) <= now;

/**
 * A one-time run without a whole date and time (#322). A cleared box sent
 * `DTSTART:20261201T00`, which the server took as midnight, and an invalid
 * date passed `oncePassed`, since it compares as neither past nor future.
 */
export const onceIncomplete = (s: Schedule) =>
	s.frequency === 'ONCE' && !(/^\d{4}-\d{2}-\d{2}$/.test(s.onceDate) && /^\d{2}:\d{2}$/.test(s.onceTime));

/**
 * The hour and minute a time box holds, or null while it is cleared or
 * incomplete (#322): `''` used to read as hour 0 with no minute, which built
 * `BYMINUTE=undefined` and a save the server refused.
 */
export function timeFromInput(value: string): { hour: number; minute: number } | null {
	const m = /^(\d{2}):(\d{2})/.exec(value);
	return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

// --- destinations --------------------------------------------------------

export type Folder = { id: string; name: string; parent_id?: string | null; shared?: boolean };
export type Channel = { id: string; name: string; type?: string | null; is_member?: boolean };

/** Folders an automation can post into (not shared ones), by name. */
export const folderOptions = (folders: Folder[]) =>
	folders.filter((f) => f?.id && !f.shared).sort((a, b) => a.name.localeCompare(b.name));
/**
 * Channels an automation can post into (not DMs, and not a public group
 * channel the user has not joined, which only members post to: #331), by name.
 */
export const channelOptions = (channels: Channel[]) =>
	channels
		.filter((c) => c?.id && c.type !== 'dm' && c.is_member !== false)
		.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

/** "Parent / Child" above a folder; stops at a cycle or a missing parent. */
export function folderPath(folder: Folder, all: Folder[]): string {
	const byId = new Map(all.map((f) => [f.id, f]));
	const names: string[] = [];
	const seen = new Set<string>();
	let current: Folder | undefined = folder;
	while (current?.parent_id && !seen.has(current.parent_id)) {
		seen.add(current.parent_id);
		current = byId.get(current.parent_id);
		if (!current) break;
		names.unshift(current.name);
	}
	return names.join(' / ');
}

/** Where a run's output goes, for the list and the detail page. */
export function destinationLabel(
	a: Pick<AutomationResponse, 'folder_id' | 'data'>,
	folders: Folder[],
	channels: Channel[],
	detailed = false
): string {
	if (a.data.target?.type === 'channel') {
		const channel = channels.find((c) => c.id === a.data.target?.channel_id);
		return channel?.name ? `#${channel.name}` : 'Channel';
	}
	const same = Boolean(a.data.target?.same_chat);
	if (!a.folder_id) return same ? 'Same chat' : 'New chat';
	const folder = detailed ? `Folder: ${folders.find((f) => f.id === a.folder_id)?.name ?? 'None'}` : 'Folder';
	return same ? `${folder}, same chat` : folder;
}

/** Where a run links to: its channel, or its chat. */
export const runTarget = (chatId: string) =>
	chatId.startsWith('channel:') ? `${routePaths.channels}/${chatId.slice('channel:'.length)}` : `/c/${chatId}`;

/** The last run: its status and error when the server has the run, else only when the scheduler last ran it (#915). */
export function lastRun(
	a: Pick<AutomationResponse, 'last_run' | 'last_run_at'>
): { at: number; status: 'success' | 'error' | null; error: string | null } | null {
	if (a.last_run)
		return {
			at: a.last_run.created_at,
			status: a.last_run.status === 'success' ? 'success' : 'error',
			error: a.last_run.error
		};
	return a.last_run_at ? { at: a.last_run_at, status: null, error: null } : null;
}

/** When an automation runs next, or null when it will not: a paused one does not run, whatever its rule says (#324). */
export const nextRunAt = (a: Pick<AutomationResponse, 'is_active' | 'next_runs' | 'next_run_at'>): number | null =>
	a.is_active ? (a.next_runs?.[0] ?? a.next_run_at ?? null) : null;

// --- the form ------------------------------------------------------------

export type AutomationFields = {
	name: string;
	prompt: string;
	modelId: string;
	folderId: string;
	targetType: 'chat' | 'channel';
	channelId: string;
	/** Every run goes into the chat the last one used (S6-D13). */
	sameChat: boolean;
	isActive: boolean;
	schedule: Schedule;
};

/**
 * Starting values: the automation being edited; a clone (named "(Clone)",
 * and active); or blank. A clone's folder and channel are checked separately,
 * once those lists have loaded (`withoutMissingDestinations`).
 */
export function automationFields(
	source: AutomationResponse | null,
	{ clone = false, now = new Date() } = {}
): AutomationFields {
	if (!source)
		return {
			name: '',
			prompt: '',
			modelId: '',
			folderId: '',
			targetType: 'chat',
			channelId: '',
			sameChat: false,
			isActive: true,
			schedule: defaultSchedule(now)
		};
	const channelId = source.data.target?.channel_id ?? '';
	return {
		name: clone ? `${source.name} (Clone)` : source.name,
		prompt: source.data.prompt,
		modelId: source.data.model_id,
		folderId: source.folder_id ?? '',
		targetType: source.data.target?.type === 'channel' ? 'channel' : 'chat',
		channelId,
		sameChat: Boolean(source.data.target?.same_chat),
		isActive: clone ? true : source.is_active,
		schedule: parseRrule(source.data.rrule, now)
	};
}

/** Clears a folder or channel the user no longer has (a clone of someone else's, or a deleted one). */
export function withoutMissingDestinations(
	f: AutomationFields,
	folders: Folder[],
	channels: Channel[]
): AutomationFields {
	return {
		...f,
		folderId: folders.some((x) => x.id === f.folderId) ? f.folderId : '',
		channelId: channels.some((x) => x.id === f.channelId) ? f.channelId : ''
	};
}

/** The form's fields that can be wrong, in the order they are on the page. */
export const AUTOMATION_FIELDS = ['name', 'prompt', 'schedule', 'model', 'channel'] as const;
export type AutomationField = (typeof AUTOMATION_FIELDS)[number];
export type AutomationProblems = Partial<Record<AutomationField, string>>;

/** What is wrong with the form, by field (FRM-2, #1033): each says what to put right. */
export function automationProblems(f: AutomationFields, now = new Date()): AutomationProblems {
	const problems: AutomationProblems = {};
	if (!f.name.trim()) problems.name = 'Enter a name for the automation.';
	if (!f.prompt.trim()) problems.prompt = 'Enter the instructions the model follows on each run.';
	if (!f.modelId.trim()) problems.model = 'Choose the model that runs it.';
	if (f.targetType === 'channel' && !f.channelId) problems.channel = 'Choose a channel, or post to a chat instead.';
	const s = f.schedule;
	if (onceIncomplete(s)) problems.schedule = 'Pick a date and time for the one-time run.';
	else if (oncePassed(s, now)) problems.schedule = 'Pick a time in the future for the one-time run.';
	// Saving with no day used to take the weekday of the save, silently (#1104).
	else if (s.frequency === 'WEEKLY' && !s.days.length) problems.schedule = 'Choose at least one day.';
	else if (s.frequency === 'CUSTOM') {
		const problem = customRuleProblem(s.custom, now);
		if (problem) problems.schedule = problem;
	}
	return problems;
}

/** The automation to send, or what is wrong with it. A channel target has no folder. */
export function automationPayload(
	f: AutomationFields,
	now = new Date()
): { problems: AutomationProblems } | { form: AutomationForm } {
	const problems = automationProblems(f, now);
	if (Object.keys(problems).length) return { problems };
	const channel = f.targetType === 'channel';
	return {
		form: {
			name: f.name.trim(),
			folder_id: channel ? null : f.folderId || null,
			data: {
				prompt: f.prompt.trim(),
				model_id: f.modelId.trim(),
				rrule: buildRrule(f.schedule),
				target: channel
					? { type: 'channel', channel_id: f.channelId }
					: f.sameChat
						? { type: 'chat', same_chat: true }
						: { type: 'chat' }
			},
			is_active: f.isActive
		}
	};
}

// --- import / export -----------------------------------------------------

/** What an export writes for one automation: its form, not its server-side ids and run history. */
export const toAutomationForm = (a: AutomationResponse): AutomationForm => ({
	name: a.name,
	folder_id: a.folder_id,
	data: a.data,
	meta: a.meta ?? undefined,
	is_active: a.is_active
});

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * Reads an export (an array, or `{automations: [...]}`) into forms to create.
 * Each is reduced to the fields an automation has, with bounded strings; a
 * folder this user does not have is dropped; an entry missing a prompt, model
 * or schedule is skipped rather than sent. `meta.webhook` is never imported:
 * a file someone sent could otherwise have each run POST its output to a URL
 * of their choosing. The Svelte importer posted `data` and `meta` as they were.
 */
export function parseAutomationImport(
	text: string,
	validFolderIds: Set<string>
): { forms: AutomationForm[]; skipped: number } {
	const raw = JSON.parse(text);
	const items: unknown = Array.isArray(raw) ? raw : raw?.automations;
	if (!Array.isArray(items)) throw new Error('Invalid JSON format');
	const forms: AutomationForm[] = [];
	let skipped = 0;
	for (const item of items) {
		const data = item?.data;
		const prompt = str(data?.prompt, 100_000);
		const model_id = str(data?.model_id, 500);
		const rrule = str(data?.rrule, 2_000);
		if (!prompt || !model_id || !rrule) {
			skipped++;
			continue;
		}
		const target =
			data?.target?.type === 'channel' && typeof data.target.channel_id === 'string'
				? { type: 'channel' as const, channel_id: data.target.channel_id.slice(0, 200) }
				: data?.target?.same_chat === true
					? { type: 'chat' as const, same_chat: true }
					: { type: 'chat' as const };
		const meta = item?.meta && typeof item.meta === 'object' ? item.meta : undefined;
		forms.push({
			name: str(item?.name, 500) || 'Imported automation',
			folder_id: typeof item?.folder_id === 'string' && validFolderIds.has(item.folder_id) ? item.folder_id : null,
			data: { prompt, model_id, rrule, target },
			meta: meta
				? {
						...(typeof meta.system_prompt === 'string' ? { system_prompt: meta.system_prompt.slice(0, 100_000) } : {}),
						...(typeof meta.temperature === 'number' ? { temperature: meta.temperature } : {}),
						...(typeof meta.max_tokens === 'number' ? { max_tokens: meta.max_tokens } : {})
					}
				: undefined,
			is_active: item?.is_active !== false
		});
	}
	return { forms, skipped };
}

export type ImportOutcome = {
	imported: number;
	/** Items without a prompt, model or schedule. */
	skipped: number;
	/** One-time automations whose time has passed: an export holds them once they have run. */
	passed: number;
	failed: { name: string; error: string }[];
};

/**
 * Creates each imported automation on its own (#323). They used to be created
 * in one try, so the first refusal (most often an exported one-time automation
 * that has already run, which the server refuses as having no future run)
 * stopped the import with the earlier ones made, and importing again made
 * those twice. A one-time automation whose time has passed is skipped.
 */
export async function importAutomationForms(
	forms: AutomationForm[],
	skipped: number,
	create: (form: AutomationForm) => Promise<unknown>,
	now = new Date()
): Promise<ImportOutcome> {
	const outcome: ImportOutcome = { imported: 0, skipped, passed: 0, failed: [] };
	for (const form of forms) {
		if (pickerOncePassed(form.data.rrule, now)) {
			outcome.passed++;
			continue;
		}
		try {
			await create(form);
			outcome.imported++;
		} catch (error) {
			outcome.failed.push({ name: form.name, error: errorMessage(error) });
		}
	}
	return outcome;
}

/**
 * A one-time rule exactly as the picker writes it (one daily run from a
 * start), whose start has passed. Any other rule with a run count of 1, such
 * as a weekly one whose first run is still to come, is left to the server.
 */
function pickerOncePassed(rrule: string, now: Date): boolean {
	if (!DTSTART.test(rrule)) return false;
	const parts = ruleParts(rrule);
	const picker = Object.keys(parts).length === 2 && parts.FREQ === 'DAILY' && parts.COUNT === '1';
	return picker && oncePassed(parseRrule(rrule, now), now);
}

const MAX_NAMED_FAILURES = 3;

/** What an import did, for its toast: an error when any automation could not be created. */
export function importMessage(o: ImportOutcome): { ok: boolean; message: string } {
	const parts = [`Imported ${plural(o.imported, 'automation')}`];
	if (o.passed) parts.push(`skipped ${plural(o.passed, 'one-time automation')} whose time has passed`);
	if (o.skipped) parts.push(`skipped ${o.skipped} incomplete`);
	if (o.failed.length) {
		// The first few by name, so a large import's toast stays readable.
		const named = o.failed.slice(0, MAX_NAMED_FAILURES).map((f) => `${f.name} (${f.error})`);
		const more = o.failed.length - named.length;
		parts.push(`${o.failed.length} could not be created: ${named.join('; ')}${more ? `; and ${more} more` : ''}`);
	}
	return { ok: o.failed.length === 0, message: parts.join('; ') };
}
