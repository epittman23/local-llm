import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/stores/authStore';
import About, { FORKED_FROM, UPSTREAM_COPYRIGHT } from './About';

vi.mock('@/lib/apis/ollama', () => ({ getOllamaVersion: vi.fn().mockResolvedValue('0.5.1') }));
vi.mock('@/lib/apis/openai', () => ({
	getOpenAIConfig: vi
		.fn()
		.mockResolvedValue({ ENABLE_OPENAI_API: true, OPENAI_API_BASE_URLS: ['https://openrouter.ai/api/v1'] })
}));

const notice = readFileSync(resolve(process.cwd(), '../../NOTICE'), 'utf8');

function mount() {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<About />
		</QueryClientProvider>
	);
}

afterEach(() => {
	cleanup();
	useAuthStore.setState({ user: null });
});

const asRole = (role: string) =>
	useAuthStore.setState({ user: { id: 'u', email: 'a@example.com', name: 'Ada', role, profile_image_url: '' } });

describe('About (#1003)', () => {
	it("repeats NOTICE's copyright line word for word", () => {
		const block = notice.split('The copyright notice those licenses require:')[1].split('The app')[0];
		expect(block.replace(/\s+/g, ' ').trim()).toBe(UPSTREAM_COPYRIGHT);
	});

	it('names the build, the server and its origin, without presenting Open WebUI as the app', async () => {
		mount();
		expect(screen.getByRole('heading', { name: 'local-llm', level: 3 })).toBeInTheDocument();
		expect(
			screen.getByText(`Derived from Open WebUI ${FORKED_FROM} (see NOTICE). Portions remain under its license.`)
		).toBeInTheDocument();
		expect(screen.getByText(UPSTREAM_COPYRIGHT)).toBeInTheDocument();
		expect(screen.getByText(window.location.origin)).toBeInTheDocument();
		expect(screen.getByText(new RegExp(`· ${APP_BUILD_DATE}$`))).toBeInTheDocument();
		expect(await screen.findByText('0.5.1')).toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/Tim J\. Baek|Copyright \(c\) 20[3-9]/);
	});

	it("shows an admin the model connections' addresses", async () => {
		asRole('admin');
		mount();
		expect(await screen.findByText('https://openrouter.ai/api/v1')).toBeInTheDocument();
		expect(screen.getByText('Model connections')).toBeInTheDocument();
	});

	it('leaves the connections out for anyone else, without asking the server', async () => {
		const { getOpenAIConfig } = await import('@/lib/apis/openai');
		vi.mocked(getOpenAIConfig).mockClear();
		asRole('user');
		mount();
		expect(await screen.findByText('0.5.1')).toBeInTheDocument();
		expect(screen.queryByText('Model connections')).toBeNull();
		expect(getOpenAIConfig).not.toHaveBeenCalled();
	});
});
