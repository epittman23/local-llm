import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Tags } from './Tags';

describe('Tags', () => {
	it('removes a tag when its chip is pressed', () => {
		const onDelete = vi.fn();
		render(<Tags tags={[{ name: 'alpha' }]} onAdd={vi.fn()} onDelete={onDelete} />);
		fireEvent.click(screen.getByRole('button', { name: /alpha/ }));
		expect(onDelete).toHaveBeenCalledWith('alpha');
	});

	it('shows read-only tags without a remove button when disabled', () => {
		render(<Tags tags={[{ name: 'alpha' }]} disabled onAdd={vi.fn()} onDelete={vi.fn()} />);
		expect(screen.queryByRole('button')).toBeNull();
	});

	it('adds the suggestion that is picked', () => {
		const onAdd = vi.fn();
		render(<Tags tags={[]} suggestionTags={['beta', 'gamma']} onAdd={onAdd} onDelete={vi.fn()} />);
		fireEvent.focus(screen.getByRole('combobox', { name: 'Add a tag' }));
		fireEvent.click(screen.getByRole('option', { name: 'gamma' }));
		expect(onAdd).toHaveBeenCalledWith('gamma');
	});
});
