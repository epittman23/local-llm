import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getSkillById, updateSkillById } from '@/lib/apis/skills';
import { SkillEditPage } from './SkillPages';

// The install's account count, for useSingleUser (S4-D1): two unless a test says one.
const accounts = vi.hoisted(() => ({ total: 2 }));
vi.mock('@/lib/apis/users', () => ({ searchUsers: vi.fn(async () => ({ total: accounts.total })) }));

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
			<QueryClientProvider client={new QueryClient()}>
				<TooltipProvider>
					<RouterProvider
						router={createMemoryRouter([{ path: '/workspace/skills/edit', element: <SkillEditPage /> }], {
							initialEntries: ['/workspace/skills/edit?id=review']
						})}
					/>
				</TooltipProvider>
			</QueryClientProvider>
		);

		const instructions = await screen.findByLabelText('Skill instructions');
		expect(getSkillById).toHaveBeenCalledWith(expect.anything(), 'review');
		fireEvent.change(instructions, { target: { value: 'new' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

		await waitFor(() => expect(updateSkillById).toHaveBeenCalledOnce());
		const sent = vi.mocked(updateSkillById).mock.calls[0]?.[2];
		expect(sent).toMatchObject({ content: 'new' });
		expect(sent).not.toHaveProperty('is_active');
		expect(sent).not.toHaveProperty('meta');
	});
});

describe('SkillEditPage when the skill is not there (#1095, NAV-3, STA-4)', () => {
	const open = () =>
		render(
			<QueryClientProvider client={new QueryClient()}>
				<TooltipProvider>
					<RouterProvider
						router={createMemoryRouter([{ path: '/workspace/skills/edit', element: <SkillEditPage /> }], {
							initialEntries: ['/workspace/skills/edit?id=gone']
						})}
					/>
				</TooltipProvider>
			</QueryClientProvider>
		);

	it('says in place that it no longer exists, with a way back', async () => {
		vi.mocked(getSkillById).mockRejectedValueOnce("We could not find what you're looking for :/");
		open();
		expect(await screen.findByRole('heading', { name: 'This skill no longer exists.' })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Skills' })).toHaveAttribute('href', '/workspace/skills');
	});

	it('offers to try again when it failed to load', async () => {
		vi.mocked(getSkillById).mockRejectedValueOnce('Internal error');
		open();
		fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
		expect(await screen.findByLabelText('Skill name')).toBeInTheDocument();
	});
});
