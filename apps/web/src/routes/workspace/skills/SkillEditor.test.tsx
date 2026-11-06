import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SkillEditor } from './SkillEditor';
import type { SkillDraft } from './skillTypes';

const renderEditor = (props: Parameters<typeof SkillEditor>[0]) =>
	render(
		<TooltipProvider>
			<RouterProvider router={createMemoryRouter([{ path: '*', element: <SkillEditor {...props} /> }])} />
		</TooltipProvider>
	);

describe('SkillEditor', () => {
	it('saves a disabled, tagged skill without sending its enabled state or tags, so neither is overwritten (#227, #527)', async () => {
		const skill: SkillDraft = {
			id: 'review',
			name: 'Review',
			description: 'd',
			content: 'old',
			is_active: false,
			meta: { tags: ['imported'] },
			access_grants: []
		};
		const onSubmit = vi.fn(async (_: SkillDraft) => {});
		renderEditor({ skill, edit: true, onSubmit });

		fireEvent.change(screen.getByLabelText('Skill Instructions'), { target: { value: 'new' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		const sent = onSubmit.mock.calls[0]?.[0];
		expect(sent).toMatchObject({ id: 'review', content: 'new' });
		expect(sent).not.toHaveProperty('is_active');
		expect(sent).not.toHaveProperty('meta');
	});

	it('creates a new skill active and untagged', async () => {
		const onSubmit = vi.fn(async (_: SkillDraft) => {});
		renderEditor({ skill: null, onSubmit });

		fireEvent.change(screen.getByLabelText('Skill Name'), { target: { value: 'My Skill' } });
		fireEvent.change(screen.getByLabelText('Skill Instructions'), { target: { value: 'body' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save & Create' }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ id: 'my-skill', is_active: true, meta: { tags: [] } });
	});

	it('creates a clone of a disabled skill active, as a new skill', async () => {
		const skill: SkillDraft = {
			id: 'review-clone',
			name: 'Review (Clone)',
			description: 'd',
			content: 'body',
			is_active: false,
			meta: { tags: ['imported'] },
			access_grants: []
		};
		const onSubmit = vi.fn(async (_: SkillDraft) => {});
		renderEditor({ skill, clone: true, onSubmit });

		fireEvent.click(screen.getByRole('button', { name: 'Save & Create' }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ id: 'review-clone', is_active: true, meta: { tags: [] } });
	});
});
