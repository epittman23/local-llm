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

	it('is the shared field, named by a visible label when given an id, and adds what is typed on Enter (#983, #1057)', () => {
		const onAdd = vi.fn();
		render(
			<>
				<label htmlFor="tags">Tags</label>
				<Tags id="tags" tags={[]} onAdd={onAdd} onDelete={vi.fn()} />
			</>
		);
		const field = screen.getByRole('combobox', { name: 'Tags' });
		expect(field).toHaveAttribute('data-slot', 'input');
		fireEvent.change(field, { target: { value: 'stats' } });
		fireEvent.keyDown(field, { key: 'Enter' });
		expect(onAdd).toHaveBeenCalledWith('stats');
		expect(field).toHaveValue('');
	});

	it('closes its suggestions when the field is left, so Tab moves on', () => {
		render(<Tags tags={[]} suggestionTags={['beta']} onAdd={vi.fn()} onDelete={vi.fn()} />);
		const field = screen.getByRole('combobox', { name: 'Add a tag' });
		fireEvent.focus(field);
		expect(screen.getByRole('option', { name: 'beta' })).toBeInTheDocument();
		fireEvent.blur(field);
		expect(screen.queryByRole('option', { name: 'beta' })).toBeNull();
	});
});
