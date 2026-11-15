import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import General from './General';

const stable = vi.hoisted(() => ({
	settings: { system: 'be brief', params: {} },
	update: vi.fn(async () => undefined)
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

	it('saves on request: Save waits for a change, Discard changes puts it back (#951)', async () => {
		render(
			<TooltipProvider>
				<General />
			</TooltipProvider>
		);
		const prompt = screen.getByRole('textbox', { name: 'System prompt' });
		expect(prompt).toHaveValue('be brief');
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
		fireEvent.change(prompt, { target: { value: 'be thorough' } });
		expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
		expect(prompt).toHaveValue('be brief');
		fireEvent.change(prompt, { target: { value: 'be thorough' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(stable.update).toHaveBeenCalledWith({ system: 'be thorough', params: {} }));
	});

	it('offers the theme as four named segments that apply at once (#1089)', () => {
		render(
			<TooltipProvider>
				<General />
			</TooltipProvider>
		);
		const group = screen.getByRole('radiogroup', { name: 'Theme' });
		expect(group.textContent).toBe('SystemDarkBlackLight');
		fireEvent.click(screen.getByRole('radio', { name: 'Black' }));
		expect(localStorage.theme).toBe('oled-dark');
		expect(document.documentElement.classList.contains('oled')).toBe(true);
		fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
		expect(localStorage.theme).toBe('dark');
		// Instant, unlike the rest of the tab: nothing to save.
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
	});
});
