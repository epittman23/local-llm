import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
	const save = await screen.findByRole('button', { name: 'Save' });
	// Save waits for a change (FRM-3); one that no assertion looks at.
	fireEvent.change(screen.getByLabelText('Top K'), { target: { value: '7' } });
	fireEvent.click(save);
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
		const save = await open();
		fireEvent.change(screen.getByLabelText('Top K'), { target: { value: '7' } });
		fireEvent.click(save);

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

describe('Documents: the danger zone asks before it acts', () => {
	const openPage = async () => {
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<Documents />
			</QueryClientProvider>
		);
		return screen.findByRole('button', { name: 'Reindex' });
	};

	it('the Reindex button opens a confirmation without sending anything', async () => {
		fireEvent.click(await openPage());

		expect(await screen.findByRole('alertdialog', { name: 'Reindex knowledge and memories?' })).toBeTruthy();
		expect(posted).toEqual([]);
	});

	it('each reset names what it deletes, and its confirming button repeats the action in the danger colour (ACT-3)', async () => {
		await openPage();
		fireEvent.click(screen.getByRole('button', { name: 'Delete all uploads' }));
		const uploads = await screen.findByRole('alertdialog', { name: 'Delete every uploaded file?' });
		expect(uploads).toHaveTextContent('Chats keep their messages but lose their attachments.');
		expect(within(uploads).getByRole('button', { name: 'Delete all uploads' }).dataset.variant).toBe('destructive');
		fireEvent.click(within(uploads).getByRole('button', { name: 'Cancel' }));
		await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

		fireEvent.click(screen.getByRole('button', { name: 'Reset vector storage' }));
		const vectors = await screen.findByRole('alertdialog', { name: 'Delete every knowledge base and its embeddings?' });
		expect(vectors).toHaveTextContent('The uploaded files stay');
		expect(posted).toEqual([]);
	});
});

describe('Documents: switch help and the reindex warning (#1023, FRM-5)', () => {
	const open = async () => {
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<Documents />
			</QueryClientProvider>
		);
		await screen.findByRole('button', { name: 'Save' });
	};

	it('says what turning a switch on does, whichever way it is set', async () => {
		await open();
		const help = /Send each document to the model whole, without splitting it/;
		expect(screen.getByText(help)).toBeInTheDocument();
		expect(screen.getByText(/Send whole documents instead of the pieces/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('switch', { name: /^Bypass Embedding and Retrieval/ }));
		expect(screen.getByText(help)).toBeInTheDocument();
	});

	it('warns to reindex only once the embedding model differs from the stored one', async () => {
		await open();
		const warning = /After saving, reindex/;
		expect(screen.queryByText(warning)).toBeNull();
		expect(screen.queryByText(/Reindex knowledge after changing this/)).toBeNull();
		fireEvent.change(screen.getByLabelText('Embedding Model'), { target: { value: 'another/model' } });
		expect(screen.getByText(warning)).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText('Embedding Model'), {
			target: { value: 'sentence-transformers/all-MiniLM-L6-v2' }
		});
		expect(screen.queryByText(warning)).toBeNull();
	});
});

describe('Documents: what is wrong is said under its field (FRM-2)', () => {
	it('an extraction engine that needs a URL: under the URL, focused, and nothing sent until it is given', async () => {
		await saveWith({ CONTENT_EXTRACTION_ENGINE: 'tika', TIKA_SERVER_URL: '' });

		const url = screen.getByLabelText('Tika Server URL');
		expect(url).toHaveAttribute('aria-invalid', 'true');
		expect(url).toHaveAccessibleDescription('Tika Server URL required.');
		await waitFor(() => expect(url).toHaveFocus());
		expect(toastError).not.toHaveBeenCalled();
		expect(posted).toEqual([]);

		fireEvent.change(url, { target: { value: 'http://tika:9998' } });
		expect(url).not.toHaveAttribute('aria-invalid');
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(posted).toEqual(['/embedding/update', '/config/update']));
		expect(bodies['/config/update']).toMatchObject({ TIKA_SERVER_URL: 'http://tika:9998' });
	});

	it("the chosen engine's JSON box: under the box, in place of its help", async () => {
		await saveWith({ CONTENT_EXTRACTION_ENGINE: 'docling', DOCLING_SERVER_URL: 'http://docling', DOCLING_PARAMS: [] });

		const params = screen.getByLabelText('Parameters');
		expect(params).toHaveAttribute('aria-invalid', 'true');
		expect(params).toHaveAccessibleDescription('Docling Parameters must be a JSON object');
		await waitFor(() => expect(params).toHaveFocus());
		expect(toastError).not.toHaveBeenCalled();
		expect(posted).toEqual([]);
	});

	it('Update embedding model checks only the embedding: a missing model is said under it', async () => {
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<Documents />
			</QueryClientProvider>
		);
		const model = await screen.findByLabelText('Embedding Model');
		fireEvent.change(model, { target: { value: '' } });
		fireEvent.click(screen.getByRole('button', { name: 'Update embedding model' }));

		expect(model).toHaveAttribute('aria-invalid', 'true');
		expect(model).toHaveAccessibleDescription('Embedding model is required.');
		await waitFor(() => expect(model).toHaveFocus());
		expect(posted).toEqual([]);

		fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
		expect(screen.getByLabelText('Embedding Model')).not.toHaveAttribute('aria-invalid');
	});
});
