import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelActivityChart, readChartTokens } from './ModelActivityChart';

// chart.js, reduced to the configuration each chart is built with.
const charts = vi.hoisted(() => ({
	configs: [] as { data: { datasets: { backgroundColor: string }[] }; options: never }[]
}));
vi.mock('chart.js/auto', () => ({
	default: class {
		constructor(_canvas: unknown, config: (typeof charts.configs)[number]) {
			charts.configs.push(config);
		}
		destroy() {}
	}
}));

const root = document.documentElement;
const setTokens = (won: string, grid: string) => {
	root.style.setProperty('--series-1', won);
	root.style.setProperty('--series-2', 'oklch(0.7 0.12 40)');
	root.style.setProperty('--foreground', 'oklch(0.95 0.01 90)');
	root.style.setProperty('--foreground-muted', 'oklch(0.78 0.014 150)');
	root.style.setProperty('--border-divider', grid);
	root.style.setProperty('--surface-2', 'oklch(0.275 0.01 160)');
	root.style.setProperty('--font-ui', '"Atkinson Hyperlegible Next Variable", sans-serif');
};

beforeEach(() => {
	charts.configs.length = 0;
	setTokens('oklch(0.7 0.1 235)', 'oklch(0.35 0.01 160)');
});
afterEach(() => {
	root.removeAttribute('style');
	root.className = '';
});

const history = [
	{ date: '2026-11-12', won: 2, lost: 1 },
	{ date: '2026-11-13', won: 1, lost: 3 }
];

describe('readChartTokens', () => {
	it('reads the series, text, grid and surface colours the page defines', () => {
		expect(readChartTokens()).toEqual({
			won: 'oklch(0.7 0.1 235)',
			lost: 'oklch(0.7 0.12 40)',
			text: 'oklch(0.95 0.01 90)',
			muted: 'oklch(0.78 0.014 150)',
			grid: 'oklch(0.35 0.01 160)',
			surface: 'oklch(0.275 0.01 160)',
			font: '"Atkinson Hyperlegible Next Variable", sans-serif'
		});
	});
});

describe('ModelActivityChart', () => {
	it('draws wins and losses in the first two series colours, with themed axes and tooltip (COL-8)', async () => {
		render(<ModelActivityChart history={history} loading={false} weekly={false} />);
		await waitFor(() => expect(charts.configs).toHaveLength(1));
		const config = charts.configs[0] as unknown as {
			data: { datasets: { backgroundColor: string }[] };
			options: {
				plugins: { tooltip: { backgroundColor: string; titleColor: string; borderColor: string } };
				scales: { y: { grid: { color: string }; ticks: { color: string; font: { size: number } } } };
			};
		};
		expect(config.data.datasets.map((d) => d.backgroundColor)).toEqual(['oklch(0.7 0.1 235)', 'oklch(0.7 0.12 40)']);
		expect(config.options.plugins.tooltip.backgroundColor).toBe('oklch(0.275 0.01 160)');
		expect(config.options.plugins.tooltip.titleColor).toBe('oklch(0.95 0.01 90)');
		expect(config.options.scales.y.grid.color).toBe('oklch(0.35 0.01 160)');
		expect(config.options.scales.y.ticks.color).toBe('oklch(0.78 0.014 150)');
		expect(config.options.scales.y.ticks.font.size).toBe(12);
	});

	it('rebuilds in the new colours when the theme changes the root class', async () => {
		render(<ModelActivityChart history={history} loading={false} weekly={false} />);
		await waitFor(() => expect(charts.configs).toHaveLength(1));
		setTokens('oklch(0.5 0.12 235)', 'oklch(0.85 0.01 160)');
		await act(async () => {
			root.className = 'light';
		});
		await waitFor(() => expect(charts.configs).toHaveLength(2));
		expect(charts.configs[1].data.datasets[0].backgroundColor).toBe('oklch(0.5 0.12 235)');
	});

	it('draws nothing while loading or without activity', () => {
		const { getByText, rerender } = render(<ModelActivityChart history={[]} loading={false} weekly={false} />);
		expect(getByText('No activity data')).toBeTruthy();
		rerender(<ModelActivityChart history={history} loading weekly={false} />);
		expect(charts.configs).toHaveLength(0);
	});
});
