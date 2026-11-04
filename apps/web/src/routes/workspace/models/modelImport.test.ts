import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNewModel, getModelById, updateModelById } from '@/lib/apis/models';
import { importPayload, importUpdate, parseModelImport, sanitizeIncomingModel, saveImportedModel } from './modelImport';

vi.mock('@/lib/apis/models', () => ({
	createNewModel: vi.fn(async () => ({})),
	getModelById: vi.fn(),
	updateModelById: vi.fn(async () => ({}))
}));

const grants = [{ principal_type: 'user', principal_id: '*', permission: 'write' }];

describe('sanitizeIncomingModel', () => {
	it("unwraps the community site's {info} wrapper and needs an id and a name", () => {
		expect(sanitizeIncomingModel({ info: { id: 'm', name: 'M' } }, { withGrants: false })).toMatchObject({
			id: 'm',
			name: 'M',
			meta: {},
			params: {}
		});
		expect(sanitizeIncomingModel({ id: 'm' }, { withGrants: false })).toBeNull();
		expect(sanitizeIncomingModel('x', { withGrants: false })).toBeNull();
		expect(sanitizeIncomingModel([1], { withGrants: false })).toBeNull();
	});
	it("only keeps a clone's well-formed grants; nothing from outside ever brings any", () => {
		const raw = { id: 'm', name: 'M', access_grants: [...grants, { principal_type: 'user' }] };
		expect(sanitizeIncomingModel(raw, { withGrants: false })?.access_grants).toEqual([]);
		expect(sanitizeIncomingModel(raw, { withGrants: true })?.access_grants).toHaveLength(1);
	});
	it('drops unknown top-level fields and deep-copies meta and params', () => {
		const meta = { tags: [{ name: 'x' }] };
		const out = sanitizeIncomingModel(
			{ id: 'm', name: 'M', user_id: 'attacker', is_active: false, meta },
			{ withGrants: false }
		);
		expect(out).not.toHaveProperty('user_id');
		expect(out).not.toHaveProperty('is_active');
		out!.meta.tags.push({ name: 'y' });
		expect(meta.tags).toHaveLength(1);
	});
});

describe('parseModelImport', () => {
	it('requires an array, accepts both shapes, skips unusable entries and drops grants', () => {
		const out = parseModelImport(
			JSON.stringify([
				{ id: 'a', name: 'A', access_grants: grants },
				{ info: { id: 'b', name: 'B' }, id: 'b' },
				{ id: 'c' },
				7
			])
		);
		expect(out.map((m) => m.id)).toEqual(['a', 'b']);
		expect(out[0].access_grants).toEqual([]);
		expect(() => parseModelImport('{}')).toThrow(/array/);
	});
});

describe('importUpdate', () => {
	const existing = {
		id: 'm',
		user_id: 'owner',
		name: 'Old',
		base_model_id: 'llama3',
		is_active: false,
		write_access: true,
		user: { name: 'Owner' },
		meta: { description: 'kept', profile_image_url: '/img.png', chat_variables_schema: { x: 1 } },
		params: { system: 'old' },
		access_grants: [{ id: 'g1', principal_type: 'group', principal_id: 'team', permission: 'read' }]
	};
	const incoming = parseModelImport(
		JSON.stringify([
			{
				id: 'm',
				name: 'New',
				base_model_id: 'llama3',
				is_active: true,
				meta: { tags: [{ name: 't' }], chat_variables_schema: { y: 2 } },
				params: { system: 'new' }
			}
		])
	)[0];

	it("keeps the existing model's grants and enabled state: grants are left out, so the server leaves them alone", () => {
		const out = importUpdate(existing, incoming);
		expect(out).not.toHaveProperty('access_grants');
		expect(out.is_active).toBe(false);
		expect(importUpdate({ ...existing, is_active: true }, incoming).is_active).toBe(true);
	});
	it("keeps the existing base model when the file has none, and takes the file's when it has one", () => {
		const bare = parseModelImport(JSON.stringify([{ id: 'm', name: 'New' }]))[0];
		expect(bare.base_model_id).toBeNull();
		expect(importUpdate(existing, bare).base_model_id).toBe('llama3');
		expect(importUpdate(existing, { ...bare, base_model_id: 'gpt-4o' }).base_model_id).toBe('gpt-4o');
	});
	it("merges the file's meta over the existing meta, as the server's own import does, and takes the rest from the file", () => {
		const out = importUpdate(existing, incoming);
		expect(out.meta).toEqual({ description: 'kept', profile_image_url: '/img.png', tags: [{ name: 't' }] });
		expect(out).toEqual({
			id: 'm',
			name: 'New',
			base_model_id: 'llama3',
			meta: out.meta,
			params: { system: 'new' },
			is_active: false
		});
	});
});

describe('saveImportedModel', () => {
	const incoming = parseModelImport(JSON.stringify([{ id: 'm', name: 'New', meta: { b: 1 } }]))[0];
	beforeEach(() => vi.clearAllMocks());

	it("updates a model that exists with importUpdate's body, which never carries grants", async () => {
		const existing = { id: 'm', name: 'Old', is_active: false, meta: { a: 1 }, access_grants: [{ id: 'g1' }] };
		vi.mocked(getModelById).mockResolvedValueOnce(existing);
		await saveImportedModel('tok', incoming);
		expect(updateModelById).toHaveBeenCalledWith('tok', 'm', importUpdate(existing, incoming));
		expect(vi.mocked(updateModelById).mock.calls[0][2]).not.toHaveProperty('access_grants');
		expect(createNewModel).not.toHaveBeenCalled();
	});
	it('creates a model whose id is not found, and passes a failed save on to the caller', async () => {
		vi.mocked(getModelById).mockRejectedValueOnce('Not found');
		await saveImportedModel('tok', incoming);
		expect(createNewModel).toHaveBeenCalledWith('tok', incoming);
		expect(updateModelById).not.toHaveBeenCalled();
		vi.mocked(getModelById).mockResolvedValueOnce({ id: 'm', meta: {} });
		vi.mocked(updateModelById).mockRejectedValueOnce('Access prohibited');
		await expect(saveImportedModel('tok', incoming)).rejects.toBe('Access prohibited');
	});
});

describe('importPayload', () => {
	const parsed = parseModelImport(
		JSON.stringify([
			{ id: 'a', name: 'A', base_model_id: 'llama3', meta: { description: 'd' }, params: { temperature: 1 } },
			{ id: 'b', name: 'B', access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'read' }] }
		])
	);

	it("leaves grants out, so the server's /models/import keeps an existing model's sharing (#524)", () => {
		for (const model of importPayload(parsed)) expect(model).not.toHaveProperty('access_grants');
	});

	it('leaves a missing base model out, so an existing model keeps its own (#524)', () => {
		const [a, b] = importPayload(parsed);
		expect(a).toEqual({
			id: 'a',
			name: 'A',
			base_model_id: 'llama3',
			meta: { description: 'd' },
			params: { temperature: 1 }
		});
		expect(b).toEqual({ id: 'b', name: 'B', meta: {}, params: {} });
	});
});
