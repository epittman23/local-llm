import type { AutomationForm, AutomationResponse } from '@/lib/apis/automations';

// The rules behind the Automations surface: the schedule picker's RRULE
// round-trip (components/automations/ScheduleDropdown.svelte), the one-line
// schedule and destination summaries (the list page and AutomationEditor
// each carry their own copy of the formatter), the form, and import/export.

export type Frequency = 'ONCE' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM';

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

const pad = (n: number) => String(n).padStart(2, '0');
/** Local `YYYY-MM-DD` (the Svelte picker used `toISOString`, which is the UTC date and is a day off in the evening west of Greenwich). */
export const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** A fresh schedule: daily at 9:00; a one-time run defaults to five minutes from now. */
export function defaultSchedule(now = new Date()): Schedule {
	const soon = new Date(now.getTime() + 5 * 60_000);
	return { frequency: 'DAILY', interval: 1, hour: 9, minute: 0, days: [], monthDay: 1, onceDate: localDate(soon), onceTime: `${pad(soon.getHours())}:${pad(soon.getMinutes())}`, custom: '' };
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

const ONCE = /COUNT=1(?!\d)/;
const DTSTART = /DTSTART:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/;

/** Builds the RRULE for a schedule. `frequency` may be given to build a visual schedule while CUSTOM is selected. */
export function buildRrule(s: Schedule, frequency: Frequency = s.frequency): string {
	if (frequency === 'CUSTOM') return s.custom;
	if (frequency === 'ONCE') return `DTSTART:${s.onceDate.replace(/-/g, '')}T${s.onceTime.replace(/:/g, '')}00\nRRULE:FREQ=DAILY;COUNT=1`;
	const parts = [`FREQ=${frequency}`];
	if (s.interval > 1) parts.push(`INTERVAL=${s.interval}`);
	if (frequency === 'WEEKLY' && s.days.length) parts.push(`BYDAY=${s.days.join(',')}`);
	if (frequency === 'MONTHLY') parts.push(`BYMONTHDAY=${s.monthDay}`);
	if (frequency === 'DAILY' || frequency === 'WEEKLY' || frequency === 'MONTHLY') parts.push(`BYHOUR=${s.hour}`);
	parts.push(`BYMINUTE=${s.minute}`);
	return `RRULE:${parts.join(';')}`;
}

/** Reads an RRULE back into the picker; a rule it cannot show (MINUTELY, YEARLY, ...) becomes CUSTOM with the text kept. */
export function parseRrule(rrule: string, now = new Date()): Schedule {
	const s = defaultSchedule(now);
	if (ONCE.test(rrule)) {
		const m = rrule.match(DTSTART);
		return { ...s, frequency: 'ONCE', ...(m ? { onceDate: `${m[1]}-${m[2]}-${m[3]}`, onceTime: `${m[4]}:${m[5]}` } : {}) };
	}
	const p = ruleParts(rrule);
	const freq = p.FREQ || 'DAILY';
	if (!['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) return { ...s, frequency: 'CUSTOM', custom: rrule };
	return {
		...s,
		frequency: freq as Frequency,
		interval: Number.parseInt(p.INTERVAL || '1'),
		hour: Number.parseInt(p.BYHOUR || '9'),
		minute: Number.parseInt(p.BYMINUTE || '0'),
		days: p.BYDAY ? p.BYDAY.split(',') : [],
		monthDay: Number.parseInt(p.BYMONTHDAY || '1')
	};
}

/**
 * Switching the picker to Custom starts the text from the schedule that was
 * showing, so it can be tweaked rather than typed from scratch.
 */
export function withFrequency(s: Schedule, next: Frequency): Schedule {
	if (next === 'CUSTOM' && s.frequency !== 'CUSTOM') return { ...s, frequency: next, custom: buildRrule(s) };
	return { ...s, frequency: next };
}

const ordinal = (n: number) => (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');

/** "Daily at 9:00 AM", "MO,WE at 6:30 PM", "Once · Sep 30 9:00 AM", or the rule itself if it is none of those. */
export function formatSchedule(rrule: string): string {
	if (ONCE.test(rrule)) {
		const m = rrule.match(DTSTART);
		if (!m) return 'Once';
		const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`);
		return `Once · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
	}
	const p = ruleParts(rrule);
	const hour = Number.parseInt(p.BYHOUR || '0');
	const iv = Number.parseInt(p.INTERVAL || '1');
	const time = `${hour % 12 || 12}:${(p.BYMINUTE || '0').padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
	switch (p.FREQ) {
		case 'MINUTELY':
			return iv === 1 ? 'Every minute' : `Every ${iv} minutes`;
		case 'HOURLY':
			return iv === 1 ? 'Hourly' : `Every ${iv} hours`;
		case 'DAILY':
			return `Daily at ${time}`;
		case 'WEEKLY':
			return p.BYDAY ? `${p.BYDAY} at ${time}` : `Weekly at ${time}`;
		case 'MONTHLY': {
			const day = Number.parseInt(p.BYMONTHDAY || '1');
			return `Monthly on the ${day}${ordinal(day)} at ${time}`;
		}
		default:
			return rrule;
	}
}

/** A one-time run must be in the future. */
export const oncePassed = (s: Schedule, now = new Date()) => s.frequency === 'ONCE' && new Date(`${s.onceDate}T${s.onceTime}`) <= now;

// --- destinations --------------------------------------------------------

export type Folder = { id: string; name: string; parent_id?: string | null; shared?: boolean };
export type Channel = { id: string; name: string; type?: string | null };

/** Folders an automation can post into (not shared ones), by name. */
export const folderOptions = (folders: Folder[]) => folders.filter((f) => f?.id && !f.shared).sort((a, b) => a.name.localeCompare(b.name));
/** Channels an automation can post into (not DMs), by name. */
export const channelOptions = (channels: Channel[]) => channels.filter((c) => c?.id && c.type !== 'dm').sort((a, b) => (a.name || '').localeCompare(b.name || ''));

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
export function destinationLabel(a: Pick<AutomationResponse, 'folder_id' | 'data'>, folders: Folder[], channels: Channel[], detailed = false): string {
	if (a.data.target?.type === 'channel') {
		const channel = channels.find((c) => c.id === a.data.target?.channel_id);
		return channel?.name ? `#${channel.name}` : 'Channel';
	}
	if (!a.folder_id) return 'New chat';
	if (!detailed) return 'Folder';
	return `Folder: ${folders.find((f) => f.id === a.folder_id)?.name ?? 'None'}`;
}

/** Where a run links to: its channel, or its chat. */
export const runTarget = (chatId: string) => (chatId.startsWith('channel:') ? `/channels/${chatId.slice('channel:'.length)}` : `/c/${chatId}`);

// --- the form ------------------------------------------------------------

export type AutomationFields = {
	name: string;
	prompt: string;
	modelId: string;
	folderId: string;
	targetType: 'chat' | 'channel';
	channelId: string;
	isActive: boolean;
	schedule: Schedule;
};

/**
 * Starting values: the automation being edited; a clone (named "(Clone)",
 * and active); or blank. A clone's folder and channel are checked separately,
 * once those lists have loaded (`withoutMissingDestinations`).
 */
export function automationFields(source: AutomationResponse | null, { clone = false, now = new Date() } = {}): AutomationFields {
	if (!source) return { name: '', prompt: '', modelId: '', folderId: '', targetType: 'chat', channelId: '', isActive: true, schedule: defaultSchedule(now) };
	const channelId = source.data.target?.channel_id ?? '';
	return {
		name: clone ? `${source.name} (Clone)` : source.name,
		prompt: source.data.prompt,
		modelId: source.data.model_id,
		folderId: source.folder_id ?? '',
		targetType: source.data.target?.type === 'channel' ? 'channel' : 'chat',
		channelId,
		isActive: clone ? true : source.is_active,
		schedule: parseRrule(source.data.rrule, now)
	};
}

/** Clears a folder or channel the user no longer has (a clone of someone else's, or a deleted one). */
export function withoutMissingDestinations(f: AutomationFields, folders: Folder[], channels: Channel[]): AutomationFields {
	return {
		...f,
		folderId: folders.some((x) => x.id === f.folderId) ? f.folderId : '',
		channelId: channels.some((x) => x.id === f.channelId) ? f.channelId : ''
	};
}

/** The automation to send, or the message to show. A channel target has no folder. */
export function automationPayload(f: AutomationFields, now = new Date()): { error: string } | { form: AutomationForm } {
	if (!f.name.trim() || !f.prompt.trim() || !f.modelId.trim()) return { error: 'Name, prompt, and model are required' };
	if (f.targetType === 'channel' && !f.channelId) return { error: 'Channel is required' };
	if (oncePassed(f.schedule, now)) return { error: 'Scheduled time must be in the future' };
	const channel = f.targetType === 'channel';
	return {
		form: {
			name: f.name.trim(),
			folder_id: channel ? null : f.folderId || null,
			data: { prompt: f.prompt.trim(), model_id: f.modelId.trim(), rrule: buildRrule(f.schedule), target: channel ? { type: 'channel', channel_id: f.channelId } : { type: 'chat' } },
			is_active: f.isActive
		}
	};
}

// --- import / export -----------------------------------------------------

/** What an export writes for one automation: its form, not its server-side ids and run history. */
export const toAutomationForm = (a: AutomationResponse): AutomationForm => ({ name: a.name, folder_id: a.folder_id, data: a.data, meta: a.meta ?? undefined, is_active: a.is_active });

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * Reads an export (an array, or `{automations: [...]}`) into forms to create.
 * Each is reduced to the fields an automation has, with bounded strings; a
 * folder this user does not have is dropped; an entry missing a prompt, model
 * or schedule is skipped rather than sent. `meta.webhook` is never imported:
 * a file someone sent could otherwise have each run POST its output to a URL
 * of their choosing. The Svelte importer posted `data` and `meta` as they were.
 */
export function parseAutomationImport(text: string, validFolderIds: Set<string>): { forms: AutomationForm[]; skipped: number } {
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
		const target = data?.target?.type === 'channel' && typeof data.target.channel_id === 'string' ? { type: 'channel' as const, channel_id: data.target.channel_id.slice(0, 200) } : { type: 'chat' as const };
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
