import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { getRAGConfig, updateRAGConfig } from '@/lib/apis/retrieval';
import { useAuthStore } from '@/lib/stores/authStore';
import WebSearch from './WebSearch';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() }) }));
vi.mock('@/lib/apis/retrieval', () => ({ getRAGConfig: vi.fn(), updateRAGConfig: vi.fn() }));
vi.mock('@/lib/settings/useAdminSaved', () => ({ useAdminConfigSaved: () => vi.fn() }));

const web = (over: Record<string, unknown> = {}) => ({
	ENABLE_WEB_SEARCH: false,
	WEB_SEARCH_ENGINE: '',
	SEARXNG_QUERY_URL: '',
	SEARXNG_LANGUAGE: 'all',
	WEB_SEARCH_DOMAIN_FILTER_LIST: [],
	YOUTUBE_LOADER_LANGUAGE: ['en'],
	WEB_LOADER_ENGINE: '',
	WEB_LOADER_CONCURRENT_REQUESTS: 10,
	BYPASS_WEB_SEARCH_EMBEDDING_AND_RETRIEVAL: false,
	WEB_SEARCH_TRUST_ENV: false,
	...over
});

beforeEach(() => {
	vi.clearAllMocks();
	useAuthStore.setState({ token: 't' } as never);
	vi.mocked(updateRAGConfig).mockResolvedValue({} as never);
});

const renderTab = async (stored: Record<string, unknown>) => {
	vi.mocked(getRAGConfig).mockResolvedValue({ web: stored } as never);
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<TooltipProvider>
				<WebSearch />
			</TooltipProvider>
		</QueryClientProvider>
	);
	return (await screen.findByLabelText('Web Search Engine')) as HTMLSelectElement;
};

describe('Web Search: the bundled SearXNG (S5-D6, #1025)', () => {
	it('is preselected with its address when no engine is stored, and Save stores it', async () => {
		const engine = await renderTab(web());
		await waitFor(() => expect(engine.value).toBe('searxng'));
		expect(screen.getByText('SearXNG, bundled with the stack, is preselected. Save to use it.')).toBeInTheDocument();
		expect(screen.getByLabelText(/SearXNG Query URL/)).toHaveValue('http://127.0.0.1:8080/search?q=<query>');
		expect(screen.getByRole('switch', { name: /^Web Search$/ })).not.toBeChecked();
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(updateRAGConfig).toHaveBeenCalledTimes(1));
		expect(vi.mocked(updateRAGConfig).mock.calls[0][1]).toMatchObject({
			web: {
				ENABLE_WEB_SEARCH: false,
				WEB_SEARCH_ENGINE: 'searxng',
				SEARXNG_QUERY_URL: 'http://127.0.0.1:8080/search?q=<query>'
			}
		});
		expect(screen.getByText('Choose the provider used for web search queries.')).toBeInTheDocument();
	});

	it('leaves a stored engine alone, with nothing to save', async () => {
		const engine = await renderTab(web({ WEB_SEARCH_ENGINE: 'brave' }));
		expect(engine.value).toBe('brave');
		expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
		expect(screen.queryByText(/is preselected/)).toBeNull();
	});

	it('lists the engines by name, the bundled one first, under "Select an engine"', async () => {
		const engine = await renderTab(web({ WEB_SEARCH_ENGINE: 'brave' }));
		const options = [...engine.options].map((o) => o.textContent);
		expect(options.slice(0, 2)).toEqual(['Select an engine', 'SearXNG (bundled)']);
		expect(options).toContain('Brave Search');
		expect(options).not.toContain('brave');
	});
});

describe('Web Search: switch help and units (#1023, #1025)', () => {
	it('says what turning each switch on does, whatever its state', async () => {
		await renderTab(web({ WEB_SEARCH_ENGINE: 'brave' }));
		const help = /Send each result page to the model whole/;
		expect(screen.getByText(help)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('switch', { name: /^Bypass Embedding and Retrieval/ }));
		expect(screen.getByText(help)).toBeInTheDocument();
		expect(screen.getByText(/Turn on only if this machine needs a proxy/)).toBeInTheDocument();
		expect(screen.getByLabelText('Timeout (s)')).toBeInTheDocument();
		expect(screen.getByLabelText('YouTube Language')).toBeInTheDocument();
		expect(
			[...(screen.getByLabelText('Web Loader Engine') as HTMLSelectElement).options].map((o) => o.textContent)
		).toContain('External loader server');
	});

	it('edits an engine textarea with the shared field, its hint below it', async () => {
		await renderTab(web({ WEB_SEARCH_ENGINE: 'yandex' }));
		const config = screen.getByLabelText('Yandex Web Search config');
		expect(config.getAttribute('data-slot')).toBe('textarea');
		fireEvent.change(config, { target: { value: '{}' } });
		expect(config).toHaveValue('{}');
	});
});

describe('Web Search: Linkup parameters must be a JSON object (FRM-2)', () => {
	it('says so under the field and focuses it, and sends nothing', async () => {
		await renderTab(web({ WEB_SEARCH_ENGINE: 'linkup', LINKUP_SEARCH_PARAMS: {} }));
		const params = screen.getByLabelText('Parameters');
		fireEvent.change(params, { target: { value: '[1]' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(params).toHaveAttribute('aria-invalid', 'true');
		expect(params).toHaveAccessibleDescription('Invalid JSON format in Linkup Parameters');
		await waitFor(() => expect(params).toHaveFocus());
		expect(updateRAGConfig).not.toHaveBeenCalled();

		fireEvent.change(params, { target: { value: '{"depth":"deep"}' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await waitFor(() => expect(updateRAGConfig).toHaveBeenCalledOnce());
		expect(vi.mocked(updateRAGConfig).mock.calls[0][1]).toMatchObject({
			web: { LINKUP_SEARCH_PARAMS: { depth: 'deep' } }
		});
	});
});
