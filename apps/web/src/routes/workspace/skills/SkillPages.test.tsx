import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getSkillById, updateSkillById } from '@/lib/apis/skills';
import { SkillEditPage } from './SkillPages';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const stored = {
	id: 'review',
	user_id: 'u1',
	name: 'Review',
	description: 'd',
	content: 'old',
	is_active: false,
	meta: { tags: ['imported'] },
	access_grants: [],
	write_access: true,
	created_at: 1,
	updated_at: 1
};

vi.mock('@/lib/apis/skills', () => ({
	getSkillById: vi.fn(async () => stored),
	updateSkillById: vi.fn(async (_token: string, _id: string, skill: object) => ({ ...stored, ...skill })),
	updateSkillAccessGrants: vi.fn()
}));

describe('SkillEditPage', () => {
	it('saves an edited skill without its is_active and tags, which the server keeps (#227, #527)', async () => {
		render(
			<TooltipProvider>
				<RouterProvider
					router={createMemoryRouter([{ path: '/workspace/skills/edit', element: <SkillEditPage /> }], {
						initialEntries: ['/workspace/skills/edit?id=review']
					})}
				/>
			</TooltipProvider>
		);

		const instructions = await screen.findByLabelText('Skill Instructions');
		expect(getSkillById).toHaveBeenCalledWith(expect.anything(), 'review');
		fireEvent.change(instructions, { target: { value: 'new' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => expect(updateSkillById).toHaveBeenCalledOnce());
		const sent = vi.mocked(updateSkillById).mock.calls[0]?.[2];
		expect(sent).toMatchObject({ content: 'new' });
		expect(sent).not.toHaveProperty('is_active');
		expect(sent).not.toHaveProperty('meta');
	});
});
