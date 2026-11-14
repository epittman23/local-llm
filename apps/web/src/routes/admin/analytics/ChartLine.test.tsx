import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChartLine } from './ChartLine';

const DATA: Array<{ date: string; models: Record<string, number> }> = [
	{ date: '2026-01-01', models: { alpha: 10, beta: 30 } },
	{ date: '2026-01-02', models: { alpha: 20, beta: 20 } },
	{ date: '2026-01-03', models: { alpha: 5 } }
];

const renderChart = (data = DATA) =>
	render(<ChartLine data={data} models={['alpha', 'beta']} colors={['#111', '#222']} height={200} />);

const hoverAt = (x: number) => {
	const svg = screen.getByRole('img', { name: 'Messages over time' });
	svg.getBoundingClientRect = () =>
		({ left: 0, width: 1000, top: 0, height: 180, right: 1000, bottom: 180, x: 0, y: 0 }) as DOMRect;
	fireEvent.mouseMove(svg, { clientX: x });
	return svg;
};

describe('ChartLine', () => {
	it('draws one line per model', () => {
		const { container } = renderChart();
		expect(container.querySelectorAll('path')).toHaveLength(2);
	});

	it('labels the x-axis with the first and last dates', () => {
		renderChart();
		expect(screen.getByText('1/1')).toBeTruthy();
		expect(screen.getByText('1/3')).toBeTruthy();
	});

	it('shows no tooltip until the chart is hovered', () => {
		renderChart();
		expect(screen.queryByText('Jan 1, 2026')).toBeNull();
	});

	it('lists each model with its share of the total at the hovered point', () => {
		renderChart();
		hoverAt(0);
		expect(screen.getByText('Jan 1, 2026')).toBeTruthy();
		expect(screen.getByText('alpha')).toBeTruthy();
		expect(screen.getByText(/\(75%\)/)).toBeTruthy();
		expect(screen.getByText(/\(25%\)/)).toBeTruthy();
	});

	it('hides the tooltip when the pointer leaves', () => {
		renderChart();
		const svg = hoverAt(500);
		expect(screen.getByText('Jan 2, 2026')).toBeTruthy();
		fireEvent.mouseLeave(svg);
		expect(screen.queryByText('Jan 2, 2026')).toBeNull();
	});
});
