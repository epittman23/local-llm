import { describe, expect, it } from 'vitest';
import { statusText } from './statusText';

// #529: the retrieval statuses carry no description, and some descriptions are
// templates the Svelte page filled in (d863707:.../StatusHistory/StatusItem.svelte).

describe('statusText', () => {
	it('says what a knowledge base search is looking for', () => {
		expect(statusText({ action: 'knowledge_search', query: 'tax rates' })).toBe('Searching Knowledge for "tax rates"');
	});

	it('lists the queries a retrieval generated', () => {
		expect(statusText({ action: 'queries_generated', queries: ['a', 'b'] })).toBe('Querying "a", "b"');
		expect(statusText({ action: 'web_search_queries_generated', queries: ['news'] })).toBe('Searching "news"');
	});

	it('counts the sources retrieved', () => {
		expect(statusText({ action: 'sources_retrieved', count: 0 })).toBe('No sources found');
		expect(statusText({ action: 'sources_retrieved', count: 1 })).toBe('Retrieved 1 source');
		expect(statusText({ action: 'sources_retrieved', count: 4 })).toBe('Retrieved 4 sources');
	});

	it('fills a description that is a template', () => {
		expect(
			statusText({ action: 'web_search', description: 'Searched {{count}} sites', urls: ['u1', 'u2', 'u3'] })
		).toBe('Searched 3 sites');
		expect(statusText({ action: 'web_search', description: 'Searched {{count}} sites', items: [{}, {}] })).toBe(
			'Searched 2 sites'
		);
		expect(statusText({ description: 'Searching "{{searchQuery}}"', query: 'weather' })).toBe('Searching "weather"');
	});

	it('shows any other description as it is, and nothing without one', () => {
		expect(statusText({ action: 'web_search', description: 'Searching the web' })).toBe('Searching the web');
		expect(statusText({ description: 'Running tool' })).toBe('Running tool');
		expect(statusText({ action: 'queries_generated' })).toBe('');
		expect(statusText({})).toBe('');
	});
});
