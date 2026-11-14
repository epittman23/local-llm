import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AutomationsPage } from './AutomationsPage';

const api = vi.hoisted(() => ({
	createAutomation: vi.fn(),
	deleteAutomationById: vi.fn(),
	getAutomationItems: vi.fn(),
	runAutomationById: vi.fn(),
	toggleAutomationById: vi.fn()
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/apis/automations', () => api);
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'me', role: 'user' } })
}));
vi.mock('@/routes/common/FeatureGate', () => ({ FeatureGate: ({ children }: { children: unknown }) => children }));
vi.mock('./useDestinations', () => ({ useDestinations: () => ({ folders: [], channels: [], loaded: true }) }));

beforeEach(() => vi.resetAllMocks());

describe('an Automations list that cannot load (STA-4, #981)', () => {
	it('shows the failure in place of the list, with no toast, and tries again', async () => {
		api.getAutomationItems.mockRejectedValue('Database is locked');
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TooltipProvider>
					<MemoryRouter>
						<AutomationsPage />
					</MemoryRouter>
				</TooltipProvider>
			</QueryClientProvider>
		);

		expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load automations");
		expect(screen.queryByText('No automations found')).toBeNull();
		expect(toast.error).not.toHaveBeenCalled();

		api.getAutomationItems.mockResolvedValue({ items: [], total: 0 });
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		expect(await screen.findByText('No automations found')).toBeInTheDocument();
	});
});
