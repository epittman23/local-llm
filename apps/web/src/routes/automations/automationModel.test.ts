import { describe, expect, it } from 'vitest';
import {
	automationFields,
	automationPayload,
	buildRrule,
	defaultSchedule,
	destinationLabel,
	folderOptions,
	folderPath,
	formatSchedule,
	localDate,
	parseAutomationImport,
	parseRrule,
	runTarget,
	withFrequency,
	withoutMissingDestinations
} from './automationModel';

const now = new Date(2026, 8, 27, 22, 58);

describe('schedule round-trip', () => {
	it('defaults to daily at 9, a one-time run five minutes out on the local date', () => {
		const s = defaultSchedule(now);
		expect(s).toMatchObject({ frequency: 'DAILY', hour: 9, minute: 0, onceDate: '2026-09-27', onceTime: '23:03' });
		expect(localDate(new Date(2026, 0, 5))).toBe('2026-01-05');
	});
	it('builds each frequency', () => {
		const s = defaultSchedule(now);
		expect(buildRrule(s)).toBe('RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0');
		expect(buildRrule({ ...s, frequency: 'HOURLY', interval: 3, minute: 15 })).toBe(
			'RRULE:FREQ=HOURLY;INTERVAL=3;BYMINUTE=15'
		);
		expect(buildRrule({ ...s, frequency: 'WEEKLY', days: ['MO', 'WE'], hour: 18, minute: 30 })).toBe(
			'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=18;BYMINUTE=30'
		);
		expect(buildRrule({ ...s, frequency: 'MONTHLY', monthDay: 15 })).toBe(
			'RRULE:FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0'
		);
		expect(buildRrule({ ...s, frequency: 'ONCE', onceDate: '2026-10-01', onceTime: '08:05' })).toBe(
			'DTSTART:20261001T080500\nRRULE:FREQ=DAILY;COUNT=1'
		);
	});
	it('parses what it builds, and keeps anything else as custom text', () => {
		for (const r of [
			'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=18;BYMINUTE=30',
			'RRULE:FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0',
			'DTSTART:20261001T080500\nRRULE:FREQ=DAILY;COUNT=1'
		]) {
			expect(buildRrule(parseRrule(r, now))).toBe(r);
		}
		expect(parseRrule('RRULE:FREQ=MINUTELY;INTERVAL=5', now)).toMatchObject({
			frequency: 'CUSTOM',
			custom: 'RRULE:FREQ=MINUTELY;INTERVAL=5'
		});
		expect(parseRrule('RRULE:FREQ=DAILY;COUNT=10', now).frequency).toBe('DAILY');
	});
	it('switching to Custom starts from the schedule that was showing', () => {
		const s = { ...defaultSchedule(now), hour: 7 };
		expect(withFrequency(s, 'CUSTOM').custom).toBe('RRULE:FREQ=DAILY;BYHOUR=7;BYMINUTE=0');
		expect(withFrequency({ ...s, frequency: 'CUSTOM', custom: 'X' }, 'CUSTOM').custom).toBe('X');
	});
	it('summaries', () => {
		expect(formatSchedule('RRULE:FREQ=DAILY;BYHOUR=0;BYMINUTE=5')).toBe('Daily at 12:05 AM');
		expect(formatSchedule('RRULE:FREQ=MONTHLY;BYMONTHDAY=22;BYHOUR=13;BYMINUTE=0')).toBe(
			'Monthly on the 22nd at 1:00 PM'
		);
		expect(formatSchedule('RRULE:FREQ=MONTHLY;BYMONTHDAY=11;BYHOUR=13;BYMINUTE=0')).toBe(
			'Monthly on the 11th at 1:00 PM'
		);
		expect(formatSchedule('RRULE:FREQ=HOURLY;INTERVAL=2')).toBe('Every 2 hours');
		expect(formatSchedule('RRULE:FREQ=YEARLY')).toBe('RRULE:FREQ=YEARLY');
		expect(formatSchedule('DTSTART:20261001T080500\nRRULE:FREQ=DAILY;COUNT=1')).toMatch(/^Once · /);
	});
});

