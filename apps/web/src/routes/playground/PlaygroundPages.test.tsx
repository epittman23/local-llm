import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaygroundChat, PlaygroundImages, PlaygroundLayout } from './PlaygroundPages';

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
vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => ({ settings: {} }) }));
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

	it('marks the open tab as the current page and the others not, under the Playground heading', () => {
		layout('/playground/images');
		expect(screen.getByRole('heading', { level: 1, name: 'Playground' })).toBeInTheDocument();
		expect(screen.getByRole('navigation', { name: 'Playground' })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Images' }).getAttribute('aria-current')).toBe('page');
		expect(screen.getByRole('link', { name: 'Chat' }).getAttribute('aria-current')).toBeNull();
		expect(screen.getByRole('link', { name: 'Completions' }).className).toContain('hover:text-foreground');
		expect(screen.getByText('images page')).toBeInTheDocument();
	});

	it('marks Chat as the current tab on the index route only', () => {
		layout('/playground');
		expect(screen.getByRole('link', { name: 'Chat' }).getAttribute('aria-current')).toBe('page');
		expect(screen.getByRole('link', { name: 'Images' }).getAttribute('aria-current')).toBeNull();
	});
});

describe('the chat playground', () => {
	it('makes System Instructions a target at least 24 px tall, 44 px on touch (LAY-3), that opens the field', () => {
		wrap(<PlaygroundChat />);
		const toggle = screen.getByRole('button', { name: /System Instructions/ });
		expect(toggle.className).toContain('min-h-6');
		expect(toggle.className).toContain('pointer-coarse:min-h-11');
		fireEvent.click(toggle);
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		expect(screen.getByRole('textbox', { name: 'System Instructions' })).toBeInTheDocument();
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
