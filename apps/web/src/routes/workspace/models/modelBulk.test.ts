import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toggleModelById, updateModelById } from '@/lib/apis/models';
import { applyBulkAction, type BulkRow, runBulkAction, setVisibility, visibilityUpdate } from './modelBulk';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));

vi.mock('@/lib/apis/models', () => ({
	toggleModelById: vi.fn(async () => ({})),
	updateModelById: vi.fn(async () => ({}))
}));

const row = (id: string, o: Partial<BulkRow> = {}): BulkRow => ({
	id,
	name: id.toUpperCase(),
	base_model_id: 'llama3',
	is_active: true,
	write_access: true,
	meta: { description: `about ${id}`, chat_variables_schema: { x: 1 } },
	params: { system: `prompt of ${id}` },
	access_grants: [{ principal_type: 'user', principal_id: '*', permission: 'read' }],
	...o
});

beforeEach(() => vi.clearAllMocks());

describe('visibilityUpdate', () => {
	it('sets meta.hidden and keeps params, base model and enabled state, without grants or derived meta', () => {
		const body = visibilityUpdate(row('a', { is_active: false }), true);
		expect(body).toEqual({
			id: 'a',
			name: 'A',
			base_model_id: 'llama3',
			meta: { description: 'about a', hidden: true },
			params: { system: 'prompt of a' },
			is_active: false
		});
		expect(body).not.toHaveProperty('access_grants');
	});
	it('leaves out profile_image_url, base_model_id and params a row lacks, so the server keeps or refuses them', () => {
		const body = JSON.parse(
			JSON.stringify(visibilityUpdate({ id: 'b', name: 'B', write_access: true, meta: null }, false))
		);
		expect(body).toEqual({ id: 'b', name: 'B', meta: { hidden: false }, is_active: true });
	});
});

describe('setVisibility', () => {
	it("saves one model's visibility with its own fields, never its grants or derived meta", async () => {
		await setVisibility('t', row('a', { is_active: false }), true);
		expect(vi.mocked(updateModelById).mock.calls).toEqual([
			['t', 'a', visibilityUpdate(row('a', { is_active: false }), true)]
		]);
		const body = vi.mocked(updateModelById).mock.calls[0][2];
		expect(body).not.toHaveProperty('access_grants');
		expect(body).toMatchObject({ is_active: false, params: { system: 'prompt of a' }, meta: { hidden: true } });
		expect((body as BulkRow).meta).not.toHaveProperty('chat_variables_schema');
	});
	it('toasts the outcome and says whether the model was saved', async () => {
		expect(await setVisibility('t', row('a'), true)).toBe(true);
		expect(toast.success).toHaveBeenLastCalledWith('Model a is now hidden');
		expect(await setVisibility('t', row('a'), false)).toBe(true);
		expect(toast.success).toHaveBeenLastCalledWith('Model a is now visible');

		vi.mocked(updateModelById).mockResolvedValueOnce(null);
		expect(await setVisibility('t', row('a'), true)).toBe(false);
		vi.mocked(updateModelById).mockRejectedValueOnce('denied');
		expect(await setVisibility('t', row('a'), true)).toBe(false);
		expect(toast.success).toHaveBeenCalledTimes(2);
		expect(toast.error).toHaveBeenCalledWith('denied');
	});
});