describe('destinations', () => {
	const folders = [
		{ id: 'b', name: 'Beta', parent_id: 'a' },
		{ id: 'a', name: 'Alpha' },
		{ id: 's', name: 'Shared', shared: true },
		{ id: 'loop1', name: 'L1', parent_id: 'loop2' },
		{ id: 'loop2', name: 'L2', parent_id: 'loop1' }
	];
	it('offers own folders by name, and shows their path; a cycle ends', () => {
		expect(folderOptions(folders).map((f) => f.id)).toEqual(['a', 'b', 'loop1', 'loop2']);
		expect(folderPath(folders[0], folders)).toBe('Alpha');
		// loop1 -> loop2 -> loop1: each parent is visited once, then it stops.
		expect(folderPath(folders[3], folders)).toBe('L1 / L2');
	});
	it('labels the destination', () => {
		const a = (x: object) => ({ folder_id: null, data: { prompt: '', model_id: '', rrule: '' }, ...x }) as any;
		expect(destinationLabel(a({}), [], [])).toBe('New chat');
		expect(destinationLabel(a({ folder_id: 'a' }), folders, [], true)).toBe('Folder: Alpha');
		expect(
			destinationLabel(a({ data: { target: { type: 'channel', channel_id: 'c1' } } }), [], [{ id: 'c1', name: 'ops' }])
		).toBe('#ops');
		expect(runTarget('channel:c1')).toBe('/channels/c1');
		expect(runTarget('x9')).toBe('/c/x9');
	});
});

describe('form', () => {
	const existing = {
		id: 'a1',
		name: 'Digest',
		folder_id: 'gone',
		is_active: false,
		data: {
			prompt: 'p',
			model_id: 'm',
			rrule: 'RRULE:FREQ=HOURLY;BYMINUTE=0',
			target: { type: 'channel', channel_id: 'c-gone' }
		}
	} as any;
	it('a clone is renamed and active; a folder or channel no longer available is dropped once the lists are known', () => {
		expect(automationFields(existing, { now })).toMatchObject({
			name: 'Digest',
			isActive: false,
			folderId: 'gone',
			channelId: 'c-gone'
		});
		const clone = automationFields(existing, { clone: true, now });
		expect(clone).toMatchObject({ name: 'Digest (Clone)', isActive: true });
		expect(withoutMissingDestinations(clone, [], [{ id: 'c-gone', name: 'x' }])).toMatchObject({
			folderId: '',
			channelId: 'c-gone'
		});
	});
	it('validates and builds', () => {
		const f = automationFields(null, { now });
		expect(automationPayload(f, now)).toEqual({ error: 'Name, prompt, and model are required' });
		const ready = { ...f, name: ' N ', prompt: ' P ', modelId: 'm', folderId: 'a' };
		expect(automationPayload({ ...ready, targetType: 'channel' }, now)).toEqual({ error: 'Channel is required' });
		expect(
			automationPayload(
				{ ...ready, schedule: { ...ready.schedule, frequency: 'ONCE', onceDate: '2026-09-27', onceTime: '22:00' } },
				now
			)
		).toEqual({ error: 'Scheduled time must be in the future' });
		expect(automationPayload(ready, now)).toEqual({
			form: {
				name: 'N',
				folder_id: 'a',
				data: { prompt: 'P', model_id: 'm', rrule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0', target: { type: 'chat' } },
				is_active: true
			}
		});
		const toChannel = automationPayload({ ...ready, targetType: 'channel', channelId: 'c1' }, now);
		expect('form' in toChannel && toChannel.form.folder_id).toBeNull();
	});
});

describe('import', () => {
	it('reads either shape, drops unknown folders, skips incomplete entries, and never imports a webhook', () => {
		const file = JSON.stringify({
			automations: [
				{
					name: 'A',
					folder_id: 'mine',
					data: { prompt: 'p', model_id: 'm', rrule: 'RRULE:FREQ=DAILY', extra: 1 },
					meta: { webhook: 'https://evil.example', temperature: 0.2 },
					is_active: false
				},
				{ name: 'B', folder_id: 'theirs', data: { prompt: 'p', model_id: 'm', rrule: 'R' } },
				{ name: 'C', data: { prompt: 'p' } }
			]
		});
		const { forms, skipped } = parseAutomationImport(file, new Set(['mine']));
		expect(skipped).toBe(1);
		expect(forms[0]).toEqual({
			name: 'A',
			folder_id: 'mine',
			data: { prompt: 'p', model_id: 'm', rrule: 'RRULE:FREQ=DAILY', target: { type: 'chat' } },
			meta: { temperature: 0.2 },
			is_active: false
		});
		expect(forms[1].folder_id).toBeNull();
		expect(JSON.stringify(forms)).not.toContain('evil');
	});
	it('refuses a file that is not a list', () => {
		expect(() => parseAutomationImport('{"x":1}', new Set())).toThrow('Invalid JSON format');
	});
});
