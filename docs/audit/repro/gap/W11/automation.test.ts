import { describe, expect, it } from 'vitest';
import {
	automationPayload,
	automationFields,
	buildRrule,
	defaultSchedule
} from '@/routes/automations/automationModel';
import { buildEmojiIndex } from '@/lib/emoji/emoji';
import codes from '@/lib/emoji/emoji-shortcodes.json';
import groups from '@/lib/emoji/emoji-groups.json';

describe('W11 automation/emoji repros', () => {
	it('clearing the Daily time field', () => {
		// AutomationDialog.tsx:134-137, the onChange of the time input, applied to the value a cleared/incomplete <input type=time> reports.
		const value = '';
		const [hour, minute] = value.split(':').map(Number);
		const guardPasses = !Number.isNaN(hour);
		const s = { ...defaultSchedule(), hour, minute } as ReturnType<typeof defaultSchedule>;
		console.log('guard passes:', guardPasses, 'hour', hour, 'minute', minute);
		console.log('time input value rendered:', `${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`);
		console.log('rrule sent:', buildRrule(s));
		const f = { ...automationFields(null), name: 'n', prompt: 'p', modelId: 'm', schedule: s };
		const out = automationPayload(f);
		console.log('payload:', JSON.stringify(out));
		expect(buildRrule(s)).toContain('BYMINUTE=undefined');
	});

	it('clearing the Once time field', () => {
		const s = { ...defaultSchedule(), frequency: 'ONCE' as const, onceDate: '2026-12-01', onceTime: '' };
		const f = { ...automationFields(null), name: 'n', prompt: 'p', modelId: 'm', schedule: s };
		const out = automationPayload(f);
		console.log('once payload:', JSON.stringify(out));
	});

	it('emoji presentation', () => {
		const idx = buildEmojiIndex(codes as any, groups as any);
		for (const n of ['heart', 'warning', 'relaxed', 'v', 'point_up', 'heavy_check_mark', 'sunny', 'thumbsup', '+1'])
			console.log(n, JSON.stringify(idx.byName[n]), [...(idx.byName[n] ?? '')].map((c) => c.codePointAt(0)!.toString(16)));
		const picker = idx.all.slice(0, 400);
		console.log('picker items total', idx.all.length, 'shown with empty search', picker.length, 'last group shown', picker[399].group, 'groups', idx.groups);
		const textPres = idx.all.filter((e) => !e.char.includes('️') && (groups as any)[e.group].includes(Object.keys(codes).find((k) => [].concat((codes as any)[k])[0] === e.name) + '-FE0F'));
		console.log('picker items lacking VS16 although data lists a FE0F form:', textPres.length);
	});
});
