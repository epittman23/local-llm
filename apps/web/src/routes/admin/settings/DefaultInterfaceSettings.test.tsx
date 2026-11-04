import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { DefaultInterfaceSettings } from './General';

// #261 follow-on: the font box commits as it is typed and stays open, so Clear
// must also start the rows over, or the box keeps showing a font the cleared
// values no longer hold.

function Harness() {
	const [value, setValue] = useState<Record<string, unknown>>({ fontFamily: 'Inter' });
	return (
		<>
			<DefaultInterfaceSettings value={value} onChange={setValue} />
			<output aria-label="draft">{JSON.stringify(value)}</output>
		</>
	);
}

describe('Default Interface Settings', () => {
	it('Clear closes a font box that was typed in, with the font gone', () => {
		render(<Harness />);
		fireEvent.click(screen.getByRole('button', { name: 'Configure Default Interface Settings' }));
		fireEvent.change(screen.getByLabelText('Font Family name'), { target: { value: 'Aptos' } });
		expect(screen.getByLabelText('draft')).toHaveTextContent('"fontFamily":"Aptos"');

		fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

		expect(screen.getByLabelText('draft')).toHaveTextContent('{}');
		expect(screen.queryByLabelText('Font Family name')).toBeNull();
		expect(screen.getByRole('button', { name: 'Font Family: Default' })).toBeInTheDocument();
	});
});
