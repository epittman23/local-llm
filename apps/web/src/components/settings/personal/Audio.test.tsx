import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConfigStore } from '@/lib/stores/configStore';
import Audio from './Audio';

const user = vi.hoisted(() => ({
	settings: { audio: { stt: { language: 'en' }, tts: { playbackRate: 1 } }, responseAutoPlayback: false },
	update: vi.fn()
}));
vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => user }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function mount() {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<Audio />
		</QueryClientProvider>
	);
}

beforeEach(() => {
	user.update.mockReset();
	user.update.mockResolvedValue({});
	useConfigStore.setState({ config: { name: 'x', version: '1', audio: { tts: { engine: '' } } } } as never);
});
afterEach(cleanup);

describe('Audio (#951, #1003)', () => {
	it('names its sections in words, and saves the form on request', async () => {
		mount();
		expect(screen.getByRole('heading', { name: 'Speech to text' })).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Read aloud' })).toBeInTheDocument();
		const language = screen.getByRole('textbox', { name: 'Speech-to-Text Language' });
		expect(language).toHaveValue('en');
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
		fireEvent.change(language, { target: { value: 'de' } });
		expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
		expect(language).toHaveValue('en');
		fireEvent.change(language, { target: { value: 'de' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(user.update).toHaveBeenCalled());
		expect(user.update.mock.calls[0][0].audio.stt).toEqual({ engine: undefined, language: 'de' });
	});

	it('saves Auto-Playback at once, labelled as such, and says Saved beside it', async () => {
		mount();
		expect(screen.getByText(/Saved as soon as you switch it/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('switch', { name: 'Auto-Playback Response' }));
		await waitFor(() => expect(user.update).toHaveBeenCalledWith({ responseAutoPlayback: true }));
		expect(await screen.findByText('Saved')).toBeInTheDocument();
	});
});
