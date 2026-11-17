import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OUTCOMES, OutcomeBadge, outcomeLabel } from './OutcomeBadge';

describe('OutcomeBadge (DAT-3, COL-3, #975)', () => {
	it.each([
		['pass', 'passed', 'success'],
		['fail_assert', 'assert failed', 'danger'],
		['fail_error', 'error', 'danger'],
		['fail_timeout', 'timed out', 'danger'],
		['no_code', 'no code', 'danger'],
		['skipped', 'skipped', 'secondary']
	])('shows %s as "%s" in the %s colour', (outcome, label, variant) => {
		render(<OutcomeBadge outcome={outcome} />);
		const badge = screen.getByText(label);
		expect(badge.getAttribute('data-variant')).toBe(variant);
		expect(badge.getAttribute('data-outcome')).toBe(outcome);
	});

	it('marks a status with an icon as well as its colour, and leaves a neutral state without one', () => {
		const { container, rerender } = render(<OutcomeBadge outcome="fail_assert" />);
		expect(container.querySelector('svg[data-icon="inline-start"]')).toBeTruthy();
		rerender(<OutcomeBadge outcome="skipped" />);
		expect(container.querySelector('svg')).toBeNull();
	});

	it('shows an outcome it does not know as its own word, neutral', () => {
		render(<OutcomeBadge outcome="refused" />);
		expect(screen.getByText('refused').getAttribute('data-variant')).toBe('secondary');
		expect(outcomeLabel('refused')).toBe('refused');
		expect(outcomeLabel('fail_timeout')).toBe('timed out');
	});

	it('covers the six outcomes of the database check constraint', () => {
		expect(Object.keys(OUTCOMES).sort()).toEqual(
			['fail_assert', 'fail_error', 'fail_timeout', 'no_code', 'pass', 'skipped'].sort()
		);
	});
});
