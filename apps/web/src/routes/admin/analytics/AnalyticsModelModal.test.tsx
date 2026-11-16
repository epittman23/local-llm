import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getModelChats, getModelOverview } from '@/lib/apis/analytics';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { AnalyticsModelModal } from './AnalyticsModelModal';

vi.mock('@/lib/apis/analytics', () => ({ getModelChats: vi.fn(), getModelOverview: vi.fn() }));
vi.mock('../evaluations/ModelActivityChart', () => ({
	ModelActivityChart: ({ weekly }: { weekly: boolean }) => <div data-testid="chart">{weekly ? 'weekly' : 'daily'}</div>
}));

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getModelOverview).mockResolvedValue({ history: [], tags: [{ tag: 'math', count: 5 }] } as never);
	vi.mocked(getModelChats).mockResolvedValue({
		chats: [{ chat_id: 'c1', first_message: 'Hello there', updated_at: 1700000000, user_id: 'u', user_name: 'Ada' }],
		total: 1
	} as never);
	useAuthStore.setState({ token: 'tok' } as never);
	useConfigStore.setState({ config: { features: { enable_admin_chat_access: true } } } as never);
});

const renderModal = () => {
	const onOpenChange = vi.fn();
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter>
				<TooltipProvider>
					<AnalyticsModelModal
						open
						onOpenChange={onOpenChange}
						model={{ id: 'm1', name: 'Model One' }}
						startDate={10}
						endDate={20}
					/>
				</TooltipProvider>
			</MemoryRouter>
		</QueryClientProvider>
	);
	return onOpenChange;
};

// Radix tabs choose on mouse down.
const selectTab = (name: string) => fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });

describe('AnalyticsModelModal', () => {
	it('opens on Overview with the model tags', async () => {
		renderModal();
		expect(await screen.findByText('math')).toBeTruthy();
		expect(screen.getByTestId('chart').textContent).toBe('daily');
	});

	it('switches the chart to weekly and refetches when the range changes', async () => {
		renderModal();
		fireEvent.click(screen.getByRole('radio', { name: '1 year' }));
		expect(screen.getByRole('radio', { name: '1 year' }).getAttribute('aria-checked')).toBe('true');
		expect(screen.getByTestId('chart').textContent).toBe('weekly');
		await waitFor(() => expect(getModelOverview).toHaveBeenCalledWith('tok', 'm1', 365));
	});

	it('loads the chats of the model when the Chats tab is opened', async () => {
		renderModal();
		selectTab('Chats');
		expect(await screen.findByText('Hello there')).toBeTruthy();
		expect(getModelChats).toHaveBeenCalledWith('tok', 'm1', 10, 20, 0, 50, 'updated_at', 'desc');
		selectTab('Overview');
		expect(screen.getByTestId('chart')).toBeTruthy();
	});

	it('has no Chats tab when admins may not read chats', () => {
		useConfigStore.setState({ config: { features: { enable_admin_chat_access: false } } } as never);
		renderModal();
		expect(screen.queryByRole('tab', { name: 'Chats' })).toBeNull();
		expect(screen.queryByRole('tablist')).toBeNull();
	});

	it('names the model and its id in the header, with no tooltip on the title', async () => {
		renderModal();
		expect(screen.getByRole('heading', { name: 'Model One' })).toBeTruthy();
		expect(screen.getByText('m1')).toBeTruthy();
		await screen.findByText('math');
	});

	it('does not repeat a name that is its id', async () => {
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<MemoryRouter>
					<AnalyticsModelModal
						open
						onOpenChange={vi.fn()}
						model={{ id: 'qwen/x', name: 'qwen/x' }}
						startDate={1}
						endDate={2}
					/>
				</MemoryRouter>
			</QueryClientProvider>
		);
		expect(screen.getAllByText('qwen/x')).toHaveLength(1);
		expect(screen.getByText('Usage of qwen/x').className).toContain('sr-only');
		await screen.findByText('math');
	});

	it('says in place when the overview fails to load, and tries again', async () => {
		vi.mocked(getModelOverview).mockRejectedValueOnce('Database is locked');
		renderModal();
		expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load feedback");
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByText('math')).toBeTruthy();
	});

	it('says so when the model has no tags', async () => {
		vi.mocked(getModelOverview).mockResolvedValue({ history: [], tags: [] } as never);
		renderModal();
		expect(await screen.findByText('No tags in its chats.')).toBeTruthy();
	});

	it('closes from the Close button', () => {
		const onOpenChange = renderModal();
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
