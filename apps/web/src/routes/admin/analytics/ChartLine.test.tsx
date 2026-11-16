import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axisTop, ChartLine } from './ChartLine';

const DATA: Array<{ date: string; models: Record<string, number> }> = [
	{ date: '2026-01-01', models: { alpha: 10, beta: 30 } },
	{ date: '2026-01-02', models: { alpha: 20, beta: 20 } },
	{ date: '2026-01-03', models: { alpha: 5 } }
];

const renderChart = (data = DATA) =>
	render(<ChartLine data={data} models={['alpha', 'beta']} colors={['#111', '#222']} height={200} />);

const hoverAt = (x: number) => {
	const svg = screen.getByRole('img', { name: /^Messages per day/ });
	svg.getBoundingClientRect = () =>
		({ left: 0, width: 1000, top: 0, height: 180, right: 1000, bottom: 180, x: 0, y: 0 }) as DOMRect;
	fireEvent.mouseMove(svg, { clientX: x });
	return svg;
};

describe('ChartLine', () => {
	it('draws one line per model', () => {
		const { container } = renderChart();
		expect(container.querySelectorAll('svg[role="img"] path')).toHaveLength(2);
		expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
			'Messages per day, 3 days: 85 messages across 2 models'
		);
	});

	it('strokes each line with the colour it was given as a style, so CSS variables follow the theme', () => {
		const { container } = render(
			<ChartLine data={DATA} models={['alpha', 'beta']} colors={['var(--series-1)', 'var(--series-2)']} height={200} />
		);
		const paths = [...container.querySelectorAll<SVGPathElement>('svg[role="img"] path')];
		expect(paths.map((p) => p.style.stroke)).toEqual(['var(--series-1)', 'var(--series-2)']);
	});

	it('draws the crosshair and tooltip in the standard’s divider, surface and muted text (COL-1)', () => {
		const { container } = renderChart();
		hoverAt(0);
		expect(container.querySelector('line[data-crosshair]')?.getAttribute('class')).toBe('stroke-border-divider');
		expect(container.querySelector('circle')?.style.fill).toBe('#111');
		const tooltip = screen.getByText('Jan 1, 2026');
		expect(tooltip.className).toContain('text-foreground-muted');
		expect(tooltip.parentElement?.className).toContain('bg-surface-2');
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
		expect(screen.getAllByText('alpha').length).toBe(2);
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

	it('names each line in a legend, with its colour', () => {
		render(
			<ChartLine
				data={DATA}
				models={['alpha', 'beta']}
				colors={['var(--series-1)', 'var(--series-2)']}
				labelOf={(k) => k.toUpperCase()}
			/>
		);
		const legend = screen.getByRole('list', { name: 'Legend' });
		const items = within(legend).getAllByRole('listitem');
		expect(items.map((li) => li.textContent)).toEqual(['ALPHA', 'BETA']);
		expect((items[0].firstElementChild as HTMLElement).style.background).toBe('var(--series-1)');
	});

	it('draws a titled y axis with three round ticks', () => {
		const { container } = renderChart();
		expect(screen.getByText('Messages per day')).toBeTruthy();
		expect([...container.querySelectorAll('line[data-tick]')].map((l) => l.getAttribute('data-tick'))).toEqual([
			'40',
			'20',
			'0'
		]);
		expect(screen.getByText('40')).toBeTruthy();
	});

	it('gives every value to the keyboard in a table (DAT-1)', () => {
		renderChart();
		const toggle = screen.getByRole('button', { name: 'Show as table' });
		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		fireEvent.click(toggle);
		const table = screen.getByRole('table');
		expect(within(table).getAllByRole('row')).toHaveLength(4);
		expect(within(table).getByText('Jan 3, 2026').closest('tr')?.textContent).toBe('Jan 3, 202650');
		fireEvent.click(screen.getByRole('button', { name: 'Hide table' }));
		expect(screen.queryByRole('table')).toBeNull();
	});

	it('opens the tooltip away from the nearer edge, so it stays inside the chart', () => {
		renderChart();
		hoverAt(900);
		const box = screen.getByText('Jan 3, 2026').parentElement?.parentElement as HTMLElement;
		expect(box.style.right).toBe('10%');
		expect(box.style.left).toBe('');
		hoverAt(100);
		const left = screen.getByText('Jan 1, 2026').parentElement?.parentElement as HTMLElement;
		expect(left.style.left).toBe('10%');
	});

	it('labels an hourly series by the hour', () => {
		render(
			<ChartLine
				data={[
					{ date: '2026-01-01 10:00', models: { a: 1 } },
					{ date: '2026-01-01 11:00', models: { a: 3 } }
				]}
				models={['a']}
				colors={['#111']}
			/>
		);
		expect(screen.getByText('Messages per hour')).toBeTruthy();
	});
});

describe('axisTop', () => {
	it('rounds up to a figure whose half is whole', () => {
		expect(axisTop(1)).toBe(2);
		expect(axisTop(3)).toBe(4);
		expect(axisTop(30)).toBe(40);
		expect(axisTop(52)).toBe(60);
		expect(axisTop(95)).toBe(100);
		expect(axisTop(1000)).toBe(1000);
	});
});
