import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAuthStore } from '@/lib/stores/authStore';
import { ChatPage } from './ChatPage';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() }) }));
vi.mock('./useModels', () => ({
	useModels: () => ({ models: [{ id: 'm1', name: 'Model One' }], loaded: true, failed: false })
}));
vi.mock('./ChatControls', () => ({ ChatControls: () => <div data-testid="controls-panel" /> }));
vi.mock('@/lib/settings/userSettings', () => ({
	useUserSettings: () => ({ settings: {}, update: vi.fn(async () => undefined) })
}));
vi.mock('@/lib/apis/configs', () => ({ getBanners: vi.fn(async () => []) }));
vi.mock('@/lib/apis/tools', () => ({ getTools: vi.fn(async () => []) }));

function show() {
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<MemoryRouter>
					<ChatPage />
				</MemoryRouter>
			</TooltipProvider>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	useAuthStore.setState({
		status: 'authenticated',
		token: 't',
		user: { id: 'u1', name: 'Ada', role: 'admin' }
	} as never);
});
afterEach(cleanup);

describe('ChatPage header', () => {
	it('toggles Temporary Chat on a new chat', () => {
		show();
		const toggle = screen.getByRole('button', { name: 'Temporary Chat' });
		expect(toggle.getAttribute('aria-pressed')).toBe('false');
		fireEvent.click(toggle);
		expect(toggle.getAttribute('aria-pressed')).toBe('true');
	});

	it('toggles the Controls panel', () => {
		show();
		const controls = screen.getByRole('button', { name: 'Controls' });
		expect(controls.getAttribute('aria-pressed')).toBe('false');
		fireEvent.click(controls);
		expect(controls.getAttribute('aria-pressed')).toBe('true');
	});
});
