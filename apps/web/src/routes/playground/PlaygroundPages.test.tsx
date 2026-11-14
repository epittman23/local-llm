import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaygroundImages, PlaygroundLayout } from './PlaygroundPages';

const { imageGenerations, imageEdits, saveAs, toast } = vi.hoisted(() => ({
	imageGenerations: vi.fn(),
	imageEdits: vi.fn(),
	saveAs: vi.fn(),
	toast: { error: vi.fn(), success: vi.fn() }
}));

vi.mock('sonner', () => ({ toast }));
vi.mock('file-saver', () => ({ default: saveAs }));
vi.mock('@/lib/apis/images', () => ({ imageGenerations, imageEdits }));
vi.mock('@/lib/apis', () => ({ getModels: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/stores/authStore', () => ({
	useAuthStore: (sel: (s: unknown) => unknown) => sel({ token: 't', user: { id: 'me', role: 'admin' } })
}));
vi.mock('@/routes/common/FeatureGate', () => ({ FeatureGate: ({ children }: { children: unknown }) => children }));

const wrap = (node: React.ReactNode, path = '/playground') =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
		</QueryClientProvider>
	);

beforeEach(() => {
	vi.resetAllMocks();
});
afterEach(cleanup);

describe('the playground tabs', () => {
	const layout = (path: string) =>
		wrap(
			<Routes>
				<Route path="/playground" element={<PlaygroundLayout />}>
					<Route index element={<div>chat page</div>} />
					<Route path="images" element={<div>images page</div>} />
				</Route>
			</Routes>,
			path
		);

	it('shows the current tab in the normal colour and the others muted', () => {
		layout('/playground/images');
		expect(screen.getByRole('link', { name: 'Images' }).className).not.toContain('text-foreground-muted');
		expect(screen.getByRole('link', { name: 'Chat' }).className).toContain('text-foreground-muted');
		expect(screen.getByRole('link', { name: 'Completions' }).className).toContain('hover:text-foreground');
		expect(screen.getByText('images page')).toBeInTheDocument();
	});

	it('marks Chat as the current tab on the index route only', () => {
		layout('/playground');
		expect(screen.getByRole('link', { name: 'Chat' }).className).not.toContain('text-foreground-muted');
		expect(screen.getByRole('link', { name: 'Images' }).className).toContain('text-foreground-muted');
	});
});

describe('the image playground results', () => {
	const url = 'data:image/png;base64,iVBORw0KGgo=';

	it('refuses to run without a prompt', () => {
		wrap(<PlaygroundImages />);
		expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
		expect(imageGenerations).not.toHaveBeenCalled();
	});

	it('lists a generated image and downloads it when it is pressed', async () => {
		imageGenerations.mockResolvedValue([{ url }]);
		const blob = new Blob(['x']);
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ blob: async () => blob }));
		wrap(<PlaygroundImages />);
		fireEvent.change(screen.getByLabelText('Image prompt'), { target: { value: 'a red fox' } });
		fireEvent.click(screen.getByRole('button', { name: 'Run' }));
		await waitFor(() => expect(imageGenerations).toHaveBeenCalledWith('t', 'a red fox'));
		fireEvent.click(await screen.findByRole('button', { name: 'Download image 1' }));
		await waitFor(() => expect(saveAs).toHaveBeenCalledWith(blob, expect.stringMatching(/^image-\d+-0\.png$/)));
		vi.unstubAllGlobals();
	});

	it('says so when the download fails', async () => {
		imageGenerations.mockResolvedValue([{ url }]);
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
		wrap(<PlaygroundImages />);
		fireEvent.change(screen.getByLabelText('Image prompt'), { target: { value: 'a red fox' } });
		fireEvent.click(screen.getByRole('button', { name: 'Run' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Download image 1' }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to download image'));
		vi.unstubAllGlobals();
	});
});
