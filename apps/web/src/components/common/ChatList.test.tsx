import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ChatList } from './ChatList';

const rows = [{ id: 'c1', title: 'First chat', updated_at: 1700000000 }];

describe('ChatList', () => {
	it('sorts by the column whose header is pressed', () => {
		const onSort = vi.fn();
		render(
			<MemoryRouter>
				<ChatList chatList={rows} onSort={onSort} orderBy="title" direction="asc" />
			</MemoryRouter>
		);
		fireEvent.click(screen.getByRole('button', { name: 'Title' }));
		fireEvent.click(screen.getByRole('button', { name: 'Updated at' }));
		expect(onSort.mock.calls).toEqual([['title'], ['updated_at']]);
	});

	it('shows plain headers when no sort handler is given', () => {
		render(
			<MemoryRouter>
				<ChatList chatList={rows} />
			</MemoryRouter>
		);
		expect(screen.queryByRole('button', { name: 'Title' })).toBeNull();
		expect(screen.getByText('Title')).toBeInTheDocument();
	});
});
