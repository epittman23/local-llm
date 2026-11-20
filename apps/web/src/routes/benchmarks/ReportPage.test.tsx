import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import * as api from '@/lib/apis/benchmarks';
import { useAuthStore } from '@/lib/stores/authStore';
import { figuresNote, ReportPage, reportLabel, reportLabels, reportParts } from './ReportPage';

vi.mock('@/lib/apis/benchmarks', async (importOriginal) => {
	const real = await importOriginal<typeof import('@/lib/apis/benchmarks')>();
	return {
		...real,
		getTestOptions: vi.fn(),
		generateReport: vi.fn(),
		getReportFileText: vi.fn(),
		getAnswerRuns: vi.fn(),
		listReports: vi.fn()
	};
});
vi.mock('@/lib/settings/userSettings', () => ({ useUserSettings: () => ({ settings: {} }) }));

const BASE = '/api/v1/benchmarks/report/files/2026-11-16-abc123';
const MD = [
	'# Measurement report - 2026-11-16T22:49:45Z',
	'',
	'## Headline',
	'',
	'| level | passed |',
	'| --- | --- |',
	'| (none) | 50/60 |',
	'',
	'![pass/fail per item](fig2-matrix.png)',
	'',
	'*Pass/fail per item, under each system prompt*',
	'',
	'## 4. Paired accuracy',
	'',
	'![missing figure](fig9-gone.png)',
	''
].join('\n');
const REPORT = {
	markdown_url: `${BASE}/report.md`,
	figures: [`${BASE}/fig2-matrix.png`],
	date: '2026-11-16-abc123',
	windows: [],
	figures_skipped: '',
	filters: { tier: 'smoke', model: null, benchmark: null },
	created_at: 1_700_000_000
};

let location = '';
function Where() {
	const l = useLocation();
	location = l.pathname + l.search;
	return null;
}

const renderPage = (url = '/benchmarks/report') =>
	render(
		<MemoryRouter initialEntries={[url]}>
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<TooltipProvider>
					<ReportPage />
				</TooltipProvider>
				<Where />
			</QueryClientProvider>
		</MemoryRouter>
	);

describe('report helpers', () => {
	it('takes the title out and places each fetched figure at its reference, with its caption (#973)', () => {
		const { title, parts } = reportParts(MD, { 'fig2-matrix.png': 'blob:one' });
		expect(title).toBe('Measurement report - 2026-11-16T22:49:45Z');
		expect(parts.map((p) => p.kind)).toEqual(['text', 'figure', 'text']);
		expect(parts[1]).toMatchObject({
			kind: 'figure',
			src: 'blob:one',
			alt: 'pass/fail per item',
			caption: 'Pass/fail per item, under each system prompt'
		});
		expect((parts[0] as { text: string }).text.startsWith('\n## Headline')).toBe(true);
		// A figure that could not be fetched stays in the text.
		expect((parts[2] as { text: string }).text).toContain('fig9-gone.png');
	});

	it('says why a report has no figures (B-D4)', () => {
		expect(figuresNote('', 2)).toBe('');
		expect(figuresNote('nothing to plot: x', 3)).toBe('');
		expect(figuresNote('figures disabled by the caller', 0)).toBe(
			'No figures: Generate figures was off for this report.'
		);
		expect(figuresNote('matplotlib is not installed', 0)).toContain('text plots');
		expect(figuresNote('nothing to plot: figures are drawn for A, and these results have neither', 0)).toBe(
			'No figures: figures are drawn for A, and these results have neither.'
		);
		expect(figuresNote('odd', 0)).toBe('No figures: odd.');
	});

	it('labels a saved report by when, what it covers and its figures', () => {
		expect(reportLabel(REPORT)).toMatch(
			/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} · smoke, all benchmarks, all models · 1 figure$/
		);
		expect(reportLabel({ ...REPORT, filters: undefined, created_at: undefined, figures: [] })).toBe(
			'2026-11-16-abc123 · filters not recorded · 0 figures'
		);
	});

	it('names a report written before descriptions by its id, and tells identical labels apart (WRD-2)', () => {
		// The server sends {} for a report with no report.json, and its file time, which copies share.
		const old = (date: string) => ({ ...REPORT, date, filters: {}, created_at: 1_700_000_000, figures: [] });
		expect(reportLabel(old('2026-11-14-78b104'))).toBe('2026-11-14-78b104 · filters not recorded · 0 figures');
		const twin = { ...REPORT, date: '2026-11-16-def456' };
		const labels = reportLabels([REPORT, twin, old('2026-11-14-78b104')]);
		expect(labels.get('2026-11-16-abc123')).toMatch(/ · 1 figure · 2026-11-16-abc123$/);
		expect(labels.get('2026-11-16-def456')).toMatch(/ · 1 figure · 2026-11-16-def456$/);
		expect(labels.get('2026-11-14-78b104')).toBe('2026-11-14-78b104 · filters not recorded · 0 figures');
		expect(new Set(labels.values()).size).toBe(3);
	});
});

