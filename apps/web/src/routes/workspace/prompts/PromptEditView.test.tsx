import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getPromptHistory, setProductionPromptVersion, updatePromptMetadata } from '@/lib/apis/prompts';
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
