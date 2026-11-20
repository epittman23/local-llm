import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/apis/benchmarks';
import * as profilesApi from '@/lib/apis/benchmarks/profiles';
import { useAuthStore } from '@/lib/stores/authStore';
import { serveLink } from './resultLinks';
import { overrideProblem, ServePage, uptime } from './ServePage';

// Every API helper is mocked: nothing here reaches a server or starts one.
vi.mock('@/lib/apis/benchmarks', async (importOriginal) => {
	const real = await importOriginal<typeof import('@/lib/apis/benchmarks')>();
	return {
		...real,
		getServeProfile: vi.fn(),
		checkServe: vi.fn(),
		startServe: vi.fn(),
		stopServe: vi.fn(),
		streamServe: vi.fn(),
		getLive: vi.fn(),
		previewServe: vi.fn()
	};
});
vi.mock('@/lib/apis/benchmarks/profiles', async (importOriginal) => {
	const real = await importOriginal<typeof import('@/lib/apis/benchmarks/profiles')>();
	return { ...real, listProfiles: vi.fn(), getProfile: vi.fn() };
});

const version = (over: Record<string, unknown> = {}) => ({
	version_id: 1,
	profile_id: 1,
	version: 2,
	created_at: 1794700000,
	created_by: null,
	note: null,
	arch: 'dense',
	alias: 'qwen3.8-27b',
	model_path: '{LLAMA_MODELS}/Qwen3.8-27B.gguf',
	ctx: 16384,
	threads: 12,
	ngl: 20,
	moe: null,
	override_tensors: null,
	parallel: 1,
	cache_k: 'q8_0',
	cache_v: 'q8_0',
	batch: 512,
	ubatch: 512,
	spec: ['--spec-type', 'draft-mtp'],
	samplers: [],
	extra: [],
	reasoning_effort_default: 'medium',
	notes: 'ngl 20 is a placeholder until the sweep.',
	...over
});
const entry = (name: string, isDefault: boolean, over: Record<string, unknown> = {}) => ({
	profile: {
		profile_id: 1,
		name,
		display_name: `${name} display`,
		is_default: isDefault,
		created_at: 1,
		archived_at: null
	},
	version: version(over)
});

const stream = (lines: string[]) => {
	const body = `${lines.map((line) => `data: ${JSON.stringify({ line })}\n\n`).join('')}event: done\ndata: {}\n\n`;
	return [new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), new AbortController()] as [
		Response,
		AbortController
	];
};

const renderPage = (url = '/benchmarks/serve') => {
	const router = createMemoryRouter([{ path: '/benchmarks/serve', element: <ServePage /> }], { initialEntries: [url] });
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	);
	return router;
};

