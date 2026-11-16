import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import Audio from './Audio';

// A save loads the local Whisper model only when it changes; the model
// field's "Update model" button asks for it to be loaded anyway, since that
// is what the button is for (#342). A model that cannot load is refused with
// a message saying so.

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({
	toast: Object.assign(vi.fn(), { error: toastError, success: vi.fn(), info: vi.fn(), warning: vi.fn() })
}));

const CONFIG = {
	tts: { ENGINE: '', VOICE: '', MODEL: '', SPLIT_ON: 'punctuation', OPENAI_PARAMS: {} },
	stt: { ENGINE: '', WHISPER_MODEL: 'base', SUPPORTED_CONTENT_TYPES: [], ALLOWED_EXTENSIONS: [] }
};

let updates: Record<string, unknown>[] = [];
let answer: () => Response = () => new Response(JSON.stringify(CONFIG), { status: 200 });
let stored: typeof CONFIG = CONFIG;

beforeEach(() => {
	updates = [];
	stored = CONFIG;
	answer = () => new Response(JSON.stringify(CONFIG), { status: 200 });
	toastError.mockReset();
	useAuthStore.setState({ token: 't' } as never);
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
		if (String(url).endsWith('/audio/config/update')) {
			updates.push(JSON.parse(String(init?.body)));
			return answer();
		}
		if (String(url).endsWith('/audio/config')) return new Response(JSON.stringify(stored), { status: 200 });
		return new Response(JSON.stringify({}), { status: 200 });
	});
});

afterEach(() => vi.restoreAllMocks());

const renderPage = async () => {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<Audio />
		</QueryClientProvider>
	);
	return screen.findByRole('button', { name: 'Update model' });
};

describe('Audio settings and the Whisper model', () => {
	it('"Update model" asks the server to load the model; Save does not', async () => {
		fireEvent.click(await renderPage());
		await waitFor(() => expect(updates).toHaveLength(1));
		expect(updates[0].LOAD_WHISPER_MODEL).toBe(true);

		// Save waits for a change (FRM-3).
		fireEvent.change(screen.getByLabelText('Supported MIME Types'), { target: { value: 'audio/wav' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(updates).toHaveLength(2));
		expect(updates[1]).not.toHaveProperty('LOAD_WHISPER_MODEL');
	});

	it('says why when the model cannot load', async () => {
		answer = () =>
			new Response(JSON.stringify({ detail: 'The Whisper model "base" could not be loaded' }), { status: 400 });
		fireEvent.click(await renderPage());
		await waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(String(toastError.mock.calls[0][0])).toContain('could not be loaded');
	});
});

describe('Audio: Additional Parameters must be a JSON object (FRM-2)', () => {
	const openai = { ...CONFIG, tts: { ...CONFIG.tts, ENGINE: 'openai', OPENAI_API_BASE_URL: 'http://tts' } };

	it('says so under the field and focuses it; nothing is sent until they are put right', async () => {
		stored = openai;
		await renderPage();
		const params = await screen.findByLabelText('Additional Parameters');
		fireEvent.change(params, { target: { value: '[1,2]' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(params).toHaveAttribute('aria-invalid', 'true');
		expect(params).toHaveAccessibleDescription('Invalid JSON format for Parameters');
		await waitFor(() => expect(params).toHaveFocus());
		expect(toastError).not.toHaveBeenCalled();
		expect(updates).toHaveLength(0);

		fireEvent.change(params, { target: { value: '{"speed":1.25}' } });
		expect(params).not.toHaveAttribute('aria-invalid');
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(updates).toHaveLength(1));
		expect((updates[0].tts as Record<string, unknown>).OPENAI_PARAMS).toEqual({ speed: 1.25 });
	});

	it('another engine hides the field, so its problem is said in a toast', async () => {
		stored = openai;
		await renderPage();
		fireEvent.change(await screen.findByLabelText('Additional Parameters'), { target: { value: '[1,2]' } });
		fireEvent.change(screen.getByLabelText('Text-to-Speech Engine'), { target: { value: 'elevenlabs' } });

		await waitFor(() => expect(toastError).toHaveBeenCalledWith('Invalid JSON format for Parameters'));
		expect(screen.queryByLabelText('Additional Parameters')).toBeNull();
		expect(updates).toHaveLength(0);
	});
});
