import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatBanners } from './ChatBanners';
import { DISMISSED_BANNERS_KEY, closedBannerIds } from './banners';

const { getBanners } = vi.hoisted(() => ({ getBanners: vi.fn() }));
vi.mock('@/lib/apis/configs', () => ({ getBanners }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't' })
}));

// What GET /api/v1/configs/banners answers (BannerModel: no url field).
const BANNERS = [
	{ id: 'b1', type: 'warning', content: 'Maintenance tonight', dismissible: true, timestamp: 0 },
	{ id: 'b2', type: 'info', content: 'Welcome', dismissible: false, timestamp: 0 }
];

const show = () => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<ChatBanners />
		</QueryClientProvider>
	);
};

describe('ChatBanners', () => {
	beforeEach(() => {
		localStorage.clear();
		closedBannerIds.clear();
		getBanners.mockResolvedValue(BANNERS);
	});
	afterEach(cleanup);

	it('shows the banners, each with a close button named for it', async () => {
		show();
		expect(await screen.findByText('Maintenance tonight')).toBeTruthy();
		expect(screen.getByText('Welcome')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Close warning banner' })).toBeTruthy();
		expect(screen.queryByRole('status')).toBeNull();
	});

	it('remembers a dismissible banner in the browser', async () => {
		show();
		fireEvent.click(await screen.findByRole('button', { name: 'Close warning banner' }));
		expect(screen.queryByText('Maintenance tonight')).toBeNull();
		expect(JSON.parse(localStorage.getItem(DISMISSED_BANNERS_KEY) ?? '[]')).toEqual(['b1']);
	});

	it('keeps another closed for the life of the page, not only while mounted', async () => {
		const first = show();
		fireEvent.click(await screen.findByRole('button', { name: 'Close info banner' }));
		first.unmount();

		// A new chat after a sent message mounts the banners again.
		show();
		expect(await screen.findByText('Maintenance tonight')).toBeTruthy();
		expect(screen.queryByText('Welcome')).toBeNull();
		expect(localStorage.getItem(DISMISSED_BANNERS_KEY)).toBeNull();
	});

	it('shows nothing when the reply is not a list of banners', async () => {
		getBanners.mockResolvedValue({ items: [], total: 0 });
		const { container } = show();
		await vi.waitFor(() => expect(getBanners).toHaveBeenCalled());
		expect(container.innerHTML).toBe('');
	});
});
