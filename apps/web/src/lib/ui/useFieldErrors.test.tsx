import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useFieldErrors } from './useFieldErrors';

function Form({ onSave, later = false }: { onSave: () => void; later?: boolean }) {
	const [name, setName] = useState('');
	const [id, setId] = useState('');
	const [open, setOpen] = useState(!later);
	const { errors, field, submit, reset } = useFieldErrors(
		{ name: name.trim() ? undefined : 'Enter a name.', id: id.trim() ? undefined : 'Enter an ID.' },
		['name', 'id'] as const
	);
	return (
		<form
			noValidate
			onSubmit={(e) => {
				e.preventDefault();
				if (!id.trim()) setOpen(true);
				if (submit()) onSave();
			}}
		>
			<input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} {...field('name')} />
			{errors.name && <p>{errors.name}</p>}
			{open && <input aria-label="ID" value={id} onChange={(e) => setId(e.target.value)} {...field('id')} />}
			{errors.id && <p>{errors.id}</p>}
			<button type="submit">Save</button>
			<button type="button" onClick={reset}>
				Discard
			</button>
		</form>
	);
}

describe('useFieldErrors (FRM-2)', () => {
	it('says nothing before a field is left, judges it when left, and clears it once put right', () => {
		render(<Form onSave={vi.fn()} />);
		const name = screen.getByRole('textbox', { name: 'Name' });
		expect(screen.queryByText('Enter a name.')).toBeNull();
		fireEvent.blur(name);
		fireEvent.blur(name);
		expect(screen.getByText('Enter a name.')).toBeInTheDocument();
		expect(screen.queryByText('Enter an ID.')).toBeNull();
		fireEvent.change(name, { target: { value: 'Tutor' } });
		expect(screen.queryByText('Enter a name.')).toBeNull();
	});

	it('shows every error on submit, focuses the first wrong field, and sends only a valid form', () => {
		const onSave = vi.fn();
		render(<Form onSave={onSave} />);
		fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Tutor' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(screen.getByText('Enter an ID.')).toBeInTheDocument();
		expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'ID' }));
		expect(onSave).not.toHaveBeenCalled();
		fireEvent.change(screen.getByRole('textbox', { name: 'ID' }), { target: { value: 'tutor' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(onSave).toHaveBeenCalledOnce();
	});

	it('focuses a wrong field that appears only after the submit, and forgets errors on reset', async () => {
		vi.useFakeTimers();
		render(<Form onSave={vi.fn()} later />);
		fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Tutor' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await act(async () => {
			vi.runAllTimers();
		});
		expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'ID' }));
		fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
		expect(screen.queryByText('Enter an ID.')).toBeNull();
		vi.useRealTimers();
	});
});
