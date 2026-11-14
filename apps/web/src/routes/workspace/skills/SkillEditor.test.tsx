import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AccessGrant } from '@/lib/access/accessGrants';
import { updateSkillAccessGrants } from '@/lib/apis/skills';
import { useAuthStore } from '@/lib/stores/authStore';
import { SkillEditor } from './SkillEditor';
import type { SkillDraft } from './skillTypes';

vi.mock('@/lib/apis/skills', () => ({ updateSkillAccessGrants: vi.fn() }));

// The access dialog, reduced to what the editor gives it and what it sends back.
const accessDialog = vi.hoisted(() => ({ send: [] as AccessGrant[] }));
vi.mock('@/components/common/AccessControlModal', () => ({
	AccessControlModal: ({
		accessGrants,
		onChange
	}: {
		accessGrants: AccessGrant[];
		onChange: (grants: AccessGrant[]) => Promise<void>;
	}) => (
		<div>
			<output data-testid="shown-grants">{accessGrants.map((g) => g.principal_id).join(',')}</output>
			<button type="button" onClick={() => void onChange(accessDialog.send)}>
				Send grants
			</button>
		</div>
	)
}));

beforeEach(() => {
	useAuthStore.setState({
		token: 't',
		user: { id: 'u', email: 'e', name: 'n', role: 'user', profile_image_url: '' }
	} as never);
});
afterEach(() => vi.clearAllMocks());

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

		fireEvent.change(screen.getByLabelText('Skill instructions'), { target: { value: 'new' } });
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

		fireEvent.change(screen.getByLabelText('Skill name'), { target: { value: 'My Skill' } });
		fireEvent.change(screen.getByLabelText('Skill instructions'), { target: { value: 'body' } });
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

const DROPPED = 'Some access settings were not saved: you are not allowed to share this way.';

describe('SkillEditor access dialog (#676)', () => {
	const grant = (principal_id: string): AccessGrant => ({ principal_type: 'user', principal_id, permission: 'read' });
	const skill: SkillDraft = {
		id: 'review',
		name: 'Review',
		description: 'd',
		content: 'body',
		is_active: true,
		meta: { tags: [] },
		access_grants: []
	};
	const shown = () => screen.getByTestId('shown-grants').textContent;
	const send = (grants: AccessGrant[]) => {
		accessDialog.send = grants;
		fireEvent.click(screen.getByText('Send grants'));
	};

	it('shows the grants the server stored, and warns when it dropped some', async () => {
		vi.mocked(updateSkillAccessGrants).mockResolvedValue({ id: 'review', access_grants: [grant('a')] });
		const warning = vi.spyOn(toast, 'warning');
		const success = vi.spyOn(toast, 'success');
		renderEditor({ skill, edit: true, onSubmit: vi.fn() });

		send([grant('a'), grant('*')]);

		await waitFor(() => expect(warning).toHaveBeenCalledWith(DROPPED));
		expect(shown()).toBe('a');
		expect(success).not.toHaveBeenCalled();
		expect(updateSkillAccessGrants).toHaveBeenCalledWith('t', 'review', [grant('a'), grant('*')]);
	});

	it('puts the previous grants back when the save fails, and says why', async () => {
		vi.mocked(updateSkillAccessGrants).mockRejectedValue('Not allowed');
		const error = vi.spyOn(toast, 'error');
		renderEditor({ skill, edit: true, onSubmit: vi.fn() });

		send([grant('a')]);

		await waitFor(() => expect(error).toHaveBeenCalledWith('Not allowed'));
		expect(shown()).toBe('');
	});

	it('only keeps the grants of a skill not yet created, to send with it', async () => {
		const success = vi.spyOn(toast, 'success');
		const onSubmit = vi.fn(async (_: SkillDraft) => {});
		renderEditor({ skill: null, onSubmit });

		send([grant('a')]);
		await waitFor(() => expect(shown()).toBe('a'));
		fireEvent.change(screen.getByLabelText('Skill name'), { target: { value: 'New' } });
		fireEvent.change(screen.getByLabelText('Skill instructions'), { target: { value: 'body' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save & Create' }));

		await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
		expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ access_grants: [grant('a')] });
		expect(updateSkillAccessGrants).not.toHaveBeenCalled();
		expect(success).not.toHaveBeenCalled();
	});
});

describe('SkillEditor fields (#1057, #983)', () => {
	const skill: SkillDraft = {
		id: 'review',
		name: 'Review',
		description: 'Reviews code',
		content: 'Read the diff.',
		is_active: true,
		meta: { tags: [] },
		access_grants: []
	};

	it('labels every field visibly, the instructions included, on the shared input', () => {
		renderEditor({ skill: null, onSubmit: vi.fn() });
		expect(screen.getByLabelText('Skill name')).toHaveAttribute('data-slot', 'input');
		expect(screen.getByLabelText('Skill ID')).toHaveAttribute('placeholder', 'e.g. code-review-guidelines');
		expect(screen.getByLabelText('Skill description')).not.toBeRequired();
		expect(screen.getByText('Skill instructions').tagName).toBe('LABEL');
		expect(screen.getByLabelText('Skill instructions').tagName).toBe('TEXTAREA');
	});

	it('read-only, keeps the labels as text over disabled fields and the instructions as text', () => {
		renderEditor({ skill, edit: true, disabled: true, onSubmit: vi.fn() });
		expect(screen.getByLabelText('Skill name')).toBeDisabled();
		expect(screen.getByLabelText('Skill description')).toBeDisabled();
		expect(screen.queryByLabelText('Skill instructions')).toBeNull();
		expect(screen.getByText('Skill instructions')).toBeInTheDocument();
		expect(screen.getByText('Read the diff.')).toBeInTheDocument();
		expect(screen.queryByLabelText('Skill ID')).toBeNull();
	});
});
