import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ListEmptyState, ListMatchCount, ListSearchBar, SortHeaderButton } from './ListChrome';

describe('ListSearchBar', () => {
	it('shows no clear button while the search is empty', () => {
		render(<ListSearchBar value="" onChange={vi.fn()} placeholder="Search prompts" />);
		expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
	});

	it('clears the search when the clear button is pressed', () => {
		const onChange = vi.fn();
		render(<ListSearchBar value="abc" onChange={onChange} placeholder="Search prompts" />);
		fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
		expect(onChange).toHaveBeenCalledWith('');
	});

	it('draws the field as a composite box around the bare input (FRM-1, A11Y-1)', () => {
		const onChange = vi.fn();
		render(<ListSearchBar value="" onChange={onChange} placeholder="Search prompts" />);
		const input = screen.getByRole('textbox', { name: 'Search prompts' });
		const box = input.closest('[data-composite-field]');
		expect(box).not.toBeNull();
		expect(box).toHaveClass('border', 'border-border-control', 'bg-surface-1', 'rounded-lg', 'h-(--control)');
		expect(input).toHaveClass('bg-transparent');
		expect(input.className).not.toMatch(/\bborder\b/);
		fireEvent.change(input, { target: { value: 'variance' } });
		expect(onChange).toHaveBeenCalledWith('variance');
	});
});

describe('SortHeaderButton', () => {
	it('calls onClick when the header is pressed', () => {
		const onClick = vi.fn();
		render(<SortHeaderButton label="Name" active={false} direction="asc" onClick={onClick} className="" />);
		fireEvent.click(screen.getByRole('button', { name: 'Name' }));
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});

describe('ListEmptyState (STA-3)', () => {
	const props = { title: 'No prompts yet', description: 'A prompt is text you reuse.' };

	it('on a fresh list says what belongs here and offers the first step', () => {
		render(<ListEmptyState {...props} action={<button type="button">New prompt</button>} />);
		expect(screen.getByRole('heading', { name: 'No prompts yet' })).toBeVisible();
		expect(screen.getByText('A prompt is text you reuse.')).toBeVisible();
		expect(screen.getByRole('button', { name: 'New prompt' })).toBeVisible();
		expect(screen.queryByText(/Try adjusting/)).toBeNull();
	});

	it('with a search names it, drops the first step, and offers to clear', () => {
		const onClear = vi.fn();
		render(
			<ListEmptyState {...props} action={<button type="button">New prompt</button>} query=" zzzz " onClear={onClear} />
		);
		expect(screen.getByRole('heading', { name: 'Nothing matches “zzzz”' })).toBeVisible();
		expect(screen.queryByText('A prompt is text you reuse.')).toBeNull();
		expect(screen.queryByRole('button', { name: 'New prompt' })).toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
		expect(onClear).toHaveBeenCalledTimes(1);
	});

	it('with only a filter says so and offers to clear the filters', () => {
		render(<ListEmptyState {...props} filtered onClear={vi.fn()} />);
		expect(screen.getByRole('heading', { name: 'Nothing matches these filters' })).toBeVisible();
		expect(screen.getByRole('button', { name: 'Clear filters' })).toBeVisible();
	});
});

describe('ListMatchCount (DAT-2)', () => {
	it('says how many of the whole a narrowed list shows', () => {
		render(<ListMatchCount shown={3} total={6} noun="models" />);
		expect(screen.getByRole('status')).toHaveTextContent('3 of 6 models');
	});

	it('says only how many it shows while the whole is unknown', () => {
		render(<ListMatchCount shown={3} total={null} noun="models" />);
		expect(screen.getByRole('status')).toHaveTextContent('3 models');
	});
});
