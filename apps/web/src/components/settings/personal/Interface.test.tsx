import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAuthStore } from '@/lib/stores/authStore';
import Interface, { SAVE_DELAY_MS } from './Interface';

const user = vi.hoisted(() => ({ settings: { widescreenMode: false } as Record<string, unknown>, update: vi.fn() }));
vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => user }));
vi.mock('@/lib/apis/users', () => ({
	getUserSettings: vi.fn().mockResolvedValue({ ui: {} }),
	updateUserInfo: vi.fn()
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

function mount() {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<TooltipProvider>
				<Interface />
			</TooltipProvider>
		</QueryClientProvider>
	);
}
const widescreen = () => screen.getByRole('switch', { name: 'Widescreen Mode' });

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	user.update.mockReset();
	user.update.mockResolvedValue({});
	toast.error.mockReset();
	useAuthStore.setState({ token: 'jwt', user: { id: 'u', name: 'U', role: 'user' } } as never);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe('Interface saves at once (#951, FRM-3, FRM-5)', () => {
	it('says so, has no Save, and saves a switch shortly after it changes, then says Saved beside it', async () => {
		mount();
		expect(screen.getByText('Changes are saved as you make them.')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
		fireEvent.click(widescreen());
		expect(widescreen()).toHaveAttribute('aria-checked', 'true');
		expect(user.update).not.toHaveBeenCalled();
		await act(async () => {
			vi.advanceTimersByTime(SAVE_DELAY_MS);
		});
		expect(user.update).toHaveBeenCalledWith({ widescreenMode: true });
		expect(screen.getByRole('status')).toHaveTextContent('Saved');
	});

	it('saves a burst of changes as one, and what is waiting when the tab closes', async () => {
		const { unmount } = mount();
		fireEvent.click(widescreen());
		fireEvent.click(screen.getByRole('switch', { name: 'Chat Bubble UI' }));
		unmount();
		expect(user.update).toHaveBeenCalledTimes(1);
		expect(Object.keys(user.update.mock.calls[0][0]).sort()).toEqual(['chatBubble', 'widescreenMode']);
	});

	it('saves at once on Enter, and says when a save failed', async () => {
		user.update.mockRejectedValue(new Error('offline'));
		mount();
		fireEvent.click(widescreen());
		fireEvent.submit(widescreen().closest('form') as HTMLFormElement);
		expect(user.update).toHaveBeenCalledTimes(1);
		await act(async () => {
			await Promise.resolve();
		});
		expect(toast.error).toHaveBeenCalledWith("Couldn't save that setting: offline");
		// Nothing was waiting: closing sends nothing more.
		cleanup();
		expect(user.update).toHaveBeenCalledTimes(1);
	});
});
