import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AccessGrant } from '@/lib/access/accessGrants';
import {
	getPromptHistory,
	setProductionPromptVersion,
	updatePromptAccessGrants,
	updatePromptMetadata
} from '@/lib/apis/prompts';
import { useAuthStore } from '@/lib/stores/authStore';
import { PromptEditView } from './PromptEditView';

vi.mock('@/lib/apis/prompts', () => ({
	deletePromptHistoryVersion: vi.fn(),
	getPromptHistory: vi.fn(async () => []),
	getPromptTags: vi.fn(async () => []),
	setProductionPromptVersion: vi.fn(),
	updatePromptAccessGrants: vi.fn(),
	updatePromptMetadata: vi.fn(async () => ({}))
}));

// The access dialog, reduced to what the view gives it and what it sends back.
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

const prompt = {
	id: 'p1',
	name: 'Summary',
	command: '/summary',
	content: 'Summarise this.',
	version_id: null,
	tags: ['writing'],
	access_grants: []
};

const renderView = (disabled = false) =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<MemoryRouter>
					<PromptEditView prompt={prompt} disabled={disabled} onSubmit={vi.fn()} />
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);

beforeEach(() => {
	useAuthStore.setState({
		token: 't',
		user: { id: 'u', email: 'e', name: 'n', role: 'user', profile_image_url: '' }
	} as never);
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe('PromptEditView metadata autosave (#228)', () => {
	it('saves a name edit made just before leaving instead of dropping it', () => {
		const view = renderView();
		fireEvent.change(screen.getByLabelText('Prompt Name'), { target: { value: 'Summary v2' } });
		view.unmount();
		expect(updatePromptMetadata).toHaveBeenCalledTimes(1);
		expect(updatePromptMetadata).toHaveBeenCalledWith('t', 'p1', 'Summary v2', 'summary', ['writing'], false);
	});

	it('saves the last name and command when leaving after several quick edits', () => {
		const view = renderView();
		fireEvent.change(screen.getByLabelText('Prompt Name'), { target: { value: 'Summary v2' } });
		fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'summary-v2' } });
		view.unmount();
		expect(updatePromptMetadata).toHaveBeenCalledTimes(1);
		expect(updatePromptMetadata).toHaveBeenCalledWith('t', 'p1', 'Summary v2', 'summary-v2', ['writing'], false);
	});

	it('saves with the token current when leaving, not the one current at the edit', () => {
		const view = renderView();
		fireEvent.change(screen.getByLabelText('Prompt Name'), { target: { value: 'Summary v2' } });
		act(() => useAuthStore.setState({ token: 't2' }));
		view.unmount();
		expect(updatePromptMetadata).toHaveBeenCalledWith('t2', 'p1', 'Summary v2', 'summary', ['writing'], false);
	});

	it('does not save again on leaving once the pause has saved the edit', () => {
		const view = renderView();
		fireEvent.change(screen.getByLabelText('Prompt Name'), { target: { value: 'Summary v2' } });
		act(() => vi.advanceTimersByTime(500));
		expect(updatePromptMetadata).toHaveBeenCalledTimes(1);
		view.unmount();
		expect(updatePromptMetadata).toHaveBeenCalledTimes(1);
	});

	it('saves a name edit as the page goes away, with keepalive (#675)', () => {
		renderView();
		fireEvent.change(screen.getByLabelText('Prompt Name'), { target: { value: 'Summary v2' } });
		act(() => void window.dispatchEvent(new Event('pagehide')));
		expect(updatePromptMetadata).toHaveBeenCalledExactlyOnceWith('t', 'p1', 'Summary v2', 'summary', ['writing'], true);
	});

	it('saves nothing on leaving a prompt the user may not edit', () => {
		const view = renderView(true);
		fireEvent.change(screen.getByLabelText('Prompt Name'), { target: { value: 'Summary v2' } });
		view.unmount();
		expect(updatePromptMetadata).not.toHaveBeenCalled();
	});

	it('saves nothing on leaving when nothing was edited', () => {
		const view = renderView();
		view.unmount();
		expect(updatePromptMetadata).not.toHaveBeenCalled();
	});
});

describe('PromptEditView production switch (#222)', () => {
	it('starts a new version from the content just made production', async () => {
		vi.mocked(getPromptHistory).mockResolvedValue([
			{ id: 'v2', commit_message: 'Second', created_at: 2, snapshot: { content: 'V2 content' } },
			{ id: 'v1', commit_message: 'First', created_at: 1, snapshot: { content: 'V1 content' } }
		] as never);
		vi.mocked(setProductionPromptVersion).mockResolvedValue({} as never);
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TooltipProvider>
					<MemoryRouter>
						<PromptEditView
							prompt={{ ...prompt, content: 'V2 content', version_id: 'v2' }}
							disabled={false}
							onSubmit={vi.fn()}
						/>
					</MemoryRouter>
				</TooltipProvider>
			</QueryClientProvider>
		);
		await act(async () => {});

		fireEvent.click(screen.getByText('First'));
		await act(async () => {
			fireEvent.click(screen.getByText('Set as Production'));
		});
		expect(setProductionPromptVersion).toHaveBeenCalledWith('t', 'p1', 'v1');

		fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
		expect(screen.getByLabelText('Prompt Content')).toHaveValue('V1 content');
	});
});

describe('PromptEditView access dialog (#676)', () => {
	const grant = (principal_id: string): AccessGrant => ({ principal_type: 'user', principal_id, permission: 'read' });
	const shown = () => screen.getByTestId('shown-grants').textContent;
	const send = (grants: AccessGrant[]) => {
		accessDialog.send = grants;
		fireEvent.click(screen.getByText('Send grants'));
	};
	beforeEach(() => vi.useRealTimers());

	it('shows the grants the server stored, and warns when it dropped some', async () => {
		vi.mocked(updatePromptAccessGrants).mockResolvedValue({ id: 'p1', access_grants: [grant('a')] });
		const warning = vi.spyOn(toast, 'warning');
		const success = vi.spyOn(toast, 'success');
		renderView();

		send([grant('a'), grant('*')]);

		await waitFor(() =>
			expect(warning).toHaveBeenCalledWith(
				'Some access settings were not saved: you are not allowed to share this way.'
			)
		);
		expect(shown()).toBe('a');
		expect(success).not.toHaveBeenCalled();
		expect(updatePromptAccessGrants).toHaveBeenCalledWith('t', 'p1', [grant('a'), grant('*')]);
	});

	it('says Saved when the server kept every grant', async () => {
		vi.mocked(updatePromptAccessGrants).mockResolvedValue({ id: 'p1', access_grants: [grant('a')] });
		const success = vi.spyOn(toast, 'success');
		renderView();

		send([grant('a')]);

		await waitFor(() => expect(success).toHaveBeenCalledWith('Saved'));
		expect(shown()).toBe('a');
	});

	it('puts the previous grants back when the save fails, and says why', async () => {
		vi.mocked(updatePromptAccessGrants).mockRejectedValue('Not allowed');
		const error = vi.spyOn(toast, 'error');
		renderView();

		send([grant('a')]);

		await waitFor(() => expect(error).toHaveBeenCalledWith('Not allowed'));
		expect(shown()).toBe('');
	});
});

describe('PromptEditView copy button', () => {
	it('copies the prompt content and shows it was copied', async () => {
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		renderView();
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Copy content' }));
		});
		expect(writeText).toHaveBeenCalledWith('Summarise this.');
	});
});
