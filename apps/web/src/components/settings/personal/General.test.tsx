import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import General from './General';

const stable = vi.hoisted(() => ({
	settings: { system: 'be brief', params: {} },
	update: async () => undefined
}));
vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => stable }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

describe('General settings tab', () => {
	afterEach(cleanup);

	it('shows and hides the advanced parameters from the Show/Hide button', () => {
		render(
			<TooltipProvider>
				<General />
			</TooltipProvider>
		);
		expect(screen.queryByRole('button', { name: 'Hide' })).toBeNull();
		const before = document.body.textContent?.length ?? 0;
		fireEvent.click(screen.getByRole('button', { name: 'Show' }));
		expect(screen.getByRole('button', { name: 'Hide' })).toBeInTheDocument();
		expect(document.body.textContent?.length ?? 0).toBeGreaterThan(before);
		fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
		expect(screen.getByRole('button', { name: 'Show' })).toBeInTheDocument();
	});
});
