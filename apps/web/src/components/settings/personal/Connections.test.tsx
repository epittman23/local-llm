import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import Connections from './Connections';

vi.mock('@/lib/settings/userSettings', () => ({
	useUserSettings: () => ({ settings: {}, update: vi.fn() })
}));

// #764: direct connections are saved, but chat cannot use them yet.
describe('personal direct connections (#764)', () => {
	it('says chat with them is not available yet', () => {
		render(
			<QueryClientProvider client={new QueryClient()}>
				<TooltipProvider>
					<Connections />
				</TooltipProvider>
			</QueryClientProvider>
		);
		expect(screen.getByRole('note').textContent).toMatch(/not yet available in chat/i);
	});
});
