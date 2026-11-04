import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { InterfaceValues } from './interfaceSettingDefs';
import { InterfaceSettings } from './InterfaceSettings';

// #261: the font was committed to the form's values only on blur, so a font
// typed and saved with Enter (a submit before any blur) was not saved, while
// its preview stayed applied.

/** The tab's own state, as Interface.tsx keeps it: each patch merged into the values. */
function Harness({ initial, seen }: { initial: InterfaceValues; seen: (v: InterfaceValues) => void }) {
	const [values, setValues] = useState(initial);
	return (
		<InterfaceSettings
			mode="personal"
			values={values}
			onChange={(patch) =>
				setValues((v) => {
					const next = { ...v, ...patch };
					seen(next);
					return next;
				})
			}
		/>
	);
}

describe('Font Family (#261)', () => {
	it('is in the values as it is typed, before any blur', () => {
		const seen = vi.fn();
		render(<Harness initial={{ fontFamily: 'Inter' }} seen={seen} />);
		fireEvent.change(screen.getByLabelText('Font Family name'), { target: { value: 'Aptos' } });
		expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ fontFamily: 'Aptos' }));
	});

	it('stays open while its box is cleared, and a cleared box means the default', () => {
		const seen = vi.fn();
		render(<Harness initial={{ fontFamily: 'Inter' }} seen={seen} />);
		const box = screen.getByLabelText('Font Family name');
		fireEvent.change(box, { target: { value: '' } });
		expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ fontFamily: null }));
		expect(screen.getByLabelText('Font Family name')).toBe(box);
		fireEvent.change(box, { target: { value: 'Aptos' } });
		expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ fontFamily: 'Aptos' }));
	});
});