describe('applyBulkAction', () => {
	const rows = [
		row('on'),
		row('off', { is_active: false }),
		row('hidden', { meta: { hidden: true } }),
		row('ro-on', { write_access: false, params: {} }),
		row('ro-off', { write_access: false, is_active: false, params: {} }),
		row('ro-hidden', { write_access: false, meta: { hidden: true }, params: {} })
	];

	it('enables and disables only writable models, counting the read-only ones it skipped', async () => {
		expect(await applyBulkAction('t', rows, 'enable')).toEqual({ changed: 1, skipped: 1 });
		expect(vi.mocked(toggleModelById).mock.calls).toEqual([['t', 'off']]);

		vi.mocked(toggleModelById).mockClear();
		expect(await applyBulkAction('t', rows, 'disable')).toEqual({ changed: 2, skipped: 2 });
		expect(vi.mocked(toggleModelById).mock.calls).toEqual([
			['t', 'on'],
			['t', 'hidden']
		]);
		expect(updateModelById).not.toHaveBeenCalled();
	});

	it('hides only writable models, sending each one its own params and no grants', async () => {
		expect(await applyBulkAction('t', rows, 'hide')).toEqual({ changed: 2, skipped: 2 });
		const calls = vi.mocked(updateModelById).mock.calls;
		expect(calls.map(([, id]) => id)).toEqual(['on', 'off']);
		expect(calls[1][2]).toMatchObject({
			params: { system: 'prompt of off' },
			is_active: false,
			meta: { hidden: true }
		});
		for (const [, , body] of calls) expect(body).not.toHaveProperty('access_grants');
		expect(toggleModelById).not.toHaveBeenCalled();
	});

	it('shows only writable hidden models, and skips everything when nothing is writable', async () => {
		expect(await applyBulkAction('t', rows, 'show')).toEqual({ changed: 1, skipped: 1 });
		expect(vi.mocked(updateModelById).mock.calls).toEqual([['t', 'hidden', visibilityUpdate(rows[2], false)]]);

		vi.mocked(updateModelById).mockClear();
		expect(await applyBulkAction('t', rows.slice(3), 'hide')).toEqual({ changed: 0, skipped: 2 });
		expect(updateModelById).not.toHaveBeenCalled();
	});

	it('acts once on a row the paged list returned twice, so a toggle does not cancel itself out', async () => {
		const off = row('off', { is_active: false });
		expect(await applyBulkAction('t', [off, row('on'), { ...off }], 'enable')).toEqual({ changed: 1, skipped: 0 });
		expect(vi.mocked(toggleModelById).mock.calls).toEqual([['t', 'off']]);

		const ro = row('ro', { write_access: false });
		expect(await applyBulkAction('t', [ro, ro], 'hide')).toEqual({ changed: 0, skipped: 1 });
	});

	it('passes an API error back to the page', async () => {
		vi.mocked(toggleModelById).mockRejectedValueOnce(new Error('nope'));
		await expect(applyBulkAction('t', rows, 'enable')).rejects.toThrow('nope');
	});
});

describe('runBulkAction', () => {
	const load = (rows: BulkRow[]) => async () => rows;

	it("toasts the action's message when every model it needed to change was changed", async () => {
		await runBulkAction('t', load([row('a'), row('b', { meta: { hidden: true } })]), 'hide');
		expect(updateModelById).toHaveBeenCalledTimes(1);
		expect(toast.success).toHaveBeenCalledWith('All models are now hidden');
		expect(toast.info).not.toHaveBeenCalled();

		await runBulkAction('t', load([row('c', { meta: { hidden: true } })]), 'show');
		expect(toast.success).toHaveBeenLastCalledWith('All models are now visible');
	});

	it('says how many read-only models it skipped instead, and stays quiet when there was nothing to do', async () => {
		await runBulkAction('t', load([row('a'), row('b', { write_access: false })]), 'hide');
		expect(toast.success).not.toHaveBeenCalled();
		expect(toast.info).toHaveBeenCalledWith('Skipped 1 read-only model');

		await runBulkAction('t', load([row('c', { write_access: false }), row('d', { write_access: false })]), 'disable');
		expect(toast.info).toHaveBeenLastCalledWith('Skipped 2 read-only models');

		vi.mocked(toast.info).mockClear();
		await runBulkAction('t', load([row('e')]), 'enable');
		await runBulkAction('t', load([row('f', { meta: { hidden: true } })]), 'hide');
		expect(toast.success).not.toHaveBeenCalled();
		expect(toast.info).not.toHaveBeenCalled();
	});

	it('toasts an error from loading the rows or from the API', async () => {
		await runBulkAction('t', () => Promise.reject(new Error('list failed')), 'hide');
		expect(toast.error).toHaveBeenCalledWith('Error: list failed');

		vi.mocked(toggleModelById).mockRejectedValueOnce('denied');
		await runBulkAction('t', load([row('a')]), 'disable');
		expect(toast.error).toHaveBeenLastCalledWith('denied');
	});
});
