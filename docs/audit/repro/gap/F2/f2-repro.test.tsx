import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, fireEvent, screen } from '../../../../../apps/web/node_modules/@testing-library/react';
import { parseModelImport } from '@/routes/workspace/models/modelImport';
import { updateModelById } from '@/lib/apis/models';
import { PromptSuggestionsEditor } from '@/routes/workspace/models/PromptSuggestionsEditor';

afterEach(() => vi.restoreAllMocks());

describe('F2 repro: model import update payload', () => {
	it('re-importing an exported (disabled, shared) model sends access_grants: [] and no is_active', async () => {
		// What Export JSON writes for one model (getModelById shape)
		const exported = [
			{
				id: 'm1',
				name: 'M1',
				base_model_id: 'qwen',
				user_id: 'u1',
				is_active: false,
				params: { system: 'S' },
				meta: { description: 'd' },
				access_grants: [
					{ id: 'g', resource_type: 'model', resource_id: 'm1', principal_type: 'group', principal_id: 'team', permission: 'read' }
				],
				write_access: true
			}
		];
		const [incoming] = parseModelImport(JSON.stringify(exported));
		let body: any = null;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, init: any) => {
			body = JSON.parse(init.body);
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});
		await updateModelById('t', incoming.id, incoming);
		console.log('UPDATE BODY', JSON.stringify(body));
		expect(body.access_grants).toEqual([]);
		expect('is_active' in body).toBe(false);
	});
});

describe('F2 repro: prompt suggestions truncation', () => {
	it('editing one suggestion truncates every other suggestion to 2000 chars', () => {
		const long = 'x'.repeat(3000);
		const onChange = vi.fn();
		render(
			<PromptSuggestionsEditor
				value={[
					{ content: long, title: ['Long', ''] },
					{ content: 'short', title: ['Short', ''] }
				]}
				onChange={onChange}
			/>
		);
		const titles = screen.getAllByLabelText('Title');
		fireEvent.change(titles[1], { target: { value: 'Short!' } });
		const next = onChange.mock.calls[0][0];
		console.log('LENGTH OF FIRST SUGGESTION AFTER EDITING THE SECOND:', next[0].content.length);
		expect(next[0].content.length).toBe(2000);
	});
});
