type Rec = Record<string, any>;

export const parseList = (text: string | null | undefined): string[] =>
	(text ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

const asJsonText = (value: unknown): unknown => (typeof value === 'object' ? JSON.stringify(value ?? {}, null, 2) : value);

/** The document settings as the form edits them: lists and JSON objects become the text in their boxes. */
export function toRagForm(raw: Rec): Rec {
	const headers = raw.EXTERNAL_DOCUMENT_LOADER_HEADERS;
	return {
		...raw,
		ALLOWED_FILE_EXTENSIONS: (raw.ALLOWED_FILE_EXTENSIONS ?? []).join(', '),
		DOCLING_PARAMS: asJsonText(raw.DOCLING_PARAMS),
		MINERU_PARAMS: asJsonText(raw.MINERU_PARAMS),
		EXTERNAL_DOCUMENT_LOADER_HEADERS: typeof headers === 'object' ? (Object.keys(headers ?? {}).length > 0 ? JSON.stringify(headers, null, 2) : '') : headers,
		MINERU_FILE_EXTENSIONS: (raw.MINERU_FILE_EXTENSIONS ?? ['pdf']).join(', '),
		CONTENT_EXTRACTION_SUPPORTED_MEDIA_MIME_TYPES: raw.CONTENT_EXTRACTION_SUPPORTED_MEDIA_MIME_TYPES?.join(', ') ?? null,
		RAG_TOKENIZER_MODEL: raw.RAG_TOKENIZER_MODEL ?? ''
	};
}

const blank = (v: unknown) => String(v ?? '').trim() === '';
const parsesAsJson = (text: string) => {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
};
const isJsonObjectText = (text: string) => {
	try {
		const v = JSON.parse(text);
		return v !== null && typeof v === 'object' && !Array.isArray(v);
	} catch {
		return false;
	}
};
const objectOrEmpty = (text: unknown) => (typeof text === 'string' && text.trim() !== '' ? JSON.parse(text) : {});

/** What the chosen extraction engine cannot run without, or a malformed JSON box; null when the form is fine. */
export function ragFormError(c: Rec): string | null {
	const engine = c.CONTENT_EXTRACTION_ENGINE;
	if (engine === 'external') {
		if (blank(c.EXTERNAL_DOCUMENT_LOADER_URL)) return 'External Document Loader URL required.';
		if (c.EXTERNAL_DOCUMENT_LOADER_HEADERS && !isJsonObjectText(c.EXTERNAL_DOCUMENT_LOADER_HEADERS)) return 'Headers must be a valid JSON object';
	}
	if (engine === 'tika' && blank(c.TIKA_SERVER_URL)) return 'Tika Server URL required.';
	if (engine === 'docling' && blank(c.DOCLING_SERVER_URL)) return 'Docling Server URL required.';
	if (engine === 'datalab_marker' && !blank(c.DATALAB_MARKER_ADDITIONAL_CONFIG) && !parsesAsJson(c.DATALAB_MARKER_ADDITIONAL_CONFIG)) return 'Invalid JSON format in Additional Config';
	if (engine === 'document_intelligence' && blank(c.DOCUMENT_INTELLIGENCE_ENDPOINT)) return 'Document Intelligence endpoint required.';
	if (engine === 'mistral_ocr' && blank(c.MISTRAL_OCR_API_KEY)) return 'Mistral OCR API Key required.';
	if (engine === 'paddleocr_vl' && blank(c.PADDLEOCR_VL_BASE_URL)) return 'PaddleOCR-vl API URL required.';
	if (engine === 'mineru' && c.MINERU_API_MODE === 'cloud' && blank(c.MINERU_API_KEY)) return 'MinerU API Key required for Cloud API mode.';
	if (c.DOCLING_PARAMS && !parsesAsJson(c.DOCLING_PARAMS)) return 'Invalid JSON format in Docling Parameters';
	if (c.MINERU_PARAMS && !parsesAsJson(c.MINERU_PARAMS)) return 'Invalid JSON format in MinerU Parameters';
	return null;
}

/**
 * The body of `POST /retrieval/config/update`: every key the server sent, the
 * text boxes turned back into lists and objects. Call `ragFormError` first.
 */
export function buildRagPayload(c: Rec): Rec {
	return {
		...c,
		// A cleared number box is null in the form; the backend reads '' as "clear this"
		// and a missing key as "leave it".
		FILE_MAX_SIZE: c.FILE_MAX_SIZE ?? '',
		FILE_MAX_COUNT: c.FILE_MAX_COUNT ?? '',
		FILE_IMAGE_COMPRESSION_WIDTH: c.FILE_IMAGE_COMPRESSION_WIDTH ?? '',
		FILE_IMAGE_COMPRESSION_HEIGHT: c.FILE_IMAGE_COMPRESSION_HEIGHT ?? '',
		ALLOWED_FILE_EXTENSIONS: parseList(c.ALLOWED_FILE_EXTENSIONS),
		DOCLING_PARAMS: objectOrEmpty(c.DOCLING_PARAMS),
		EXTERNAL_DOCUMENT_LOADER_HEADERS: objectOrEmpty(c.EXTERNAL_DOCUMENT_LOADER_HEADERS),
		CONTENT_EXTRACTION_SUPPORTED_MEDIA_MIME_TYPES: c.CONTENT_EXTRACTION_SUPPORTED_MEDIA_MIME_TYPES === null ? undefined : parseList(c.CONTENT_EXTRACTION_SUPPORTED_MEDIA_MIME_TYPES),
		MINERU_PARAMS: objectOrEmpty(c.MINERU_PARAMS),
		MINERU_FILE_EXTENSIONS: parseList(c.MINERU_FILE_EXTENSIONS)
	};
}

export type Credentials = { url: string; key: string };
export type EmbeddingForm = {
	engine: string;
	model: string;
	batchSize: number | null;
	async: boolean;
	concurrent: number | null;
	openai: Credentials;
	ollama: Credentials;
	azure: Credentials & { version: string };
};

export function toEmbeddingForm(res: Rec): EmbeddingForm {
	return {
		engine: res.RAG_EMBEDDING_ENGINE ?? '',
		model: res.RAG_EMBEDDING_MODEL ?? '',
		batchSize: res.RAG_EMBEDDING_BATCH_SIZE ?? 1,
		async: res.ENABLE_ASYNC_EMBEDDING ?? true,
		concurrent: res.RAG_EMBEDDING_CONCURRENT_REQUESTS ?? 0,
		openai: { url: res.openai_config?.url ?? '', key: res.openai_config?.key ?? '' },
		ollama: { url: res.ollama_config?.url ?? '', key: res.ollama_config?.key ?? '' },
		azure: { url: res.azure_openai_config?.url ?? '', key: res.azure_openai_config?.key ?? '', version: res.azure_openai_config?.version ?? '' }
	};
}

/** Why the embedding model cannot be applied, or null. */
export function embeddingError(e: EmbeddingForm): string | null {
	if (e.engine === '' && e.model.split('/').length - 1 > 1) return 'Model filesystem path detected. Model shortname is required for update, cannot continue.';
	if ((e.engine === 'ollama' || e.engine === 'openai') && blank(e.model)) return 'Embedding model is required.';
	if (e.engine === 'azure_openai' && (blank(e.azure.key) || blank(e.azure.url) || blank(e.azure.version))) return 'Azure OpenAI URL, key and version are required.';
	return null;
}

/** The body of `POST /retrieval/embedding/update`: only the chosen engine's connection is sent. */
export function buildEmbeddingPayload(e: EmbeddingForm) {
	const payload: Rec & { RAG_EMBEDDING_ENGINE: string; RAG_EMBEDDING_MODEL: string } = {
		RAG_EMBEDDING_ENGINE: e.engine,
		RAG_EMBEDDING_MODEL: e.model,
		RAG_EMBEDDING_BATCH_SIZE: e.batchSize ?? 1,
		ENABLE_ASYNC_EMBEDDING: e.async,
		RAG_EMBEDDING_CONCURRENT_REQUESTS: e.concurrent ?? 0
	};
	if (e.engine === 'ollama') payload.ollama_config = { key: e.ollama.key, url: e.ollama.url };
	else if (e.engine === 'openai') payload.openai_config = { key: e.openai.key, url: e.openai.url };
	else if (e.engine === 'azure_openai') payload.azure_openai_config = { key: e.azure.key, url: e.azure.url, version: e.azure.version };
	return payload;
}

/** The model to offer when an embedding engine is picked. */
export function embeddingModelFor(engine: string): string | null {
	switch (engine) {
		case '':
			return 'sentence-transformers/all-MiniLM-L6-v2';
		case 'ollama':
			return '';
		case 'openai':
		case 'azure_openai':
			return 'text-embedding-3-small';
		default:
			return null;
	}
}

/** The model to offer when a reranking engine is picked: an external one names its own, the local default is fixed. */
export function rerankingModelFor(engine: string): string | null {
	if (engine === 'external') return '';
	if (engine === '') return 'BAAI/bge-reranker-v2-m3';
	return null;
}

const MINERU_CLOUD = 'https://mineru.net/api/v4';
const MINERU_LOCAL = 'http://localhost:8000';

/** After switching MinerU mode: the other mode's stock URL is swapped out, a URL the admin typed is kept. */
export function mineruUrlForMode(mode: string, url: string | null | undefined): string {
	if (mode === 'cloud') return !url || url === MINERU_LOCAL ? MINERU_CLOUD : url;
	return !url || url === MINERU_CLOUD ? MINERU_LOCAL : url;
}

/** How many context placeholders a RAG template has; more than one injects the context at each. */
export const contextPlaceholders = (template: string | null | undefined): number => ((template ?? '').match(/\[context\]/g) ?? []).length + ((template ?? '').match(/\{\{CONTEXT\}\}/g) ?? []).length;
