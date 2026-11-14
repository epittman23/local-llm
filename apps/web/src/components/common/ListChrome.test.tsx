import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ListSearchBar, SortHeaderButton } from './ListChrome';

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
});

describe('SortHeaderButton', () => {
	it('calls onClick when the header is pressed', () => {
		const onClick = vi.fn();
		render(<SortHeaderButton label="Name" active={false} direction="asc" onClick={onClick} className="" />);
		fireEvent.click(screen.getByRole('button', { name: 'Name' }));
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});
