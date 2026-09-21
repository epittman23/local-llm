import { describe, expect, it } from 'vitest';
import type { EventWebhook } from '@/lib/apis';
import {
	addFilter,
	errorMessage,
	eventSummary,
	filterEvents,
	isValidPattern,
	removeFilter,
	setAllEvents,
	sortWebhooks,
	targetSummary,
	targetsFor,
	targetsToState,
	toggleEvent,
	urlHost,
	webhookPayload
} from './eventWebhooks';

const hook = (over: Partial<EventWebhook> = {}): EventWebhook => ({ id: 'w', name: 'W', url: 'https://a.test/x', enabled: true, events: ['*'], targets: null, ...over });
const CATALOG = ['chat.created', 'chat.deleted', 'user.created', 'user.role.changed'];

describe('sortWebhooks', () => {
	it('puts default first and the rest by name, without mutating', () => {
		const input = [hook({ id: 'b', name: 'Beta' }), hook({ id: 'default', name: 'Zed' }), hook({ id: 'a', name: 'Alpha' })];
		expect(sortWebhooks(input).map((w) => w.id)).toEqual(['default', 'a', 'b']);
		expect(input.map((w) => w.id)).toEqual(['b', 'default', 'a']);
	});
});

describe('summaries', () => {
	it('describes events', () => {
		expect(eventSummary(hook({ events: [] }))).toBe('All events');
		expect(eventSummary(hook({ events: ['user.*', '*'] }))).toBe('All events');
		expect(eventSummary(hook({ events: ['a', 'b'] }))).toBe('a + b');
		expect(eventSummary(hook({ events: ['a', 'b', 'c'] }))).toBe('3 filters');
	});
	it('describes targets: null is everyone, [] is system only', () => {
		expect(targetSummary(hook({ targets: null }))).toBe('All users and system events');
		expect(targetSummary(hook({ targets: [] }))).toBe('System events only');
		expect(targetSummary(hook({ targets: [{ type: 'user', id: '1' }] }))).toBe('1 user');
		expect(
			targetSummary(
				hook({
					targets: [
						{ type: 'user', id: '1' },
						{ type: 'user', id: '2' },
						{ type: 'group', id: 'g' }
					]
				})
			)
		).toBe('2 users + 1 group');
	});
	it('shows a URL host, or the raw text when it is not a URL', () => {
		expect(urlHost('https://hooks.example.com/a?b=1')).toBe('hooks.example.com');
		expect(urlHost('nonsense')).toBe('nonsense');
		expect(urlHost('')).toBe('Not configured');
	});
});

describe('patterns', () => {
	it('accepts *, exact events, and prefix.* with a match; rejects the rest', () => {
		expect(isValidPattern('*', CATALOG)).toBe(true);
		expect(isValidPattern('chat.created', CATALOG)).toBe(true);
		expect(isValidPattern('user.*', CATALOG)).toBe(true);
		expect(isValidPattern('nope.*', CATALOG)).toBe(false);
		expect(isValidPattern('chat', CATALOG)).toBe(false);
	});
	it('filters the catalog case-insensitively, ignoring a trailing *', () => {
		expect(filterEvents(CATALOG, 'USER.*')).toEqual(['user.created', 'user.role.changed']);
		expect(filterEvents(CATALOG, '')).toEqual(CATALOG);
	});
	it('adding * replaces everything; adding anything else drops * and dedupes', () => {
		expect(addFilter(['a', 'b'], '*')).toEqual(['*']);
		expect(addFilter(['*'], 'a')).toEqual(['a']);
		expect(addFilter(['a'], 'a')).toEqual(['a']);
	});
	it('toggles an event, keeping the list sorted and dropping *', () => {
		expect(toggleEvent(['*'], 'b')).toEqual(['b']);
		expect(toggleEvent(['b'], 'a')).toEqual(['a', 'b']);
		expect(toggleEvent(['a', 'b'], 'a')).toEqual(['b']);
	});
	it('removing the last filter falls back to all events', () => {
		expect(removeFilter(['a', 'b'], 'a')).toEqual(['b']);
		expect(removeFilter(['a'], 'a')).toEqual(['*']);
	});
	it('"All events" on is *, off is empty', () => {
		expect(setAllEvents(true)).toEqual(['*']);
		expect(setAllEvents(false)).toEqual([]);
	});
});

describe('targets', () => {
	it('maps the mode to the wire shape and back', () => {
		expect(targetsFor('all', ['u'], ['g'])).toBeNull();
		expect(targetsFor('system', ['u'], ['g'])).toEqual([]);
		expect(targetsFor('selected', ['u'], ['g'])).toEqual([
			{ type: 'user', id: 'u' },
			{ type: 'group', id: 'g' }
		]);
		expect(targetsToState(null)).toEqual({ mode: 'all', userIds: [], groupIds: [] });
		expect(targetsToState([])).toEqual({ mode: 'system', userIds: [], groupIds: [] });
		expect(
			targetsToState([
				{ type: 'group', id: 'g' },
				{ type: 'user', id: 'u' }
			])
		).toEqual({ mode: 'selected', userIds: ['u'], groupIds: ['g'] });
	});
	it('"selected" with nobody picked sends an empty list, which the backend reads as system-only', () => {
		// The Svelte modal has the same behaviour; recorded so a change is deliberate.
		expect(targetsFor('selected', [], [])).toEqual([]);
	});
});

describe('webhookPayload', () => {
	const form = { id: '', name: '', url: 'https://x.test', enabled: false, events: [] as string[] };
	it('names an unnamed webhook, and the default one specially', () => {
		expect(webhookPayload(form, null).name).toBe('Webhook');
		expect(webhookPayload({ ...form, id: 'default' }, null).name).toBe('Default webhook');
		expect(webhookPayload({ ...form, name: 'Audit' }, null).name).toBe('Audit');
	});
	it('never sends an empty event list', () => {
		expect(webhookPayload(form, []).events).toEqual(['*']);
		expect(webhookPayload({ ...form, events: ['a'] }, []).events).toEqual(['a']);
	});
});

describe('errorMessage', () => {
	it('takes a string, a {detail}, or falls back', () => {
		expect(errorMessage('boom', 'x')).toBe('boom');
		expect(errorMessage({ detail: 'bad url' }, 'x')).toBe('bad url');
		expect(errorMessage({ detail: [{ msg: 'x' }] }, 'fallback')).toBe('fallback');
		expect(errorMessage(null, 'fallback')).toBe('fallback');
	});
});
