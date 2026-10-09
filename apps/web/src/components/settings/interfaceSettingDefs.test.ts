import { describe, expect, it } from 'vitest';
import {
	ROWS,
	type CycleDef,
	cycleState,
	hasSettingPath,
	isInherited,
	isShown,
	newFloatingAction,
	readSetting,
	settingPatch,
	stepTextScale
} from './interfaceSettingDefs';

const allRows = Object.values(ROWS).flat();
const cycleDef = (key: string) => allRows.find((r) => r.kind === 'cycle' && r.key === key) as CycleDef;

describe('ROWS', () => {
	it('has every setting once', () => {
		const keys = allRows.map((r) => (r.kind === 'custom' ? r.id : r.key));
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys.length).toBeGreaterThan(50);
	});
	it('conditional rows follow their parent setting and the viewer', () => {
		const find = (key: string) =>
			allRows.find((r) => r.kind !== 'custom' && r.kind !== 'cycle' && r.key === key) as any;
		const ctx = { isAdmin: false, canTemporaryChat: false, autocompleteEnabled: false, values: {} };
		expect(find('showUsername').visible(ctx)).toBe(false);
		expect(find('showUsername').visible({ ...ctx, values: { chatBubble: false } })).toBe(true);
		expect(find('showUpdateToast').visible(ctx)).toBe(false);
		expect(find('temporaryChatByDefault').visible({ ...ctx, canTemporaryChat: true })).toBe(true);
		expect(find('showFormattingToolbar').visible({ ...ctx, values: { richTextInput: false } })).toBe(false);
		expect(find('imageCompressionInChannels').visible({ ...ctx, values: { imageCompression: true } })).toBe(true);
	});
});

describe('only what the app does is offered (docs/code-review.md M7)', () => {
	const ctx = {
		isAdmin: true,
		canTemporaryChat: true,
		autocompleteEnabled: true,
		values: { chatBubble: false, richTextInput: true, imageCompression: true }
	};
	const keyOf = (r: (typeof allRows)[number]) =>
		r.kind === 'custom'
			? ({ textScale: 'textScale', fontFamily: 'fontFamily', backgroundImage: 'backgroundImageUrl' } as const)[r.id]
			: r.key;

	it('rows for unported features are never shown', () => {
		for (const key of [
			'richTextInput',
			'iframeSandboxAllowScripts',
			'voiceInterruption',
			'showUpdateToast',
			'landingPageMode',
			'showFloatingActionButtons'
		]) {
			const row = allRows.find((r) => keyOf(r) === key)!;
			expect(isShown(row, ctx), key).toBe(false);
		}
		expect(isShown(allRows.find((r) => keyOf(r) === 'chatBubble')!, ctx)).toBe(true);
	});

	it('every row still offered is read somewhere outside the Settings modal', () => {
		const sources = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<
			string,
			string
		>;
		const app = Object.entries(sources)
			.filter(([path]) => !path.includes('/components/settings/') && !/\.test\.tsx?$/.test(path))
			.map(([, text]) => text)
			.join('\n');
		const offered = allRows.filter((r) => r.kind === 'custom' || !r.unported).map(keyOf);
		// `title.auto` is read as `settings?.title?.auto`.
		const unread = offered.filter(
			(key) => !new RegExp(key.includes('.') ? key.replace('.', '\\??\\.') : `\\b${key}\\b`).test(app)
		);
		expect(unread).toEqual([]);
	});
});

describe('paths', () => {
	it('hasSettingPath sees falsy values but not missing ones', () => {
		expect(hasSettingPath({ a: false }, 'a')).toBe(true);
		expect(hasSettingPath({ title: { auto: false } }, 'title.auto')).toBe(true);
		expect(hasSettingPath({ title: null }, 'title.auto')).toBe(false);
		expect(hasSettingPath(null, 'a')).toBe(false);
	});
	it('readSetting falls back for unset and null', () => {
		expect(readSetting({ a: false }, 'a', true)).toBe(false);
		expect(readSetting({ a: null }, 'a', true)).toBe(true);
		expect(readSetting({}, 'title.auto', true)).toBe(true);
	});
	it('settingPatch keeps nested siblings', () => {
		expect(settingPatch({ title: { auto: true, prompt: 'p' } }, 'title.auto', false)).toEqual({
			title: { auto: false, prompt: 'p' }
		});
		expect(settingPatch({}, 'title.auto', false)).toEqual({ title: { auto: false } });
		expect(settingPatch({}, 'chatBubble', false)).toEqual({ chatBubble: false });
	});
	it('only personal settings inherit, and only what the user has not set', () => {
		expect(isInherited('personal', { a: 1 }, {}, 'a')).toBe(true);
		expect(isInherited('personal', { a: 1 }, { a: 2 }, 'a')).toBe(false);
		expect(isInherited('defaults', { a: 1 }, {}, 'a')).toBe(false);
	});
});

describe('cycles and steps', () => {
	it('an unset cycle shows its first option, and wraps around', () => {
		const dir = cycleDef('chatDirection');
		expect(cycleState(dir, {})).toEqual({ option: { value: 'auto', label: 'Auto' }, next: 'LTR' });
		expect(cycleState(dir, { chatDirection: 'RTL' }).next).toBe('auto');
		expect(cycleState(cycleDef('webSearch'), { webSearch: 'always' })).toEqual({
			option: { value: 'always', label: 'Always' },
			next: null
		});
		expect(cycleState(dir, { chatDirection: 'nonsense' }).option.label).toBe('Auto');
	});
	it('UI scale steps by 0.1 within 1-1.5', () => {
		expect(stepTextScale(null, 0.1)).toBe(1.1);
		expect(stepTextScale(1.45, 0.1)).toBe(1.5);
		expect(stepTextScale(1.05, -0.1)).toBe(1);
	});
	it('new quick actions take the first free id', () => {
		expect(newFloatingAction([]).id).toBe('new-button');
		expect(newFloatingAction([{ id: 'new-button' }, { id: 'new-button-1' }] as any).id).toBe('new-button-2');
	});
});
