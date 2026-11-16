import { describe, expect, it } from 'vitest';
import {
	automationFields,
	automationPayload,
	automationProblems,
	buildRrule,
	CUSTOM_SCHEDULE,
	channelOptions,
	customRuleProblem,
	defaultSchedule,
	destinationLabel,
	folderOptions,
	folderPath,
	formatSchedule,
	importAutomationForms,
	importMessage,
	localDate,
	parseAutomationImport,
	parseRrule,
	previewRuns,
	ruleProblemFromServer,
	runTarget,
	runTimeText,
	scheduleChipLabel,
	timeFromInput,
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
		expect(buildRrule({ ...s, frequency: 'MINUTELY', interval: 15, minute: 40 })).toBe(
			'RRULE:FREQ=MINUTELY;INTERVAL=15'
		);
		expect(buildRrule({ ...s, frequency: 'DAILY', interval: 2 })).toBe(
			'RRULE:FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0'
		);
		expect(buildRrule({ ...s, frequency: 'WEEKDAYS', days: ['SU'], hour: 7, minute: 30 })).toBe(
			'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7;BYMINUTE=30'
		);
		// Days are written in week order, whatever order they were chosen in.
		expect(buildRrule({ ...s, frequency: 'WEEKLY', days: ['FR', 'MO'] })).toBe(
			'RRULE:FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=0'
		);
		expect(buildRrule({ ...s, frequency: 'ONCE', onceDate: '2026-10-01', onceTime: '08:05' })).toBe(
			'DTSTART:20261001T080500\nRRULE:FREQ=DAILY;COUNT=1'
		);
	});
	it('parses what it builds, and keeps anything else as custom text', () => {
		for (const r of [
			'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=18;BYMINUTE=30',
			'RRULE:FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0',
			'DTSTART:20261001T080500\nRRULE:FREQ=DAILY;COUNT=1',
			'RRULE:FREQ=MINUTELY;INTERVAL=5',
			'RRULE:FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0',
			'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0'
		]) {
			expect(buildRrule(parseRrule(r, now))).toBe(r);
		}
		expect(parseRrule('RRULE:FREQ=MINUTELY;INTERVAL=5', now)).toMatchObject({ frequency: 'MINUTELY', interval: 5 });
		expect(parseRrule('RRULE:FREQ=WEEKLY;BYDAY=FR,TH,WE,TU,MO;BYHOUR=9;BYMINUTE=0', now).frequency).toBe('WEEKDAYS');
		expect(parseRrule('RRULE:FREQ=MINUTELY;INTERVAL=5;BYMINUTE=3', now).frequency).toBe('CUSTOM');
		expect(parseRrule('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;BYHOUR=9;BYMINUTE=0', now).frequency).toBe('CUSTOM');
		// The picker cannot show a run count, so it would save the rule without one.
		expect(parseRrule('RRULE:FREQ=DAILY;COUNT=10', now).frequency).toBe('CUSTOM');
	});
	it('a rule the picker would change on save stays custom (#159)', () => {
		for (const r of [
			'RRULE:FREQ=MONTHLY;BYDAY=1MO;BYHOUR=9;BYMINUTE=0', // first Monday, not the 1st
			'RRULE:FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0', // twice a day
			'RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0;UNTIL=20261231T000000Z', // ends
			'RRULE:FREQ=DAILY;BYMINUTE=0' // at DTSTART's hour, not 9
		]) {
			expect(parseRrule(r, now)).toMatchObject({ frequency: 'CUSTOM', custom: r });
		}
		for (const r of [
			'DTSTART:20250106T090000\nRRULE:FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0', // its weekday is DTSTART's
			'DTSTART:20271201T090000\nRRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0', // starts in 2027
			'RRULE:FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0', // no interval control for months
			'RRULE:FREQ=WEEKLY;BYDAY=mo;BYHOUR=9;BYMINUTE=0', // no button for it
			'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=9;BYMINUTE=0', // last day
			'RRULE:FREQ=DAILY;BYHOUR=24;BYMINUTE=0'
		]) {
			expect(parseRrule(r, now).frequency).toBe('CUSTOM');
		}
		// Spelling that means the same rule still opens in the picker.
		expect(parseRrule('RRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=09;BYMINUTE=00', now)).toMatchObject({
			frequency: 'DAILY',
			hour: 9,
			minute: 0
		});
	});
	it("the assistant's documented examples open and read as what they do", () => {
		// apps/server/local_llm/tools/builtin.py create_automation's docstring.
		const cases: [string, string, string | RegExp][] = [
			['DTSTART:20250101T090000\nRRULE:FREQ=DAILY', 'CUSTOM', 'Every day at 9:00 AM'],
			['DTSTART:20250106T080000\nRRULE:FREQ=WEEKLY;BYDAY=MO', 'CUSTOM', 'Every week on Monday at 8:00 AM'],
			['RRULE:FREQ=HOURLY;INTERVAL=1', 'HOURLY', 'Hourly'],
			['RRULE:FREQ=MINUTELY;INTERVAL=30', 'MINUTELY', 'Every 30 minutes'],
			['DTSTART:20250415T140000\nRRULE:FREQ=DAILY;COUNT=1', 'ONCE', /^Once · /],
			['DTSTART:20250101T090000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=1', 'CUSTOM', 'Every month on the 1st at 9:00 AM']
		];
		for (const [rule, frequency, label] of cases) {
			expect(parseRrule(rule, now).frequency, rule).toBe(frequency);
			if (label instanceof RegExp) expect(formatSchedule(rule, now)).toMatch(label);
			else expect(formatSchedule(rule, now), rule).toBe(label);
		}
		// No hour and no start: it is not a schedule anyone can be told.
		expect(formatSchedule('RRULE:FREQ=DAILY;BYMINUTE=0', now)).toBe(CUSTOM_SCHEDULE);
	});
	it('switching to Custom starts from the schedule that was showing', () => {
		const s = { ...defaultSchedule(now), hour: 7 };
		expect(withFrequency(s, 'CUSTOM').custom).toBe('RRULE:FREQ=DAILY;BYHOUR=7;BYMINUTE=0');
		expect(withFrequency({ ...s, frequency: 'CUSTOM', custom: 'X' }, 'CUSTOM').custom).toBe('X');
	});
	it('every few minutes starts at 15, and Weekly with no day starts on today (#1104)', () => {
		const s = defaultSchedule(now);
		expect(withFrequency(s, 'MINUTELY', now)).toMatchObject({ frequency: 'MINUTELY', interval: 15 });
		expect(withFrequency({ ...s, interval: 15, frequency: 'MINUTELY' }, 'HOURLY', now).interval).toBe(1);
		// 2026-09-27 is a Sunday.
		expect(withFrequency(s, 'WEEKLY', now).days).toEqual(['SU']);
		expect(withFrequency({ ...s, days: ['MO'] }, 'WEEKLY', now).days).toEqual(['MO']);
	});
	it('summaries spell the schedule out, never the rule (#1032)', () => {
		expect(formatSchedule('RRULE:FREQ=DAILY;BYHOUR=0;BYMINUTE=5', now)).toBe('Daily at 12:05 AM');
		expect(formatSchedule('RRULE:FREQ=MONTHLY;BYMONTHDAY=22;BYHOUR=13;BYMINUTE=0', now)).toBe(
			'Monthly on the 22nd at 1:00 PM'
		);
		expect(formatSchedule('RRULE:FREQ=MONTHLY;BYMONTHDAY=11;BYHOUR=13;BYMINUTE=0', now)).toBe(
			'Monthly on the 11th at 1:00 PM'
		);
		expect(formatSchedule('RRULE:FREQ=HOURLY;INTERVAL=2', now)).toBe('Every 2 hours');
		expect(formatSchedule('RRULE:FREQ=HOURLY;BYMINUTE=15', now)).toBe('Hourly at 15 minutes past');
		expect(formatSchedule('RRULE:FREQ=MINUTELY;INTERVAL=1', now)).toBe('Every minute');
		expect(formatSchedule('RRULE:FREQ=DAILY;INTERVAL=3;BYHOUR=9;BYMINUTE=0', now)).toBe('Every 3 days at 9:00 AM');
		expect(formatSchedule('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0', now)).toBe(
			'Weekdays at 9:00 AM'
		);
		expect(formatSchedule('RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=7;BYMINUTE=30', now)).toBe(
			'Mon, Wed, Fri at 7:30 AM'
		);
		expect(formatSchedule('RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=7;BYMINUTE=30', now)).toBe('Every Monday at 7:30 AM');
		expect(formatSchedule('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=7;BYMINUTE=30', now)).toBe(
			'Every day at 7:30 AM'
		);
		expect(formatSchedule('RRULE:FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17;BYMINUTE=0', now)).toBe(
			'Every month on the last Friday at 5:00 PM'
		);
		expect(formatSchedule('RRULE:FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0', now)).toBe('Every day at 9:00 AM and 5:00 PM');
		expect(formatSchedule('RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0;UNTIL=20261231T000000Z', now)).toMatch(
			/^Every week on Monday until .+ at 9:00 AM$/
		);
		expect(formatSchedule('DTSTART:20271201T090000\nRRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0', now)).toMatch(
			/^Every day at 9:00 AM, starting .*2027$/
		);
		expect(formatSchedule('RRULE:FREQ=YEARLY', now)).toBe('Every year, at the time it is saved');
		// A rule that cannot be told whole is named, never shown as itself or cut short (#159).
		for (const r of [
			'RRULE:FREQ=MINUTELY;INTERVAL=5;BYHOUR=9',
			'RRULE:FREQ=DAILY;BYHOUR=1,2,3,4,5;BYMINUTE=0',
			'RRULE:FREQ=DAILY;BYSECOND=30',
			'not a rule',
			'RRULE:FREQ=DAILY\nEXRULE:FREQ=WEEKLY'
		])
			expect(formatSchedule(r, now), r).toBe(CUSTOM_SCHEDULE);
		expect(formatSchedule('DTSTART:20261001T080500\nRRULE:FREQ=DAILY;COUNT=1', now)).toMatch(/^Once · Oct 1 8:05 AM$/);
		expect(formatSchedule('RRULE:FREQ=DAILY;COUNT=1', now)).toBe('Once');
	});
	it('the chip names the frequency with its time', () => {
		const s = defaultSchedule(now);
		expect(scheduleChipLabel(s, now)).toBe('Daily at 9:00 AM');
		expect(scheduleChipLabel({ ...s, frequency: 'WEEKLY', days: ['MO'] }, now)).toBe('Every Monday at 9:00 AM');
		expect(scheduleChipLabel({ ...s, frequency: 'CUSTOM', custom: 'x' }, now)).toBe('Custom rule');
	});
});

