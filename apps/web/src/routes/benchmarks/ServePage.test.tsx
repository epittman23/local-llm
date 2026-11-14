import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';
import { ServePage } from './ServePage';

// Every API helper is mocked: nothing here reaches a server or starts one.
vi.mock('@/lib/apis/benchmarks', async (importOriginal) => {
	const real = await importOriginal<typeof import('@/lib/apis/benchmarks')>();
	return {
		...real,
		getServeProfiles: vi.fn(),
		getServeProfile: vi.fn(),
		checkServe: vi.fn(),
		startServe: vi.fn(),
		stopServe: vi.fn(),
		streamServe: vi.fn()
	};
});

const stream = (lines: string[]) => {
	const body = `${lines.map((line) => `data: ${JSON.stringify({ line })}\n\n`).join('')}event: done\ndata: {}\n\n`;
	return [new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), new AbortController()] as [
		Response,
		AbortController
	];
};

const renderPage = () =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<ServePage />
		</QueryClientProvider>
	);

describe('ServePage', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'test-token' });
		vi.mocked(api.getServeProfiles).mockResolvedValue({ profiles: ['qwen38'] });
		vi.mocked(api.checkServe).mockResolvedValue({ running: false } as never);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		useAuthStore.setState({ token: null });
	});

	it('says there is no log output while nothing is served, in the muted colour', async () => {
		renderPage();
		const empty = await screen.findByText('No log output yet');
		expect(empty.className).toContain('text-foreground-muted');
		expect(api.streamServe).not.toHaveBeenCalled();
	});

	it('tails the log of a server that is already running', async () => {
		vi.mocked(api.checkServe).mockResolvedValue({ running: true } as never);
		vi.mocked(api.streamServe).mockResolvedValue(stream(['loading model', 'server listening']));
		renderPage();
		expect(await screen.findByText('server listening')).toBeInTheDocument();
		expect(screen.getByText('loading model')).toBeInTheDocument();
		expect(screen.queryByText('No log output yet')).toBeNull();
	});

	it('shows the server refusal when Start fails', async () => {
		vi.mocked(api.startServe).mockRejectedValue({ detail: 'a model is already being served' });
		renderPage();
		fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
		expect(await screen.findByText('a model is already being served')).toBeInTheDocument();
		expect(api.startServe).toHaveBeenCalledWith('test-token', {});
	});

	it('starts the log stream after a successful Start', async () => {
		vi.mocked(api.startServe).mockResolvedValue({ started: true } as never);
		vi.mocked(api.streamServe).mockResolvedValue(stream(['hello from llama-server']));
		renderPage();
		fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
		expect(await screen.findByText('hello from llama-server')).toBeInTheDocument();
		await waitFor(() => expect(api.streamServe).toHaveBeenCalledTimes(1));
	});
});
