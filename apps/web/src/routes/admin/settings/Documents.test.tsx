import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import Documents from './Documents';

// #234: a JSON box the server will refuse passed the page's check (the headers
// box was checked only with the external loader selected; the Docling and
// MinerU boxes took any JSON, `[]` included), and Save applied the embedding
// model before the config save the server then refused: half the save
// happened. Every box is checked whatever the engine, before anything is sent.

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({
	toast: Object.assign(vi.fn(), { error: toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() })
}));

const RAG = {
	CONTENT_EXTRACTION_ENGINE: '',
	BYPASS_EMBEDDING_AND_RETRIEVAL: false,
	TEXT_SPLITTER: '',
	CHUNK_SIZE: 1000,
	CHUNK_OVERLAP: 100,
	ENABLE_RAG_HYBRID_SEARCH: false,
	TOP_K: 3,
	ALLOWED_FILE_EXTENSIONS: [],
	FILE_MAX_SIZE: null,
	FILE_MAX_COUNT: null,
	DOCLING_PARAMS: {},
	EXTERNAL_DOCUMENT_LOADER_URL: '',
	EXTERNAL_DOCUMENT_LOADER_HEADERS: {},
	MINERU_API_MODE: 'local',
	MINERU_PARAMS: {}
};
const EMBEDDING = {
	RAG_EMBEDDING_ENGINE: '',
	RAG_EMBEDDING_MODEL: 'sentence-transformers/all-MiniLM-L6-v2',
	RAG_EMBEDDING_BATCH_SIZE: 1,
	openai_config: { url: '', key: '' },
	ollama_config: { url: '', key: '' },
	azure_openai_config: { url: '', key: '', version: '' }
};

let rag: Record<string, unknown> = RAG;
let posted: string[] = [];
/** The bodies of the POSTs, by path. */
let bodies: Record<string, unknown> = {};

beforeEach(() => {
	rag = RAG;
	posted = [];
	bodies = {};
	toastError.mockReset();
	useAuthStore.setState({ token: 't' } as never);
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
		const path = String(url);
		if (init?.method === 'POST') {
			posted.push(path.replace(/^.*\/retrieval/, ''));
			bodies[path.replace(/^.*\/retrieval/, '')] = JSON.parse(String(init.body ?? 'null'));
		}
		if (path.endsWith('/retrieval/config')) return new Response(JSON.stringify(rag), { status: 200 });
		if (path.endsWith('/retrieval/embedding')) return new Response(JSON.stringify(EMBEDDING), { status: 200 });
		return new Response(JSON.stringify({}), { status: 200 });
	});
});

afterEach(() => vi.restoreAllMocks());

const saveWith = async (over: Record<string, unknown>) => {
	rag = { ...RAG, ...over };
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<Documents />
		</QueryClientProvider>
	);
	fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
};

describe('Documents save with a JSON box the server refuses (#234)', () => {
	it.each([
		// Typed with the external loader selected, then another engine chosen: the text stays and is saved.
		[
			'headers that are not an object, with another engine selected',
			{ EXTERNAL_DOCUMENT_LOADER_HEADERS: '[1]' },
			'Headers'
		],
		['Docling parameters that are a list', { DOCLING_PARAMS: [] }, 'Docling'],
		['MinerU parameters that are a list', { MINERU_PARAMS: [1] }, 'MinerU']
	])('%s: refused before anything is sent', async (_case, over, field) => {
		await saveWith(over);

		await waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(String(toastError.mock.calls[0][0])).toContain(field);
		expect(posted).toEqual([]);
	});

	it('a valid form applies the embedding, then saves the config', async () => {
		await saveWith({});

		await waitFor(() => expect(posted).toEqual(['/embedding/update', '/config/update']));
		expect(toastError).not.toHaveBeenCalled();
	});
});

describe('Documents: the embedding model is loaded again only when asked (#532)', () => {
	const open = async () => {
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<Documents />
			</QueryClientProvider>
		);
		return screen.findByRole('button', { name: 'Save' });
	};

	it('Save asks the server not to reload an unchanged model', async () => {
		fireEvent.click(await open());

		await waitFor(() => expect(posted).toContain('/embedding/update'));
		expect(bodies['/embedding/update']).toMatchObject({ force_reload: false });
	});

	it('Update embedding model asks for a reload', async () => {
		await open();
		fireEvent.click(screen.getByRole('button', { name: 'Update embedding model' }));

		await waitFor(() => expect(posted).toEqual(['/embedding/update']));
		expect(bodies['/embedding/update']).toMatchObject({ force_reload: true });
	});
});
