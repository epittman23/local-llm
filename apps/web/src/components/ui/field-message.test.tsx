import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FieldMessage, fieldProps } from './field-message';

function Field({ error, help }: { error?: string; help?: string }) {
	return (
		<div>
			<label htmlFor="name">Name</label>
			<input id="name" {...fieldProps('name-note', { error, help })} />
			<FieldMessage id="name-note" error={error} help={help} />
		</div>
	);
}

describe('FieldMessage', () => {
	it('renders nothing, and the field names nothing, without help or an error', () => {
		const { container } = render(<Field />);
		expect(container.querySelector('[data-slot="field-message"]')).toBeNull();
		const input = screen.getByRole('textbox', { name: 'Name' });
		expect(input).not.toHaveAttribute('aria-describedby');
		expect(input).not.toHaveAttribute('aria-invalid');
	});

	it('shows the help, muted and tied to the field, and not as an alert', () => {
		render(<Field help="Shown in the model picker." />);
		const input = screen.getByRole('textbox', { name: 'Name' });
		expect(input).toHaveAccessibleDescription('Shown in the model picker.');
		expect(input).not.toHaveAttribute('aria-invalid');
		expect(screen.queryByRole('alert')).toBeNull();
		expect(screen.getByText('Shown in the model picker.')).toHaveClass('text-foreground-muted');
	});

	it('puts an error in the help’s place: announced, in the danger colour with an icon, and the field invalid', () => {
		render(<Field help="Shown in the model picker." error="Enter a name for this model." />);
		const input = screen.getByRole('textbox', { name: 'Name' });
		expect(input).toHaveAccessibleDescription('Enter a name for this model.');
		expect(input).toHaveAttribute('aria-invalid', 'true');
		const alert = screen.getByRole('alert');
		expect(alert).toHaveClass('text-danger');
		expect(alert.querySelector('svg[aria-hidden]')).not.toBeNull();
		expect(screen.queryByText('Shown in the model picker.')).toBeNull();
	});
});
