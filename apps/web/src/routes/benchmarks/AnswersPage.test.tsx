import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import * as api from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';
import { AnswersPage, formatRunLabel, recordTime, timingText } from './AnswersPage';

vi.mock('@/lib/apis/benchmarks', async (importOriginal) => {
	const real = await importOriginal<typeof import('@/lib/apis/benchmarks')>();
	return { ...real, getAnswerRuns: vi.fn(), getAnswers: vi.fn(), getAnswerOne: vi.fn() };
});

vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => ({ settings: {} }) }));

const RUN = {
	suite_run_id: 'smoke-1',
	started_at: 1_700_000_000,
	model: 'qwen3.8-27b',
	tier: 'smoke',
	config_id: 'bd04a851',
	passed: 7,
	attempted: 10
};
const ROWS = [
	{ benchmark: 'humanevalplus', item_id: 'HumanEval/1', outcome: 'fail_assert', reason: 'assert f(1) == 2' },
	{ benchmark: 'humanevalplus', item_id: 'HumanEval/2', outcome: 'no_code' },
	{ benchmark: 'mbppplus', item_id: 'Mbpp/3', outcome: 'fail_timeout' }
];
const answerFor = (item_id: string) => ({
	benchmark: 'humanevalplus',
	item_id,
	model: 'qwen3.8-27b',
	config_id: 'bd04a851',
	suite_run_id: 'smoke-1',
	system_name: null,
	outcome: 'fail_assert',
	reason: 'assert f(1) == 2',
	timings: { predicted_n: 412, predicted_ms: 100_000, prompt_n: 1204, prompt_ms: 16_000 },
	prompt: 'Write f.',
	reasoning: null,
	reasoning_chars: 0,
	content: '```python\ndef f(x):\n    return x\n```'
});

let location = '';
function Where() {
	const l = useLocation();
	location = l.pathname + l.search;
	return null;
}

const renderPage = (url = '/benchmarks/answers') =>
	render(
		<MemoryRouter initialEntries={[url]}>
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TooltipProvider>
					<AnswersPage />
				</TooltipProvider>
				<Where />
			</QueryClientProvider>
		</MemoryRouter>
	);

beforeEach(() => {
	useAuthStore.setState({ token: 'test-token' });
	vi.mocked(api.getAnswerRuns).mockResolvedValue({ runs: [RUN] });
	vi.mocked(api.getAnswers).mockResolvedValue({ rows: ROWS } as never);
	vi.mocked(api.getAnswerOne).mockImplementation(async (_t, q) => answerFor(q.item_id) as never);
});

