import { describe, expect, it } from 'vitest';
import {
	buildEmbeddingPayload,
	buildRagPayload,
	chunkSettingsError,
	contextPlaceholders,
	embeddingError,
	embeddingModelFor,
	mineruUrlForMode,
	parseList,
	ragFormError,
	ragSaveOutcome,
	reindexProblem,
	rerankingModelFor,
	toEmbeddingForm,
	toRagForm
} from './documents';

describe('parseList', () => {
	it('splits on commas, trims and drops blanks', () => {
		expect(parseList(' pdf, docx ,, txt,')).toEqual(['pdf', 'docx', 'txt']);
		expect(parseList('')).toEqual([]);
		expect(parseList(null)).toEqual([]);
	});
});

describe('toRagForm', () => {
	const raw = {
		ALLOWED_FILE_EXTENSIONS: ['pdf', 'txt'],
		DOCLING_PARAMS: { a: 1 },
		MINERU_PARAMS: {},
		EXTERNAL_DOCUMENT_LOADER_HEADERS: { X: 'y' },
		MINERU_FILE_EXTENSIONS: undefined,
		CONTENT_EXTRACTION_SUPPORTED_MEDIA_MIME_TYPES: ['image/*', 'video/*'],
		KEEP: 1
	};
	it('turns lists and objects into the text of their boxes and keeps every other key', () => {
		const f = toRagForm(raw);
		expect(f.ALLOWED_FILE_EXTENSIONS).toBe('pdf, txt');
		expect(f.DOCLING_PARAMS).toBe('{\n  "a": 1\n}');
		expect(f.MINERU_PARAMS).toBe('{}');
		expect(f.EXTERNAL_DOCUMENT_LOADER_HEADERS).toBe('{\n  "X": "y"\n}');
		expect(f.MINERU_FILE_EXTENSIONS).toBe('pdf');
		expect(f.CONTENT_EXTRACTION_SUPPORTED_MEDIA_MIME_TYPES).toBe('image/*, video/*');
		expect(f.RAG_TOKENIZER_MODEL).toBe('');
		expect(f.KEEP).toBe(1);
	});
	it('shows no headers as an empty box and an unset MIME list as null', () => {
		const f = toRagForm({
			EXTERNAL_DOCUMENT_LOADER_HEADERS: {},
			CONTENT_EXTRACTION_SUPPORTED_MEDIA_MIME_TYPES: undefined
		});
		expect(f.EXTERNAL_DOCUMENT_LOADER_HEADERS).toBe('');
		expect(f.CONTENT_EXTRACTION_SUPPORTED_MEDIA_MIME_TYPES).toBeNull();
	});
});