describe('ServePage', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'test-token' });
		vi.mocked(profilesApi.listProfiles).mockResolvedValue([
			entry('qwen25c', false, { reasoning_effort_default: null, spec: [] }),
			entry('qwen38', true)
		] as never);
		vi.mocked(api.checkServe).mockResolvedValue({ running: false, port: 8090, profile: null } as never);
		vi.mocked(api.getServeProfile).mockResolvedValue({ weights_present: true } as never);
		vi.mocked(api.previewServe).mockResolvedValue({
			profile: 'qwen38',
			version: 2,
			argv: ['llama-server', '-m', '/models/Qwen3.8-27B.gguf', '-ngl', '20'],
			config_id: 'c98ef02c',
			config_lines: [],
			warning: "dense model 'qwen38', partial offload (ngl=20)."
		});
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		useAuthStore.setState({ token: null });
	});

	it('names every select by its visible label (#987)', async () => {
		renderPage();
		expect(await screen.findByRole('combobox', { name: 'Profile' })).toBeTruthy();
		expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toBeTruthy();
		expect(screen.getByRole('combobox', { name: 'Speculative decoding' })).toBeTruthy();
	});

	it('opens on the default profile with its values as placeholders, and says nothing is served (#976, #1051)', async () => {
		const router = renderPage();
		await waitFor(() =>
			expect(screen.getByRole('combobox', { name: 'Profile' }).textContent).toContain('qwen38 (default)')
		);
		expect(screen.getByText('Nothing served')).toBeInTheDocument();
		const ngl = screen.getByRole('textbox', { name: /GPU layers/ });
		expect(ngl.getAttribute('placeholder')).toBe('20');
		expect(screen.getByText('The profile uses 20.')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /^Notes/ }));
		expect(await screen.findByText('ngl 20 is a placeholder until the sweep.')).toBeInTheDocument();
		await waitFor(() => expect(router.state.location.search).toBe('?profile=qwen38'));
	});

	it('shows the launch preview with the config_id it would record (B-D5)', async () => {
		renderPage();
		expect(await screen.findByText('c98ef02c')).toBeInTheDocument();
		expect(screen.getByText(/llama-server -m \/models\/Qwen3.8-27B.gguf -ngl 20/)).toBeInTheDocument();
		expect(screen.getByText(/partial offload/)).toBeInTheDocument();
		expect(api.previewServe).toHaveBeenLastCalledWith('test-token', { profile: 'qwen38' });
	});

	it('says why the preview would be refused', async () => {
		vi.mocked(api.previewServe).mockRejectedValue('--parallel does not belong in a speculative override');
		renderPage();
		expect(await screen.findByText(/Start would be refused with these settings/)).toBeInTheDocument();
	});

	it('prefills the form from the address and never starts anything (NAV-1)', async () => {
		renderPage('/benchmarks/serve?profile=qwen25c&ngl=18&ctx=8192');
		await waitFor(() => expect(screen.getByRole('combobox', { name: 'Profile' }).textContent).toContain('qwen25c'));
		expect((screen.getByRole('textbox', { name: /GPU layers/ }) as HTMLInputElement).value).toBe('18');
		expect((screen.getByRole('textbox', { name: /Context/ }) as HTMLInputElement).value).toBe('8192');
		// qwen25c thinks not and has no speculative flags: both selects say so and are off.
		expect(screen.getByText('This model has no thinking budget to set.')).toBeInTheDocument();
		expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toBeDisabled();
		await waitFor(() =>
			expect(api.previewServe).toHaveBeenLastCalledWith('test-token', { profile: 'qwen25c', ngl: 18, ctx: 8192 })
		);
		expect(api.startServe).not.toHaveBeenCalled();
	});

	it("takes a Tune winner's speculative flags from its Serve link as a one-off override", async () => {
		const flags = '--spec-type draft-mtp --spec-draft-n-max 3';
		const link = serveLink('qwen38', { LLAMA_NGL: 22, LLAMA_SPEC: flags }) ?? '';
		const router = renderPage(link);
		await waitFor(() =>
			expect(api.previewServe).toHaveBeenLastCalledWith('test-token', { profile: 'qwen38', ngl: 22, spec: flags })
		);
		const select = screen.getByRole('combobox', { name: 'Speculative decoding' });
		expect(select.textContent).toBe(flags);
		expect(screen.getByText('From the link: these flags replace the profile’s for this run.')).toBeInTheDocument();
		// The address keeps the flags, so a reload serves the same winner.
		expect(new URLSearchParams(router.state.location.search).get('spec')).toBe(flags);
		expect(api.startServe).not.toHaveBeenCalled();
	});

	it('sends link flags even on a profile with none of its own, and Off only where there are flags to drop', async () => {
		renderPage('/benchmarks/serve?profile=qwen25c&spec=--spec-type+ngram');
		await waitFor(() =>
			expect(api.previewServe).toHaveBeenLastCalledWith('test-token', { profile: 'qwen25c', spec: '--spec-type ngram' })
		);
		expect(screen.getByRole('combobox', { name: 'Speculative decoding' })).not.toBeDisabled();
	});

	it('never takes flags other than speculative ones from a link, and names them instead', async () => {
		const router = renderPage('/benchmarks/serve?profile=qwen38&spec=--host+0.0.0.0');
		await waitFor(() => expect(api.previewServe).toHaveBeenLastCalledWith('test-token', { profile: 'qwen38' }));
		const select = screen.getByRole('combobox', { name: 'Speculative decoding' });
		expect(select.textContent).toBe('Default (the profile’s flags)');
		expect(screen.getByText('Not taken from the link')).toBeInTheDocument();
		expect(screen.getByText('--host 0.0.0.0')).toBeInTheDocument();
		expect(screen.queryByText(/From the link/)).toBeNull();
		fireEvent.keyDown(select, { key: 'Enter' });
		expect(screen.queryByRole('option', { name: '--host 0.0.0.0' })).toBeNull();
		fireEvent.keyDown(screen.getByRole('option', { name: 'Off' }), { key: 'Escape' });
		expect(router.state.location.search).not.toContain('spec=');
		for (const call of vi.mocked(api.previewServe).mock.calls) expect(call[1]).not.toHaveProperty('spec');
		vi.mocked(api.startServe).mockResolvedValue({ started: true, warning: null } as never);
		vi.mocked(api.streamServe).mockResolvedValue(stream([]));
		fireEvent.click(screen.getByRole('button', { name: 'Start' }));
		await waitFor(() => expect(api.startServe).toHaveBeenCalledWith('test-token', { profile: 'qwen38' }));
	});

	it("drops a link's flags on another profile, and takes them back on the link's own", async () => {
		const flags = '--spec-type draft-mtp --spec-draft-n-max 3';
		const router = renderPage(`/benchmarks/serve?profile=qwen38&spec=${encodeURIComponent(flags)}`);
		await waitFor(() =>
			expect(api.previewServe).toHaveBeenLastCalledWith('test-token', { profile: 'qwen38', spec: flags })
		);
		const pick = async (name: RegExp) => {
			const picker = screen.getByRole('combobox', { name: 'Profile' });
			await waitFor(() => expect(picker).not.toBeDisabled());
			fireEvent.keyDown(picker, { key: 'Enter' });
			fireEvent.click(await screen.findByRole('option', { name }));
		};
		await pick(/^qwen25c/);
		await waitFor(() => expect(api.previewServe).toHaveBeenLastCalledWith('test-token', { profile: 'qwen25c' }));
		expect(screen.getByRole('combobox', { name: 'Speculative decoding' }).textContent).toBe('Default (off)');
		expect(screen.queryByText(/From the link/)).toBeNull();
		expect(router.state.location.search).not.toContain('spec=');
		await pick(/^qwen38/);
		await waitFor(() =>
			expect(api.previewServe).toHaveBeenLastCalledWith('test-token', { profile: 'qwen38', spec: flags })
		);
		expect(new URLSearchParams(router.state.location.search).get('spec')).toBe(flags);
	});

	it('checks an override when it is left, and Start sends nothing while one is wrong (FRM-2)', async () => {
		renderPage();
		const ngl = await screen.findByRole('textbox', { name: /GPU layers/ });
		fireEvent.change(ngl, { target: { value: '-5' } });
		fireEvent.blur(ngl);
		expect(await screen.findByText('Enter a whole number of layers, 0 or more.')).toBeInTheDocument();
		expect(ngl.getAttribute('aria-invalid')).toBe('true');
		expect(screen.getByText('Correct the overrides to see what Start would run.')).toBeInTheDocument();
		const ctx = screen.getByRole('textbox', { name: /Context/ });
		fireEvent.change(ctx, { target: { value: '1.5' } });
		fireEvent.click(screen.getByRole('button', { name: 'Start' }));
		expect(await screen.findByText('Enter a whole number of tokens, 1 or more.')).toBeInTheDocument();
		expect(api.startServe).not.toHaveBeenCalled();
	});

	it('says there is no log output while nothing is served', async () => {
		renderPage();
		expect(await screen.findByText(/No log output yet/)).toBeInTheDocument();
		expect(api.streamServe).not.toHaveBeenCalled();
	});

	it('locks the form to the running profile and shows its state, config, endpoint and links (#972, #976)', async () => {
		vi.mocked(api.checkServe).mockResolvedValue({ running: true, port: 8090, profile: 'qwen38' } as never);
		vi.mocked(api.getLive).mockResolvedValue({
			run: { run_id: 3, config_id: 'bd04a851', started_at: Math.floor(Date.now() / 1000) - 3700 }
		} as never);
		vi.mocked(api.streamServe).mockResolvedValue(
			stream(['llama_model_loader: loaded', 'srv load_model: W slot context exceeds', 'main: starting the main loop'])
		);
		renderPage();
		expect(await screen.findByText('Serving qwen38')).toBeInTheDocument();
		expect(await screen.findByText('Ready')).toBeInTheDocument();
		expect(await screen.findByText('bd04a851')).toBeInTheDocument();
		expect(screen.getByText('1 h 01 min')).toBeInTheDocument();
		expect(screen.getByText('http://127.0.0.1:8090/v1')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Open Live' }).getAttribute('href')).toBe('/benchmarks/live');
		expect(screen.getByRole('link', { name: 'Run tests' }).getAttribute('href')).toBe('/benchmarks/tests');
		expect(screen.getByRole('combobox', { name: 'Profile' })).toBeDisabled();
		expect(screen.getByRole('textbox', { name: /GPU layers/ })).toBeDisabled();
		expect(screen.getAllByText('Stop the server to change the profile or overrides.').length).toBeGreaterThan(0);
		expect(screen.getByText('srv load_model: W slot context exceeds').className).toContain('text-warning');
		expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
		expect(screen.queryByText('Launch preview')).toBeNull();
	});

	it('reads Loading until the server says it takes requests', async () => {
		vi.mocked(api.checkServe).mockResolvedValue({ running: true, port: 8090, profile: 'qwen38' } as never);
		vi.mocked(api.getLive).mockResolvedValue({ run: null } as never);
		vi.mocked(api.streamServe).mockResolvedValue(stream(['load_tensors: offloading 20 layers']));
		renderPage();
		expect(await screen.findByText('Loading')).toBeInTheDocument();
		expect(screen.getByText('Not recorded yet')).toBeInTheDocument();
	});

	it('says when the server cannot be checked, with a way to try again (STA-4)', async () => {
		vi.mocked(api.checkServe).mockRejectedValue('database unavailable');
		renderPage();
		expect(await screen.findByText("Couldn't check the server")).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
	});

	it('warns when the weights file is missing', async () => {
		vi.mocked(api.getServeProfile).mockResolvedValue({
			weights_present: false,
			model: '/models/missing.gguf'
		} as never);
		renderPage();
		expect(await screen.findByText('Weights file not found')).toBeInTheDocument();
		expect(screen.getByText('/models/missing.gguf')).toBeInTheDocument();
	});

	it('shows the server refusal beside Start when Start fails (FBK-1)', async () => {
		vi.mocked(api.startServe).mockRejectedValue({ detail: 'a model is already being served' });
		renderPage();
		await screen.findByText('c98ef02c');
		fireEvent.click(screen.getByRole('button', { name: 'Start' }));
		expect(await screen.findByText(/Couldn't start the server: a model is already being served/)).toBeInTheDocument();
		expect(api.startServe).toHaveBeenCalledWith('test-token', { profile: 'qwen38' });
	});

	it('starts the log stream after a successful Start', async () => {
		vi.mocked(api.startServe).mockResolvedValue({ started: true } as never);
		vi.mocked(api.streamServe).mockResolvedValue(stream(['hello from llama-server']));
		renderPage();
		await screen.findByText('c98ef02c');
		fireEvent.click(screen.getByRole('button', { name: 'Start' }));
		expect(await screen.findByText('hello from llama-server')).toBeInTheDocument();
		await waitFor(() => expect(api.streamServe).toHaveBeenCalledTimes(1));
	});

	it('stops a running server, and says so when Stop fails', async () => {
		vi.mocked(api.checkServe).mockResolvedValue({ running: true, port: 8090, profile: 'qwen38' } as never);
		vi.mocked(api.getLive).mockResolvedValue({ run: null } as never);
		vi.mocked(api.streamServe).mockResolvedValue(stream([]));
		vi.mocked(api.stopServe).mockRejectedValue('not running');
		renderPage();
		fireEvent.click(await screen.findByRole('button', { name: 'Stop server' }));
		expect(await screen.findByText(/Couldn't stop the server: not running/)).toBeInTheDocument();
	});

	it('opens Manage profiles from an edit link, and takes the link off when it closes (B-D8)', async () => {
		vi.mocked(profilesApi.getProfile).mockResolvedValue(entry('qwen38', true) as never);
		const router = renderPage('/benchmarks/serve?edit=qwen38&def.ngl=22');
		expect(await screen.findByRole('heading', { name: 'New version of qwen38' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		// The prefill is unsaved work: closing asks first, and the link stays until it is discarded (FRM-3, OVL-2).
		expect(await screen.findByText('Discard changes?')).toBeInTheDocument();
		expect(router.state.location.search).toContain('edit=qwen38');
		fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
		await waitFor(() => expect(screen.queryByText('Discard changes?')).toBeNull());
		expect((screen.getByRole('textbox', { name: 'GPU layers' }) as HTMLInputElement).value).toBe('22');
		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));
		await waitFor(() => expect(router.state.location.search).not.toContain('edit='));
	});
});

describe('overrideProblem and uptime', () => {
	it('accepts empty and whole numbers in range, and says how to put the rest right', () => {
		expect(overrideProblem('ngl', '')).toBeUndefined();
		expect(overrideProblem('ngl', '0')).toBeUndefined();
		expect(overrideProblem('ctx', '0')).toBe('Enter a whole number of tokens, 1 or more.');
		expect(overrideProblem('threads', 'x')).toBe('Enter a whole number of threads, 1 or more.');
		expect(overrideProblem('parallel', '2')).toBeUndefined();
	});

	it('reads with units', () => {
		expect(uptime(35)).toBe('35 s');
		expect(uptime(240)).toBe('4 min');
		expect(uptime(3960)).toBe('1 h 06 min');
		expect(uptime(-3)).toBe('0 s');
	});
});
