import { describe, expect, it } from 'vitest';
import {
	blankSourceForm,
	canSave,
	canTest,
	connectionForItem,
	connectionPayload,
	formFromItem,
	schemaDefaults,
	sourcePayload,
	togglePayload
} from './externalKnowledge';

const conn = { id: 'c1', name: 'Q', provider: 'qdrant', endpoint: 'https://q', config: { timeout: 10 }, enabled: true };
const ready = { ...blankSourceForm(), name: 'KB', endpoint: 'https://q', sourceName: 'docs', testQuery: 'hi' };

describe('schemaDefaults', () => {
	it('knows where each provider keeps its fields', () => {
		expect(schemaDefaults('qdrant')).toMatchObject({
			contentField: 'payload.text',
			vectorField: '',
			metadataField: 'payload.metadata'
		});
		expect(schemaDefaults('milvus')).toMatchObject({
			contentField: 'data.text',
			vectorField: 'vector',
			metadataField: 'metadata'
		});
		expect(schemaDefaults('pgvector')).toMatchObject({
			contentField: 'text',
			vectorField: 'vector',
			metadataField: 'vmetadata',
			tableName: 'document_chunk'
		});
	});
});

describe('formFromItem', () => {
	it('reads the item and its connection, never the key, filling unset fields from the provider defaults', () => {
		const item = {
			id: 'k',
			name: 'KB',
			meta: { external: { connection_id: 'c1', source: { name: 'docs', config: { vector_field: 'v' } } } }
		};
		expect(connectionForItem([conn], item)).toBe(conn);
		expect(formFromItem(item, { ...conn, provider: 'milvus', config: { timeout: 10, db_name: 'db' } })).toMatchObject({
			name: 'KB',
			provider: 'milvus',
			apiKey: '',
			timeout: 10,
			dbName: 'db',
			sourceName: 'docs',
			vectorField: 'v',
			contentField: 'data.text'
		});
	});
});

describe('connectionPayload', () => {
	it('bearer when a key is typed; {} when creating without one; null ("unchanged") when editing without one', () => {
		expect(connectionPayload({ ...ready, apiKey: 'k' }, null).auth_config).toEqual({ type: 'bearer', api_key: 'k' });
		expect(connectionPayload(ready, null).auth_config).toEqual({});
		expect(connectionPayload(ready, conn).auth_config).toBeNull();
	});
	it('pgvector never sends auth; Milvus sends its database; the name falls back to the collection', () => {
		expect(connectionPayload({ ...ready, provider: 'pgvector', apiKey: 'k' }, conn).auth_config).toEqual({});
		expect(connectionPayload({ ...ready, provider: 'milvus', dbName: 'db' }, null).config).toEqual({
			timeout: 30,
			db_name: 'db'
		});
		expect(connectionPayload({ ...ready, name: ' ' }, null).name).toBe('docs');
	});
	it('keeps a disabled connection disabled', () => {
		expect(connectionPayload(ready, { ...conn, enabled: false }).enabled).toBe(false);
	});
});

describe('sourcePayload', () => {
	it('trims, leaves blanks out, and adds table fields only for pgvector', () => {
		expect(sourcePayload({ ...ready, contentField: ' payload.text ', metadataField: '' })).toEqual({
			type: 'collection',
			name: 'docs',
			config: { content_field: 'payload.text', document_id_field: 'id' }
		});
		expect(sourcePayload({ ...ready, provider: 'pgvector', ...schemaDefaults('pgvector') }).config).toMatchObject({
			table_name: 'document_chunk',
			collection_field: 'collection_name',
			vector_field: 'vector'
		});
	});
});

describe('canTest / canSave', () => {
	it('Qdrant can test without a vector field; the others cannot', () => {
		expect(canTest(ready)).toBe(true);
		expect(canTest({ ...ready, provider: 'milvus', vectorField: '' })).toBe(false);
	});
	it('needs the query, and pgvector its table fields; saving also needs a name', () => {
		expect(canTest({ ...ready, testQuery: ' ' })).toBe(false);
		expect(canTest({ ...ready, provider: 'pgvector', vectorField: 'v', tableName: '' })).toBe(false);
		expect(canSave({ ...ready, name: '' })).toBe(false);
		expect(canSave(ready)).toBe(true);
	});
});

describe('togglePayload', () => {
	it('flips the flag, leaves auth alone, and turns a flagless connection off', () => {
		expect(togglePayload(conn)).toMatchObject({ enabled: false, auth_config: null, capabilities: { retrieve: true } });
		expect(togglePayload({ ...conn, enabled: false }).enabled).toBe(true);
		expect(togglePayload({ ...conn, enabled: undefined }).enabled).toBe(false);
	});
});
