import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { OutcomeBadgesDemo, SparklineTileDemo, StickyTableDemo, WorkflowTabsDemo } from './benchmarksDemos';

describe('the Benchmarks demos on /ui', () => {
	it('shows every graded outcome as its badge, in its colour', () => {
		const { container } = render(<OutcomeBadgesDemo />);
		const badges = [...container.querySelectorAll('[data-slot=badge]')];
		expect(badges.map((b) => b.textContent)).toEqual([
			'passed',
			'assert failed',
			'error',
			'timed out',
			'no code',
			'skipped'
		]);
		expect(badges.map((b) => b.getAttribute('data-outcome'))).toContain('fail_timeout');
	});

	it('keeps a long table’s headings and first column in view inside a named region', () => {
		render(<StickyTableDemo />);
		const region = screen.getByRole('region', { name: 'Failures, invented' });
		const table = within(region).getByRole('table');
		expect(table).toHaveAttribute('data-sticky-header');
		expect(within(region).getAllByRole('row')).toHaveLength(25);
		expect(within(region).getByRole('columnheader', { name: 'Reasoning, characters' })).toBeTruthy();
	});

	it('groups the workflow’s tabs and ends the strip with the chip in both its looks', () => {
		render(
			<MemoryRouter initialEntries={['/ui']}>
				<WorkflowTabsDemo />
			</MemoryRouter>
		);
		const nav = screen.getByRole('navigation', { name: 'Benchmarks, demo' });
		expect(within(nav).getByRole('link', { name: 'Serve' })).toHaveAttribute('aria-current', 'page');
		expect(within(nav).getAllByRole('link')).toHaveLength(8);
		const [busy, idle] = screen.getAllByRole('status');
		expect(within(busy).getByRole('link')).toHaveTextContent('Serving demo-model · demo1a2b');
		expect(idle).toHaveTextContent('Nothing running');
		expect(within(idle).queryByRole('link')).toBeNull();
	});

	it('draws a key figure’s sparkline as one named picture', () => {
		render(<SparklineTileDemo />);
		const tile = screen.getByRole('region', { name: 'Peak VRAM, demo' });
		expect(within(tile).getByText('5,080 MiB')).toBeTruthy();
		expect(within(tile).getByRole('img').getAttribute('aria-label')).toMatch(/^Peak VRAM over 10 samples/);
	});
});