describe('Answers formatting', () => {
	it('labels a run with its record time, configuration, tier and score (B-D7, DAT-5)', () => {
		expect(recordTime(0)).toBe('–');
		expect(formatRunLabel(RUN)).toBe(`${recordTime(1_700_000_000)} · qwen3.8-27b @ bd04a851 · smoke · 7/10`);
		expect(recordTime(1_700_000_000)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
		expect(formatRunLabel({ ...RUN, config_id: null })).not.toContain('@');
	});

	it('reads timings as tokens and rates with units', () => {
		expect(timingText(null)).toBe('');
		expect(timingText({ predicted_n: 412, predicted_ms: 100_000, prompt_n: 1204, prompt_ms: 16_000 })).toBe(
			'412 tokens generated at 4.1 tokens/s · 1,204 prompt tokens in 16.0 s'
		);
		expect(timingText({ predicted_n: 10, predicted_per_second: 3.25 })).toBe('10 tokens generated at 3.3 tokens/s');
	});
});

describe('AnswersPage', () => {
	it('keeps its content from widening the page and labels its table (#1062)', async () => {
		const { container } = renderPage();
		expect((container.firstElementChild as HTMLElement).className).toContain('min-w-0');
		const region = await screen.findByRole('region', { name: 'Answers' });
		expect(region.getAttribute('data-slot')).toBe('table-container');
	});

	it('names both of its selects by their visible labels (A11Y-2, #987)', async () => {
		renderPage();
		expect(await screen.findByRole('combobox', { name: 'Run' })).toBeTruthy();
		expect(screen.getByRole('combobox', { name: 'Outcome' })).toBeTruthy();
	});

	it('opens an answer from the row button, puts it in the address and renders it (#974, #1046, #1111)', async () => {
		renderPage();
		// The newest run is shown by default, and its id goes in the address (NAV-1).
		await waitFor(() => expect(location).toBe('/benchmarks/answers?run=smoke-1'));
		fireEvent.click(await screen.findByRole('button', { name: /HumanEval\/2/ }));
		await waitFor(() =>
			expect(location).toBe('/benchmarks/answers?run=smoke-1&benchmark=humanevalplus&item=HumanEval%2F2')
		);
		expect(await screen.findByText('2 of 3')).toBeInTheDocument();
		expect(
			await screen.findByText('412 tokens generated at 4.1 tokens/s · 1,204 prompt tokens in 16.0 s')
		).toBeInTheDocument();
		expect(screen.getByText('bd04a851')).toBeInTheDocument();
		// Rendered by the chat's Markdown: the fence is a code block, not literal backticks.
		expect(screen.queryByText(/```python/)).toBeNull();
		fireEvent.click(screen.getByRole('radio', { name: 'Raw text' }));
		expect(screen.getByText(/```python/)).toBeInTheDocument();
	});

	it('restores the run and the open answer from the address, and moves with the arrow keys (NAV-1, NAV-5)', async () => {
		renderPage('/benchmarks/answers?run=smoke-1&benchmark=humanevalplus&item=HumanEval%2F1');
		expect(await screen.findByText('1 of 3')).toBeInTheDocument();
		await waitFor(() =>
			expect(api.getAnswerOne).toHaveBeenCalledWith('test-token', expect.objectContaining({ item_id: 'HumanEval/1' }))
		);
		fireEvent.keyDown(screen.getByRole('button', { name: /HumanEval\/1/ }), { key: 'ArrowDown' });
		expect(await screen.findByText('2 of 3')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Next answer' }));
		expect(await screen.findByText('3 of 3')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Next answer' })).toBeDisabled();
		fireEvent.keyDown(screen.getByRole('heading', { name: 'Mbpp/3' }), { key: 'k' });
		expect(await screen.findByText('2 of 3')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Back to the list' }));
		await waitFor(() => expect(location).toBe('/benchmarks/answers?run=smoke-1'));
	});

	it('shows a failed list in place with the server reason and a retry (STA-4, #1050)', async () => {
		vi.mocked(api.getAnswers).mockRejectedValue('run not found');
		renderPage();
		expect(await screen.findByText("Couldn't load answers")).toBeInTheDocument();
		expect(screen.getByText('run not found')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
	});

	it('shows failed runs, and no runs, as what they are', async () => {
		vi.mocked(api.getAnswerRuns).mockRejectedValueOnce('database unavailable');
		const { unmount } = renderPage();
		expect(await screen.findByText("Couldn't load runs")).toBeInTheDocument();
		unmount();
		vi.mocked(api.getAnswerRuns).mockResolvedValue({ runs: [] });
		renderPage();
		expect(await screen.findByText('No runs yet')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'Open Tests' }).getAttribute('href')).toBe('/benchmarks/tests');
	});

	it('says when a filter leaves nothing, and a failed answer in place', async () => {
		vi.mocked(api.getAnswers).mockResolvedValue({ rows: [] } as never);
		renderPage('/benchmarks/answers?filter=pass');
		expect(await screen.findByText('Nothing passed in this run.')).toBeInTheDocument();
		vi.mocked(api.getAnswers).mockResolvedValue({ rows: ROWS } as never);
		vi.mocked(api.getAnswerOne).mockRejectedValue('Not found');
		renderPage('/benchmarks/answers?benchmark=mbppplus&item=Mbpp%2F3');
		expect(await screen.findByText("Couldn't load this answer")).toBeInTheDocument();
	});

	it('on a phone moves focus to the opened answer, and Back returns it to the row (NAV-4)', async () => {
		const mm = vi.fn(() => ({ matches: true }) as unknown as MediaQueryList);
		vi.stubGlobal('matchMedia', mm);
		Element.prototype.scrollIntoView = vi.fn();
		renderPage();
		fireEvent.click(await screen.findByRole('button', { name: /HumanEval\/2/ }));
		await waitFor(() => expect(document.activeElement?.id).toBe('answers-detail-title'));
		fireEvent.click(screen.getByRole('button', { name: 'Back to the list' }));
		await waitFor(() =>
			expect(document.activeElement?.getAttribute('data-row-open')).toBe('humanevalplus::HumanEval/2')
		);
		vi.unstubAllGlobals();
	});
});