describe('ragFormError', () => {
	it('is fine for the default engine', () => {
		expect(ragFormError({ CONTENT_EXTRACTION_ENGINE: '' })).toBeNull();
	});
	it('names the setting each engine needs', () => {
		const cases: [Record<string, any>, string][] = [
			[
				{ CONTENT_EXTRACTION_ENGINE: 'external', EXTERNAL_DOCUMENT_LOADER_URL: '' },
				'External Document Loader URL required.'
			],
			[{ CONTENT_EXTRACTION_ENGINE: 'tika', TIKA_SERVER_URL: '' }, 'Tika Server URL required.'],
			[{ CONTENT_EXTRACTION_ENGINE: 'docling', DOCLING_SERVER_URL: ' ' }, 'Docling Server URL required.'],
			[
				{ CONTENT_EXTRACTION_ENGINE: 'document_intelligence', DOCUMENT_INTELLIGENCE_ENDPOINT: '' },
				'Document Intelligence endpoint required.'
			],
			[{ CONTENT_EXTRACTION_ENGINE: 'mistral_ocr', MISTRAL_OCR_API_KEY: '' }, 'Mistral OCR API Key required.'],
			[{ CONTENT_EXTRACTION_ENGINE: 'paddleocr_vl', PADDLEOCR_VL_BASE_URL: '' }, 'PaddleOCR-vl API URL required.'],
			[
				{ CONTENT_EXTRACTION_ENGINE: 'mineru', MINERU_API_MODE: 'cloud', MINERU_API_KEY: '' },
				'MinerU API Key required for Cloud API mode.'
			]
		];
		for (const [cfg, message] of cases) expect(ragFormError(cfg)).toBe(message);
	});
	it('MinerU local mode needs no key', () => {
		expect(
			ragFormError({ CONTENT_EXTRACTION_ENGINE: 'mineru', MINERU_API_MODE: 'local', MINERU_API_KEY: '' })
		).toBeNull();
	});
	it('rejects headers that are not a JSON object, and bad JSON in the other boxes', () => {
		const external = { CONTENT_EXTRACTION_ENGINE: 'external', EXTERNAL_DOCUMENT_LOADER_URL: 'http://x' };
		expect(ragFormError({ ...external, EXTERNAL_DOCUMENT_LOADER_HEADERS: '["a"]' })).toBe(
			'Headers must be a valid JSON object'
		);
		expect(ragFormError({ ...external, EXTERNAL_DOCUMENT_LOADER_HEADERS: '{"a":"b"}' })).toBeNull();
		expect(ragFormError({ CONTENT_EXTRACTION_ENGINE: 'datalab_marker', DATALAB_MARKER_ADDITIONAL_CONFIG: '{x' })).toBe(
			'Invalid JSON format in Additional Config'
		);
		expect(ragFormError({ CONTENT_EXTRACTION_ENGINE: '', DOCLING_PARAMS: '{x' })).toBe(
			'Invalid JSON format in Docling Parameters'
		);
		expect(ragFormError({ CONTENT_EXTRACTION_ENGINE: '', MINERU_PARAMS: '{x' })).toBe(
			'Invalid JSON format in MinerU Parameters'
		);
	});
});

describe('buildRagPayload', () => {
	const form = toRagForm({
		ALLOWED_FILE_EXTENSIONS: [],
		FILE_MAX_SIZE: null,
		DOCLING_PARAMS: {},
		TOP_K: 4,
		SOMETHING_ELSE: 'kept'
	});
	it('sends a cleared number as "" so the backend clears it, and lists and objects in their real shape', () => {
		const p = buildRagPayload({
			...form,
			FILE_MAX_SIZE: null,
			FILE_MAX_COUNT: 5,
			ALLOWED_FILE_EXTENSIONS: 'pdf, docx',
			DOCLING_PARAMS: '{"a":1}',
			MINERU_FILE_EXTENSIONS: 'pdf'
		});
		expect(p).toMatchObject({
			FILE_MAX_SIZE: '',
			FILE_MAX_COUNT: 5,
			FILE_IMAGE_COMPRESSION_WIDTH: '',
			ALLOWED_FILE_EXTENSIONS: ['pdf', 'docx'],
			DOCLING_PARAMS: { a: 1 },
			EXTERNAL_DOCUMENT_LOADER_HEADERS: {},
			MINERU_FILE_EXTENSIONS: ['pdf'],
			TOP_K: 4,
			SOMETHING_ELSE: 'kept'
		});
	});
	it('leaves the media types out when they were never set, and sends an emptied box as []', () => {
		expect(
			buildRagPayload({ ...form, CONTENT_EXTRACTION_SUPPORTED_MEDIA_MIME_TYPES: null })
				.CONTENT_EXTRACTION_SUPPORTED_MEDIA_MIME_TYPES
		).toBeUndefined();
		expect(
			buildRagPayload({ ...form, CONTENT_EXTRACTION_SUPPORTED_MEDIA_MIME_TYPES: '' })
				.CONTENT_EXTRACTION_SUPPORTED_MEDIA_MIME_TYPES
		).toEqual([]);
		expect(
			buildRagPayload({ ...form, CONTENT_EXTRACTION_SUPPORTED_MEDIA_MIME_TYPES: 'image/*, video/*' })
				.CONTENT_EXTRACTION_SUPPORTED_MEDIA_MIME_TYPES
		).toEqual(['image/*', 'video/*']);
	});
});

