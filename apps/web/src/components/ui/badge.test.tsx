import { render, screen } from '@testing-library/react';
import { CircleCheckIcon } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { Badge } from '@/components/ui/badge';

describe('Badge status variants (COL-3, DAT-3)', () => {
	it.each([
		['success', 'text-success'],
		['warning', 'text-warning'],
		['danger', 'text-danger']
	] as const)('%s is the status colour on --surface-3', (variant, colour) => {
		render(<Badge variant={variant}>Word</Badge>);
		const badge = screen.getByText('Word');
		expect(badge).toHaveAttribute('data-variant', variant);
		expect(badge).toHaveClass('bg-surface-3', colour);
	});

	it('carries an icon beside the word', () => {
		render(
			<Badge variant="success">
				<CircleCheckIcon aria-hidden data-icon="inline-start" />
				Passed
			</Badge>
		);
		const badge = screen.getByText('Passed');
		expect(badge.querySelector('svg[data-icon="inline-start"]')).not.toBeNull();
		expect(badge).toHaveClass('has-data-[icon=inline-start]:pl-1.5');
	});
});