describe('the next runs and a custom rule (#1032)', () => {
	// Wednesday 2026-11-18 10:07 local.
	const wed = new Date(2026, 10, 18, 10, 7, 20);
	it('works the next runs out as the scheduler does', () => {
		expect(previewRuns('RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0', 2, wed)).toEqual([
			new Date(2026, 10, 19, 9, 0),
			new Date(2026, 10, 20, 9, 0)
		]);
		// Every 15 minutes runs on the clock's grid.
		expect(previewRuns('RRULE:FREQ=MINUTELY;INTERVAL=15', 2, wed)).toEqual([
			new Date(2026, 10, 18, 10, 15),
			new Date(2026, 10, 18, 10, 30)
		]);
		expect(previewRuns('RRULE:FREQ=HOURLY;BYMINUTE=0', 1, wed)).toEqual([new Date(2026, 10, 18, 11, 0)]);
		// A rule that does not state its time takes now's, on the minute.
		expect(previewRuns('RRULE:FREQ=DAILY', 1, wed)).toEqual([new Date(2026, 10, 19, 10, 7)]);
		expect(previewRuns('DTSTART:20261201T083000\nRRULE:FREQ=DAILY;COUNT=1', 3, wed)).toEqual([
			new Date(2026, 11, 1, 8, 30)
		]);
		expect(previewRuns('DTSTART:20261201T083000Z\nRRULE:FREQ=DAILY;COUNT=1', 1, wed)).toEqual([
			new Date(Date.UTC(2026, 11, 1, 8, 30))
		]);
		expect(previewRuns('DTSTART:20250101T090000\nRRULE:FREQ=DAILY;COUNT=2', 3, wed)).toEqual([]);
		expect(previewRuns('nonsense', 3, wed)).toEqual([]);
		expect(runTimeText(new Date(2026, 10, 19, 9, 0))).toBe('Thu, Nov 19, 9:00 AM');
	});
	it('says what is wrong with a custom rule, with an example', () => {
		expect(customRuleProblem('RRULE:FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=17;BYMINUTE=0', wed)).toBeNull();
		expect(customRuleProblem('', wed)).toMatch(/^Enter a rule, for example RRULE:/);
		expect(customRuleProblem('RRULE:FREQ', wed)).toMatch(/^The scheduler can't read this rule\. Write it like/);
		expect(customRuleProblem('RRULE:FREQ=DAILY;COUNT=3', wed)).toMatch(/needs a DTSTART/);
		expect(customRuleProblem('DTSTART:20250101T090000\nRRULE:FREQ=DAILY;COUNT=2', wed)).toMatch(/no runs left/);
	});
	it("words the server's refusals of a schedule, and leaves other errors alone", () => {
		expect(ruleProblemFromServer('Invalid RRULE: not enough values to unpack (expected 2, got 1)')).toMatch(
			/^The scheduler can't read this rule/
		);
		expect(ruleProblemFromServer('RRULE has no future occurrences')).toMatch(/no runs left/);
		expect(ruleProblemFromServer('RRULE with COUNT requires an explicit DTSTART line')).toMatch(/DTSTART/);
		expect(ruleProblemFromServer('Schedule too frequent. Minimum interval is 300 seconds.')).toBe(
			'This runs too often. Runs must be at least 5 minutes apart (Admin Settings > Automations).'
		);
		expect(ruleProblemFromServer('Schedule too frequent. Minimum interval is 90 seconds.')).toMatch(/90 seconds/);
		expect(ruleProblemFromServer('Not found')).toBeNull();
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
	it('offers channels by name, leaving out DMs and public groups not joined (#331)', () => {
		const channels = [
			{ id: 'z', name: 'zeta', type: 'group', is_member: true },
			{ id: 'd', name: '', type: 'dm' },
			{ id: 'l', name: 'lobby', type: 'group', is_member: false },
			{ id: 'a', name: 'alpha', type: '' }
		];
		expect(channelOptions(channels).map((c) => c.id)).toEqual(['a', 'z']);
	});
	it('labels the destination', () => {
		const a = (x: object) => ({ folder_id: null, data: { prompt: '', model_id: '', rrule: '' }, ...x }) as any;
		expect(destinationLabel(a({}), [], [])).toBe('New chat');
		expect(destinationLabel(a({ folder_id: 'a' }), folders, [], true)).toBe('Folder: Alpha');
		const same = { prompt: '', model_id: '', rrule: '', target: { type: 'chat', same_chat: true } };
		expect(destinationLabel(a({ data: same }), [], [])).toBe('Same chat');
		expect(destinationLabel(a({ folder_id: 'a', data: same }), folders, [], true)).toBe('Folder: Alpha, same chat');
		expect(destinationLabel(a({ folder_id: 'a', data: same }), folders, [])).toBe('Folder, same chat');
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
	it('marks each missing field, and builds', () => {
		const f = automationFields(null, { now });
		expect(automationPayload(f, now)).toEqual({
			problems: {
				name: 'Enter a name for the automation.',
				prompt: 'Enter the instructions the model follows on each run.',
				model: 'Choose the model that runs it.'
			}
		});
		const ready = { ...f, name: ' N ', prompt: ' P ', modelId: 'm', folderId: 'a' };
		expect(automationProblems({ ...ready, targetType: 'channel' }, now)).toEqual({
			channel: 'Choose a channel, or post to a chat instead.'
		});
		expect(
			automationProblems(
				{ ...ready, schedule: { ...ready.schedule, frequency: 'ONCE', onceDate: '2026-09-27', onceTime: '22:00' } },
				now
			)
		).toEqual({ schedule: 'Pick a time in the future for the one-time run.' });
		expect(
			automationProblems({ ...ready, schedule: { ...ready.schedule, frequency: 'CUSTOM', custom: 'RRULE:FREQ' } }, now)
				.schedule
		).toMatch(/can't read this rule/);
		expect(automationPayload(ready, now)).toEqual({
			form: {
				name: 'N',
				folder_id: 'a',
				data: { prompt: 'P', model_id: 'm', rrule: 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0', target: { type: 'chat' } },
				is_active: true
			}
		});
		const toChannel = automationPayload({ ...ready, targetType: 'channel', channelId: 'c1', sameChat: true }, now);
		expect('form' in toChannel && toChannel.form.folder_id).toBeNull();
		expect('form' in toChannel && toChannel.form.data.target).toEqual({ type: 'channel', channel_id: 'c1' });
		const same = automationPayload({ ...ready, sameChat: true }, now);
		expect('form' in same && same.form.data.target).toEqual({ type: 'chat', same_chat: true });
		expect(
			automationFields({ ...existing, data: { ...existing.data, target: { type: 'chat', same_chat: true } } }).sameChat
		).toBe(true);
	});
	it('refuses a one-time run with a cleared date or time, instead of running it at midnight (#322)', () => {
		const ready = { ...automationFields(null, { now }), name: 'N', prompt: 'P', modelId: 'm' };
		const once = (onceDate: string, onceTime: string) =>
			automationPayload({ ...ready, schedule: { ...ready.schedule, frequency: 'ONCE', onceDate, onceTime } }, now);
		const refusal = { problems: { schedule: 'Pick a date and time for the one-time run.' } };

		expect(once('2026-12-01', '')).toEqual(refusal);
		expect(once('', '10:30')).toEqual(refusal);
		expect(once('', '')).toEqual(refusal);
		const whole = once('2026-12-01', '10:30');
		expect('form' in whole && whole.form.data.rrule).toBe('DTSTART:20261201T103000\nRRULE:FREQ=DAILY;COUNT=1');
	});
});

describe('timeFromInput (#322)', () => {
	it('reads a whole time', () => {
		expect(timeFromInput('09:05')).toEqual({ hour: 9, minute: 5 });
		expect(timeFromInput('23:59:30')).toEqual({ hour: 23, minute: 59 });
	});
	it('is null while the box is cleared or incomplete, so the schedule keeps its time', () => {
		expect(timeFromInput('')).toBeNull();
		expect(timeFromInput('9')).toBeNull();
		expect(timeFromInput('--:--')).toBeNull();
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
				{
					name: 'B',
					folder_id: 'theirs',
					data: { prompt: 'p', model_id: 'm', rrule: 'R', target: { type: 'chat', same_chat: true } }
				},
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
		expect(forms[1].data.target).toEqual({ type: 'chat', same_chat: true });
		expect(JSON.stringify(forms)).not.toContain('evil');
	});
	it('refuses a file that is not a list', () => {
		expect(() => parseAutomationImport('{"x":1}', new Set())).toThrow('Invalid JSON format');
	});
});

describe('importing each automation on its own (#323)', () => {
	const now = new Date(2026, 9, 1, 12);
	const form = (name: string, rrule = 'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0') => ({
		name,
		folder_id: null,
		data: { prompt: 'p', model_id: 'm', rrule, target: { type: 'chat' as const } },
		is_active: true
	});

	it('keeps going past a refused one, and says which could not be created', async () => {
		const created: string[] = [];
		const outcome = await importAutomationForms(
			[form('A'), form('B'), form('C')],
			1,
			async (f) => {
				if (f.name === 'B') throw 'Invalid schedule';
				created.push(f.name);
			},
			now
		);

		expect(created).toEqual(['A', 'C']);
		expect(outcome).toEqual({ imported: 2, skipped: 1, passed: 0, failed: [{ name: 'B', error: 'Invalid schedule' }] });
		expect(importMessage(outcome)).toEqual({
			ok: false,
			message: 'Imported 2 automations; skipped 1 incomplete; 1 could not be created: B (Invalid schedule)'
		});
	});

	it('skips a one-time automation whose time has passed, and imports one still to come', async () => {
		const created: string[] = [];
		const outcome = await importAutomationForms(
			[
				form('Ran', 'DTSTART:20260901T090000\nRRULE:FREQ=DAILY;COUNT=1'),
				form('Soon', 'DTSTART:20261201T090000\nRRULE:FREQ=DAILY;COUNT=1')
			],
			0,
			async (f) => {
				created.push(f.name);
			},
			now
		);

		expect(created).toEqual(['Soon']);
		expect(importMessage(outcome)).toEqual({
			ok: true,
			message: 'Imported 1 automation; skipped 1 one-time automation whose time has passed'
		});
	});

	it('leaves a one-count rule of another shape to the server, which may still run it', async () => {
		const created: string[] = [];
		await importAutomationForms(
			[form('Friday', 'DTSTART:20260901T090000\nRRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=1')],
			0,
			async (f) => {
				created.push(f.name);
			},
			now
		);

		expect(created).toEqual(['Friday']);
	});

	it('names the first three failures and counts the rest, and reads an error object', async () => {
		const outcome = await importAutomationForms(
			['A', 'B', 'C', 'D', 'E'].map((n) => form(n)),
			0,
			async () => {
				throw { detail: 'Automation limit reached (10)' };
			},
			now
		);

		expect(importMessage(outcome).message).toBe(
			'Imported 0 automations; 5 could not be created: A (Automation limit reached (10)); ' +
				'B (Automation limit reached (10)); C (Automation limit reached (10)); and 2 more'
		);
	});

	it('reports a clean import plainly', () => {
		expect(importMessage({ imported: 3, skipped: 0, passed: 0, failed: [] })).toEqual({
			ok: true,
			message: 'Imported 3 automations'
		});
	});
});

describe('weekly rule states its day (#670, #1104)', () => {
	const ready = {
		...automationFields(null, { now }),
		name: 'n',
		prompt: 'p',
		modelId: 'm'
	};
	const rruleOf = (days: string[]) => {
		const out = automationPayload(
			{ ...ready, schedule: { ...ready.schedule, frequency: 'WEEKLY', hour: 8, minute: 15, days } },
			now
		);
		return 'form' in out ? out.form.data.rrule : out.problems.schedule;
	};
	it('refuses a weekly schedule with no day, instead of taking the day of the save', () => {
		expect(rruleOf([])).toBe('Choose at least one day.');
		expect(buildRrule({ ...ready.schedule, frequency: 'WEEKLY', hour: 8, minute: 15, days: [] })).not.toContain(
			'BYDAY'
		);
	});
	it('keeps the chosen days', () => {
		expect(rruleOf(['MO', 'WE'])).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=8;BYMINUTE=15');
	});
});