describe('embedding', () => {
	const e = toEmbeddingForm({
		RAG_EMBEDDING_ENGINE: 'openai',
		RAG_EMBEDDING_MODEL: 'text-embedding-3-small',
		openai_config: { url: 'https://api.openai.com/v1', key: 'k' },
		ollama_config: { url: null, key: null },
		azure_openai_config: {}
	});
	it('reads defaults for what the server leaves out', () => {
		expect(e.batchSize).toBe(1);
		expect(e.async).toBe(true);
		expect(e.concurrent).toBe(0);
		expect(e.ollama).toEqual({ url: '', key: '' });
		expect(e.azure).toEqual({ url: '', key: '', version: '' });
	});
	it("sends only the chosen engine's connection", () => {
		expect(buildEmbeddingPayload(e)).toEqual({
			RAG_EMBEDDING_ENGINE: 'openai',
			RAG_EMBEDDING_MODEL: 'text-embedding-3-small',
			RAG_EMBEDDING_BATCH_SIZE: 1,
			ENABLE_ASYNC_EMBEDDING: true,
			RAG_EMBEDDING_CONCURRENT_REQUESTS: 0,
			openai_config: { key: 'k', url: 'https://api.openai.com/v1' }
		});
		const local = buildEmbeddingPayload({ ...e, engine: '', model: 'sentence-transformers/all-MiniLM-L6-v2' });
		expect(local).not.toHaveProperty('openai_config');
		expect(local).not.toHaveProperty('ollama_config');
	});
	it('a cleared batch size or concurrency is sent as the default', () => {
		const p = buildEmbeddingPayload({ ...e, batchSize: null, concurrent: null });
		expect(p.RAG_EMBEDDING_BATCH_SIZE).toBe(1);
		expect(p.RAG_EMBEDDING_CONCURRENT_REQUESTS).toBe(0);
	});
	it('refuses a filesystem path for the local model, a missing hosted model, or a half-filled Azure connection', () => {
		expect(embeddingError({ ...e, engine: '', model: '/models/all-MiniLM' })).toMatch(/filesystem path/);
		expect(embeddingError({ ...e, engine: '', model: 'sentence-transformers/all-MiniLM-L6-v2' })).toBeNull();
		expect(embeddingError({ ...e, engine: 'ollama', model: '' })).toBe('Embedding model is required.');
		expect(embeddingError({ ...e, engine: 'openai', model: '' })).toBe('Embedding model is required.');
		expect(embeddingError({ ...e, engine: 'azure_openai', azure: { url: 'u', key: 'k', version: '' } })).toMatch(
			/Azure/
		);
		expect(embeddingError({ ...e, engine: 'azure_openai', azure: { url: 'u', key: 'k', version: 'v' } })).toBeNull();
	});
	it('offers a model per engine', () => {
		expect(embeddingModelFor('')).toBe('sentence-transformers/all-MiniLM-L6-v2');
		expect(embeddingModelFor('ollama')).toBe('');
		expect(embeddingModelFor('openai')).toBe('text-embedding-3-small');
		expect(embeddingModelFor('azure_openai')).toBe('text-embedding-3-small');
		expect(embeddingModelFor('other')).toBeNull();
	});
});

describe('rerankingModelFor', () => {
	it('clears the model for an external engine and restores the local default', () => {
		expect(rerankingModelFor('external')).toBe('');
		expect(rerankingModelFor('')).toBe('BAAI/bge-reranker-v2-m3');
		expect(rerankingModelFor('x')).toBeNull();
	});
});

describe('mineruUrlForMode', () => {
	it('swaps the stock URL of the other mode and keeps one the admin typed', () => {
		expect(mineruUrlForMode('cloud', 'http://localhost:8000')).toBe('https://mineru.net/api/v4');
		expect(mineruUrlForMode('cloud', '')).toBe('https://mineru.net/api/v4');
		expect(mineruUrlForMode('cloud', 'https://mine.example')).toBe('https://mine.example');
		expect(mineruUrlForMode('local', 'https://mineru.net/api/v4')).toBe('http://localhost:8000');
		expect(mineruUrlForMode('local', null)).toBe('http://localhost:8000');
		expect(mineruUrlForMode('local', 'http://gpu:9000')).toBe('http://gpu:9000');
	});
});