describe('ReportPage', () => {
	beforeEach(() => {
		useAuthStore.setState({ token: 'test-token' });
		vi.mocked(api.getTestOptions).mockResolvedValue({
			tiers: ['full', 'smoke'],
			benchmarks: ['humaneval'],
			systems: []
		} as never);
		vi.mocked(api.getAnswerRuns).mockResolvedValue({
			runs: [{ suite_run_id: 'r', started_at: 1, model: 'qwen3.8-27b', tier: 'smoke', passed: 1, attempted: 2 }]
		});
		vi.mocked(api.listReports).mockResolvedValue({ reports: [] });
		vi.mocked(api.getReportFileText).mockResolvedValue(MD);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(new Blob(['png']), { status: 200 }))
		);
		URL.createObjectURL = vi.fn(() => 'blob:fig');
		URL.revokeObjectURL = vi.fn();
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		vi.unstubAllGlobals();
		useAuthStore.setState({ token: null });
		document.documentElement.classList.remove('dark');
	});

	it('names its selects by their visible labels and says what a filter left out means (A11Y-2, #987, #1056)', async () => {
		renderPage();
		expect((await screen.findByRole('combobox', { name: 'Tier' })).textContent).toBe('All tiers');
		expect(screen.getByRole('combobox', { name: 'Benchmark' }).textContent).toBe('All benchmarks');
		expect(screen.getByRole('combobox', { name: 'Model' }).textContent).toBe('All models');
	});

	it('generates in the page theme, opens the report in the address and shows the figure in place (#973, B-D3)', async () => {
		document.documentElement.classList.add('dark');
		vi.mocked(api.generateReport).mockResolvedValue(REPORT);
		renderPage('/benchmarks/report?tier=smoke');
		fireEvent.click(await screen.findByRole('button', { name: 'Generate report' }));
		await waitFor(() =>
			expect(api.generateReport).toHaveBeenCalledWith('test-token', { tier: 'smoke', figures: true, theme: 'dark' })
		);
		expect(
			await screen.findByRole('heading', { name: 'Measurement report - 2026-11-16T22:49:45Z' })
		).toBeInTheDocument();
		await waitFor(() => expect(location).toBe('/benchmarks/report?tier=smoke&report=2026-11-16-abc123'));
		const img = screen.getByRole('img', { name: 'pass/fail per item' });
		expect(img.getAttribute('src')).toBe('blob:fig');
		expect(screen.getByText('Pass/fail per item, under each system prompt')).toBeInTheDocument();
		expect(screen.getByRole('region', { name: /Table: level, passed/ })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Download .md' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Copy markdown' })).toBeInTheDocument();
	});

	it('says why there are no figures', async () => {
		vi.mocked(api.generateReport).mockResolvedValue({
			...REPORT,
			figures: [],
			figures_skipped: 'nothing to plot: figures are drawn for system-prompt comparisons'
		});
		renderPage();
		fireEvent.click(await screen.findByRole('button', { name: 'Generate report' }));
		expect(await screen.findByText('No figures: figures are drawn for system-prompt comparisons.')).toBeInTheDocument();
	});

	it('reopens a saved report from the address, and says when it is gone (B-D4, NAV-3)', async () => {
		vi.mocked(api.listReports).mockResolvedValue({ reports: [REPORT] });
		const { unmount } = renderPage('/benchmarks/report?report=2026-11-16-abc123');
		expect(
			await screen.findByRole('heading', { name: 'Measurement report - 2026-11-16T22:49:45Z' })
		).toBeInTheDocument();
		expect(screen.getByRole('combobox', { name: 'Saved report' })).toBeInTheDocument();
		expect(api.generateReport).not.toHaveBeenCalled();
		unmount();
		renderPage('/benchmarks/report?report=2026-01-01-nope');
		expect(await screen.findByText('This report no longer exists')).toBeInTheDocument();
	});

	it('reopens a report older than the listing by asking for it by id (B-D4)', async () => {
		const older = { ...REPORT, date: '2026-01-02-old000' };
		vi.mocked(api.listReports).mockImplementation(async (_token, id) => ({
			reports: id === older.date ? [older] : [REPORT]
		}));
		renderPage(`/benchmarks/report?report=${older.date}`);
		expect(
			await screen.findByRole('heading', { name: 'Measurement report - 2026-11-16T22:49:45Z' })
		).toBeInTheDocument();
		expect(api.listReports).toHaveBeenCalledWith('test-token', older.date);
		expect(screen.getByRole('combobox', { name: 'Saved report' }).textContent).toContain('smoke');
	});

	it('says when asking for one report by id failed, with a retry', async () => {
		vi.mocked(api.listReports).mockImplementation(async (_token, id) => {
			if (id) throw 'disk unreadable';
			return { reports: [] };
		});
		renderPage('/benchmarks/report?report=2026-01-02-old000');
		expect(await screen.findByText(/disk unreadable/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
	});

	it('says plainly when no results match, and keeps a server error behind Details', async () => {
		vi.mocked(api.generateReport).mockResolvedValue({ ...REPORT, error: 'no results match those filters' });
		renderPage();
		fireEvent.click(await screen.findByRole('button', { name: 'Generate report' }));
		expect((await screen.findByRole('alert')).textContent).toContain('no recorded results match these filters');
		vi.mocked(api.generateReport).mockRejectedValue('scipy missing');
		fireEvent.click(screen.getByRole('button', { name: 'Generate report' }));
		await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('scipy missing'));
	});
});
