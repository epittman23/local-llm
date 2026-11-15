import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TagSelector, ViewSelector } from './FilterSelects';

describe('TagSelector', () => {
	it('is named by what it filters, then its value (A11Y-2)', () => {
		render(<TagSelector value="" tags={['local']} name="Source" placeholder="All sources" onChange={vi.fn()} />);
		expect(screen.getByRole('button', { name: 'Source: All sources' })).toBeVisible();
	});

	it('reads "Tag: All tags" with nothing chosen, never "Tag: Tag"', () => {
		render(<TagSelector value="" tags={['stats']} onChange={vi.fn()} />);
		expect(screen.getByRole('button', { name: 'Tag: All tags' })).toBeVisible();
	});

	it('defaults its name to Tag and capitalises a chosen tag, with a clear button', () => {
		render(<TagSelector value="stats" tags={['stats']} onChange={vi.fn()} />);
		expect(screen.getByRole('button', { name: 'Tag: stats' })).toBeVisible();
		expect(screen.getByText('stats')).toHaveClass('capitalize');
		expect(screen.getByRole('button', { name: 'Clear tag' })).toBeVisible();
	});
});

describe('ViewSelector', () => {
	it('says what it filters in its visible text too, not a bare "All"', () => {
		render(<ViewSelector value="" onChange={vi.fn()} />);
		const button = screen.getByRole('button', { name: /^View: / });
		expect(button.textContent).toMatch(/^View: /);
	});
});
