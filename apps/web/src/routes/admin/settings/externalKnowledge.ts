import type { AccessGrant } from '@/lib/access/accessGrants';

// The rules behind admin/Settings/ExternalKnowledge.svelte. An external
// knowledge source is a knowledge base whose chunks live in someone else's
// vector store (Qdrant, Milvus or pgvector): a *connection* (endpoint, auth,
// timeout) plus a *source* (the collection, and which fields hold the text,
// vector, metadata and document id). The backend refuses to create one that has
// not answered a test query, and so does the form.

export type Provider = 'qdrant' | 'milvus' | 'pgvector';

export type ExternalConnection = {
	id: string;
	name: string;
	provider: string;
	endpoint: string;
	config?: Record<string, any>;
	capabilities?: Record<string, any>;
	enabled?: boolean;
	auth_configured?: boolean;
};

export type ExternalKnowledgeItem = {
	id: string;
	name: string;
	description?: string;
	access_grants?: AccessGrant[];
	meta?: {
		external?: { connection_id?: string; provider?: string; source?: { name?: string; config?: Record<string, any> } };
	};
};

export type SchemaFields = {
	contentField: string;
	vectorField: string;
	metadataField: string;
	documentIdField: string;
	tableName: string;
	collectionField: string;
};

export type SourceForm = SchemaFields & {
	name: string;
	description: string;
	provider: Provider;
	endpoint: string;
	apiKey: string;
	timeout: number;
	dbName: string;
	sourceName: string;
	testQuery: string;
};

/** Where each provider keeps the text, vector and metadata by default. */
export function schemaDefaults(provider: string): SchemaFields {
	const shared = { documentIdField: 'id', tableName: 'document_chunk', collectionField: 'collection_name' };
	if (provider === 'milvus')
		return { ...shared, contentField: 'data.text', vectorField: 'vector', metadataField: 'metadata' };
	if (provider === 'pgvector')
		return { ...shared, contentField: 'text', vectorField: 'vector', metadataField: 'vmetadata' };
	return { ...shared, contentField: 'payload.text', vectorField: '', metadataField: 'payload.metadata' };
}

export const blankSourceForm = (): SourceForm => ({
	name: '',
	description: '',
	provider: 'qdrant',
	endpoint: '',
	apiKey: '',
	timeout: 30,
	dbName: '',
	sourceName: '',
	testQuery: '',
	...schemaDefaults('qdrant')
});

export const endpointPlaceholder = (provider: string) =>
	provider === 'pgvector'
		? 'postgresql://user:password@host:5432/db'
		: provider === 'milvus'
			? 'http://milvus.example.com:19530'
			: 'https://qdrant.example.com';

const asProvider = (p: string | undefined): Provider => (p === 'milvus' || p === 'pgvector' ? p : 'qdrant');

export const connectionForItem = (connections: ExternalConnection[], item: ExternalKnowledgeItem) =>
	connections.find((c) => c.id === item.meta?.external?.connection_id);

/**
 * The form for editing an existing source. The API key is never sent back by
 * the server, so it starts blank, and a blank key on save means "keep it".
 */
export function formFromItem(item: ExternalKnowledgeItem, connection: ExternalConnection): SourceForm {
	const source = item.meta?.external?.source;
	const sc = source?.config ?? {};
	const d = schemaDefaults(connection.provider);
	return {
		name: item.name ?? '',
		description: item.description ?? '',
		provider: asProvider(connection.provider),
		endpoint: connection.endpoint ?? '',
		apiKey: '',
		timeout: connection.config?.timeout ?? 30,
		dbName: connection.config?.db_name ?? '',
		sourceName: source?.name ?? '',
		testQuery: '',
		contentField: sc.content_field ?? d.contentField,
		vectorField: sc.vector_field ?? d.vectorField,
		metadataField: sc.metadata_field ?? d.metadataField,
		documentIdField: sc.document_id_field ?? d.documentIdField,
		tableName: sc.table_name ?? d.tableName,
		collectionField: sc.collection_field ?? d.collectionField
	};
}

/**
 * The connection half of a test/create/update body. `auth_config`: pgvector
 * carries its credentials in the endpoint, so `{}`; a typed key becomes a bearer
 * config; no key is `null` ("unchanged") when editing and `{}` when creating.
 */
export function connectionPayload(f: SourceForm, editing: ExternalConnection | null) {
	return {
		name: f.name.trim() || f.sourceName.trim() || 'External Knowledge Source',
		provider: f.provider,
		endpoint: f.endpoint,
		auth_config:
			f.provider === 'pgvector' ? {} : f.apiKey ? { type: 'bearer', api_key: f.apiKey } : editing ? null : {},
		config: { timeout: Number(f.timeout) || 30, ...(f.provider === 'milvus' && f.dbName ? { db_name: f.dbName } : {}) },
		capabilities: { retrieve: true },
		enabled: editing?.enabled !== false
	};
}

/** The source half: the collection and its field mapping, blanks left out (table fields are pgvector's only). */
export function sourcePayload(f: SourceForm) {
	const config: Record<string, string> = { content_field: f.contentField.trim() };
	if (f.vectorField.trim()) config.vector_field = f.vectorField.trim();
	if (f.metadataField.trim()) config.metadata_field = f.metadataField.trim();
	if (f.documentIdField.trim()) config.document_id_field = f.documentIdField.trim();
	if (f.provider === 'pgvector') {
		config.table_name = f.tableName.trim();
		config.collection_field = f.collectionField.trim();
	}
	return { type: 'collection', name: f.sourceName.trim(), config };
}

/** Enough to run a test query: endpoint, collection, content field, a vector field (Qdrant can use its default), pgvector's table fields, and the query. */
export const canTest = (f: SourceForm) =>
	Boolean(f.endpoint.trim() && f.sourceName.trim() && f.contentField.trim() && f.testQuery.trim()) &&
	(f.provider === 'qdrant' || Boolean(f.vectorField.trim())) &&
	(f.provider !== 'pgvector' || Boolean(f.tableName.trim() && f.collectionField.trim()));

export const canSave = (f: SourceForm) => Boolean(f.name.trim()) && canTest(f);

/**
 * The body that flips a connection on or off. `auth_config: null` leaves the
 * stored credentials alone. A connection with no `enabled` flag counts as on,
 * so it turns *off* -- the Svelte version sent `!connection.enabled`, which is
 * `true` for a missing flag, so such a switch could never be turned off.
 */
export const togglePayload = (c: ExternalConnection) => ({
	name: c.name,
	provider: c.provider,
	endpoint: c.endpoint,
	auth_config: null,
	config: c.config ?? {},
	capabilities: c.capabilities ?? { retrieve: true },
	enabled: c.enabled === false
});
