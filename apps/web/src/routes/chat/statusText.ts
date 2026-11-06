import type { Status } from '@/lib/chat/history';

const quoted = (v: unknown) => (Array.isArray(v) ? v.map((q) => `"${String(q)}"`).join(', ') : '');

/**
 * The line a reply's status shows. Ports the wording of
 * d863707:apps/openwebui/src/lib/components/chat/Messages/ResponseMessage/StatusHistory/StatusItem.svelte:
 * the retrieval statuses carry an action and its data but no description,
 * and a description may be a template for the status's own count or query
 * (#529). Anything else shows its description as it is; a status with
 * nothing to say gives ''.
 */
export function statusText(s: Status): string {
	switch (s.action) {
		case 'knowledge_search':
			if (s.query) return `Searching Knowledge for "${String(s.query)}"`;
			break;
		case 'queries_generated':
			if (Array.isArray(s.queries) && s.queries.length) return `Querying ${quoted(s.queries)}`;
			break;
		case 'web_search_queries_generated':
			if (Array.isArray(s.queries) && s.queries.length) return `Searching ${quoted(s.queries)}`;
			break;
		case 'sources_retrieved':
			if (typeof s.count === 'number') {
				if (s.count === 0) return 'No sources found';
				return s.count === 1 ? 'Retrieved 1 source' : `Retrieved ${s.count} sources`;
			}
			break;
	}
	let text = typeof s.description === 'string' ? s.description : '';
	// As the original: {{count}} is the sites a web search found, filled only when it lists them.
	const found = Array.isArray(s.urls) ? s.urls : Array.isArray(s.items) ? s.items : null;
	if (found) text = text.replaceAll('{{count}}', String(found.length));
	if (s.query !== undefined) text = text.replaceAll('{{searchQuery}}', String(s.query));
	return text;
}