describe('contextPlaceholders', () => {
	it('counts both placeholder spellings', () => {
		expect(contextPlaceholders('')).toBe(0);
		expect(contextPlaceholders('Use [context] to answer')).toBe(1);
		expect(contextPlaceholders('[context] and {{CONTEXT}}')).toBe(2);
		expect(contextPlaceholders(null)).toBe(0);
	});
});

describe('chunkSettingsError', () => {
	it('refuses what the text splitters cannot use (#235)', () => {
		expect(chunkSettingsError(0, 0)).toBe('Chunk Size must be at least 1.');
		expect(chunkSettingsError(1.5, 0)).toBe('Chunk Size must be at least 1.');
		expect(chunkSettingsError(100, -1)).toBe('Chunk Overlap cannot be negative.');
		expect(chunkSettingsError(100, 200)).toBe(
			'Chunk Overlap must be smaller than Chunk Size (200 is not smaller than 100).'
		);
		expect(chunkSettingsError(100, 100)).toBe(
			'Chunk Overlap must be smaller than Chunk Size (100 is not smaller than 100).'
		);
	});

	it('accepts working settings, and leaves a cleared box to the server', () => {
		expect(chunkSettingsError(1000, 100)).toBeNull();
		expect(chunkSettingsError(1, 0)).toBeNull();
		expect(chunkSettingsError(null, 100)).toBeNull();
		expect(chunkSettingsError(1000, null)).toBeNull();
	});

	it('is part of the form check, so the embedding model is not applied first', () => {
		expect(ragFormError({ CHUNK_SIZE: 100, CHUNK_OVERLAP: 200 })).toBe(
			'Chunk Overlap must be smaller than Chunk Size (200 is not smaller than 100).'
		);
	});
});

describe('ragSaveOutcome', () => {
	it('passes on the warnings and takes over hybrid search when the server turned it off', () => {
		const res = {
			status: true,
			warnings: ['Hybrid search was turned off: the reranking model could not be loaded. CrossEncoder error'],
			ENABLE_RAG_HYBRID_SEARCH: false
		};
		expect(ragSaveOutcome({ ENABLE_RAG_HYBRID_SEARCH: true }, res)).toEqual({
			warnings: ['Hybrid search was turned off: the reranking model could not be loaded. CrossEncoder error'],
			changes: { ENABLE_RAG_HYBRID_SEARCH: false }
		});
	});

	it('changes nothing when the server stored what was sent', () => {
		const res = { status: true, warnings: [], ENABLE_RAG_HYBRID_SEARCH: true };
		expect(ragSaveOutcome({ ENABLE_RAG_HYBRID_SEARCH: true }, res)).toEqual({ warnings: [], changes: {} });
	});

	it('copes with a response that has no warnings or flag (an older server)', () => {
		expect(ragSaveOutcome({ ENABLE_RAG_HYBRID_SEARCH: true }, { status: true })).toEqual({ warnings: [], changes: {} });
		expect(ragSaveOutcome({ ENABLE_RAG_HYBRID_SEARCH: true }, null)).toEqual({ warnings: [], changes: {} });
	});
});

describe('reindexProblem', () => {
	it('says how many files failed and names the first few (#308)', () => {
		const failed = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf'].map((filename, i) => ({ file_id: `f${i}`, filename }));
		expect(reindexProblem({ status: false, total: 10, reindexed: 6, failed })).toBe(
			'4 of 10 files could not be embedded again (a.pdf, b.pdf, c.pdf, and 1 more); the backend log has the errors.'
		);
	});

	it('is null when everything was embedded, or for an older server that answered true', () => {
		expect(reindexProblem({ status: true, total: 3, reindexed: 3, failed: [] })).toBeNull();
		expect(reindexProblem(true)).toBeNull();
		expect(reindexProblem(null)).toBeNull();
	});
});
