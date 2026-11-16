import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { InterfaceSettings } from './InterfaceSettings';
import type { InterfaceValues } from './interfaceSettingDefs';

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

describe('saving at once (#951)', () => {
	it('says Saved beside each kind of row whose setting just saved', () => {
		render(
			<InterfaceSettings
				mode="personal"
				values={{ textScale: 1.2, fontFamily: 'Aptos', chatDirection: 'auto', widescreenMode: true }}
				onChange={() => {}}
				isSaved={(key) => ['textScale', 'fontFamily', 'chatDirection', 'widescreenMode'].includes(key)}
			/>
		);
		const saved = screen.getAllByRole('status').filter((s) => s.textContent === 'Saved');
		expect(saved.length).toBeGreaterThanOrEqual(4);
		expect(screen.getByRole('textbox', { name: 'Font Family name' })).toHaveAttribute('data-slot', 'input');
	});
});

describe('A setting that cycles through its values', () => {
	it('is named by the setting and the value it shows, which a press moves on (WCAG 2.5.3)', () => {
		const seen = vi.fn();
		render(<Harness initial={{ chatDirection: 'auto' }} seen={seen} />);
		const cycle = screen.getByRole('button', { name: 'Chat Direction Auto' });
		expect(cycle).not.toHaveAttribute('aria-description');
		fireEvent.click(cycle);
		expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ chatDirection: 'LTR' }));
		expect(screen.getByRole('button', { name: /^Chat Direction (?!Auto)/ })).toBe(cycle);
	});
});
