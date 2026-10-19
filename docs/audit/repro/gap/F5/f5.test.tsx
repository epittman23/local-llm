import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../../../../../apps/web/node_modules/@testing-library/react';
import { QueryProvider } from '@/lib/query/QueryProvider';
import { TooltipProvider } from '@/components/ui/tooltip';

const toastCalls: string[] = [];
vi.mock('../../../../../apps/web/node_modules/sonner/dist/index.mjs', () => ({
	toast: Object.assign((m: string) => toastCalls.push(`plain:${m}`), {
		success: (m: string) => { console.log('toast.success', m); toastCalls.push(`success:${m}`); },
		error: (m: string) => toastCalls.push(`error:${m}`)
	})
}));
vi.mock('@/lib/apis/openai', () => ({
	getOpenAIConfig: vi.fn(async () => ({
		ENABLE_OPENAI_API: true,
		OPENAI_API_BASE_URLS: ['https://openrouter.ai/api/v1'],
		OPENAI_API_KEYS: ['k'],
		OPENAI_API_CONFIGS: { '0': {} }
	})),
	getOpenAIModels: vi.fn(async () => ({})),
	updateOpenAIConfig: vi.fn(async () => {
		console.log('updateOpenAIConfig called');
		throw 'upstream refused';
	})
}));
vi.mock('@/lib/apis/ollama', () => ({
	getOllamaConfig: vi.fn(async () => ({ ENABLE_OLLAMA_API: false, OLLAMA_BASE_URLS: [], OLLAMA_API_CONFIGS: {} })),
	updateOllamaConfig: vi.fn(async () => {
		throw 'ollama refused';
	})
}));
vi.mock('@/lib/apis/configs', () => ({
	getConnectionsConfig: vi.fn(async () => ({ ENABLE_DIRECT_CONNECTIONS: false, ENABLE_BASE_MODELS_CACHE: false })),
	setConnectionsConfig: vi.fn(async () => null)
}));
vi.mock('@/lib/apis', async (orig) => ({
	...(await orig<any>()),
	getBackendConfig: vi.fn(async () => null),
	getModels: vi.fn(async () => [])
}));

import { buildRagPayload, ragFormError, toRagForm } from '@/routes/admin/settings/documents';
import { prepareImagesConfig, toFormState } from '@/routes/admin/settings/images';
import { updateRAGConfig } from '@/lib/apis/retrieval';
import Connections from '@/routes/admin/settings/Connections';

describe('F5 repros', () => {
	beforeEach(() => {
		toastCalls.length = 0;
	});

	it('BM25 "Default" sends null, which the backend reads as "leave unchanged"', () => {
		const form = toRagForm({ HYBRID_BM25_WEIGHT: 0.8, ALLOWED_FILE_EXTENSIONS: [] });
		const payload = buildRagPayload({ ...form, HYBRID_BM25_WEIGHT: null });
		console.log('payload HYBRID_BM25_WEIGHT =', payload.HYBRID_BM25_WEIGHT);
		expect(payload.HYBRID_BM25_WEIGHT).toBeNull();
	});

	it('JSON boxes: hidden invalid headers pass validation then throw; non-object params pass validation', () => {
		const form = {
			...toRagForm({ ALLOWED_FILE_EXTENSIONS: [], EXTERNAL_DOCUMENT_LOADER_HEADERS: {} }),
			CONTENT_EXTRACTION_ENGINE: 'tika',
			TIKA_SERVER_URL: 'http://tika:9998',
			EXTERNAL_DOCUMENT_LOADER_HEADERS: '{not json'
		};
		console.log('ragFormError(hidden bad headers) =', ragFormError(form));
		let thrown: unknown = null;
		try {
			buildRagPayload(form);
		} catch (e) {
			thrown = e;
		}
		console.log('buildRagPayload threw:', String(thrown));
		const docling = { ...form, EXTERNAL_DOCUMENT_LOADER_HEADERS: '', DOCLING_PARAMS: '[]' };
		console.log('ragFormError(DOCLING_PARAMS "[]") =', ragFormError(docling));
		console.log('payload DOCLING_PARAMS =', JSON.stringify(buildRagPayload(docling).DOCLING_PARAMS));
	});

	it('Images: a cleared Steps box is sent as an empty string', () => {
		const { config, nodes, editNodes } = toFormState({
			ENABLE_IMAGE_GENERATION: false,
			IMAGE_GENERATION_ENGINE: 'openai',
			IMAGE_STEPS: 50,
			COMFYUI_WORKFLOW: '',
			IMAGES_EDIT_COMFYUI_WORKFLOW: '',
			AUTOMATIC1111_PARAMS: {},
			IMAGES_OPENAI_API_PARAMS: {}
		});
		const prepared = prepareImagesConfig({ ...config, IMAGE_STEPS: '' }, nodes, editNodes);
		console.log('prepared ok =', prepared.ok, 'IMAGE_STEPS =', JSON.stringify(prepared.ok && prepared.payload.IMAGE_STEPS));
	});

	it('updateRAGConfig resolves null (no throw) when the request never reaches the server', async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		}) as any;
		try {
			const res = await updateRAGConfig('t', {} as any);
			console.log('updateRAGConfig on network failure resolved to', res);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it('Connections Save reports success after both saves failed', async () => {
		render(
			<QueryProvider>
				<TooltipProvider>
					<Connections />
				</TooltipProvider>
			</QueryProvider>
		);
		const save = await screen.findByRole('button', { name: /save/i });
		fireEvent.submit(save.closest('form')!);
		await waitFor(() => expect(toastCalls.some((t) => t.startsWith('success:Settings saved'))).toBe(true), { onTimeout: (e) => { console.log('toasts at timeout', JSON.stringify(toastCalls)); return e; } });
		console.log('toasts:', JSON.stringify(toastCalls));
	});
});
