import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DataSection, FormsSection, StatusBadge } from './components';

const inProvider = (node: React.ReactNode) => render(<TooltipProvider>{node}</TooltipProvider>);

describe('/ui components', () => {
	it.each([
		['success', 'Passed'],
		['warning', 'Throttled'],
		['danger', 'Failed']
	] as const)('shows the %s status as the shared Badge variant with an icon', (status, word) => {
		render(<StatusBadge status={status}>{word}</StatusBadge>);
		const badge = screen.getByText(word);
		expect(badge).toHaveAttribute('data-slot', 'badge');
		expect(badge).toHaveAttribute('data-variant', status);
		expect(badge.querySelector('svg[data-icon="inline-start"]')).not.toBeNull();
	});

	it('shows the neutral status as a secondary badge without an icon', () => {
		render(<StatusBadge status="neutral">Not run</StatusBadge>);
		const badge = screen.getByText('Not run');
		expect(badge).toHaveAttribute('data-variant', 'secondary');
		expect(badge.querySelector('svg')).toBeNull();
	});

	it('demonstrates the table as a named scrolling region (DAT-6)', () => {
		inProvider(<DataSection />);
		const region = screen.getByRole('region', { name: 'Runs' });
		expect(within(region).getByRole('table')).toBeInTheDocument();
	});

	it('demonstrates a native select beside the shared one (FRM-4)', () => {
		inProvider(<FormsSection />);
		const native = screen.getByRole('combobox', { name: 'Native select' });
		expect(native.tagName).toBe('SELECT');
		expect(screen.getByRole('combobox', { name: 'Shared Select, compact' }).tagName).toBe('BUTTON');
	});
});
