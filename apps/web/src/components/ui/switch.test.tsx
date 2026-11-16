import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Switch } from './switch';

// Read from disk, not through Vite (its CSS pipeline would hand back processed output).
const css = readFileSync(resolve(process.cwd(), 'src/styles/standard.css'), 'utf8');

describe('Switch, disabled (ACT-5)', () => {
	it('a switch inside a disabled fieldset matches :disabled and gets the disabled look', () => {
		render(
			<fieldset disabled>
				<Switch aria-label="Sign-in with OAuth" checked />
			</fieldset>
		);
		const sw = screen.getByRole('switch', { name: 'Sign-in with OAuth' });
		expect(sw.tagName).toBe('BUTTON');
		// A disabled fieldset disables the <button> inside it, so the browser matches it as
		// :disabled (happy-dom does not compute that; the screenshots check it in Chromium).
		expect(sw.closest('fieldset')?.disabled).toBe(true);
		// Radix only marks its own `disabled`; the fieldset's is reached through :disabled.
		expect(sw).not.toHaveAttribute('data-disabled');
		expect(sw.className).toContain('disabled:cursor-not-allowed');
	});

	it('a switch disabled itself has the same look', () => {
		render(<Switch aria-label="Off" disabled />);
		const sw = screen.getByRole('switch', { name: 'Off' });
		expect(sw).toHaveAttribute('data-disabled');
		expect(sw.className).toContain('data-disabled:cursor-not-allowed');
	});

	it('standard.css styles both kinds of disabled switch the same, by state', () => {
		const disabled = ':root [data-slot="switch"]:is(:disabled, [data-disabled])';
		expect(css).toContain(`${disabled} {\n\tborder-color: var(--border-divider);`);
		expect(css).toContain(`${disabled}[data-state="checked"] {\n\tbackground-color: var(--foreground-disabled);`);
		expect(css).toContain(
			`${disabled}[data-state="unchecked"] [data-slot="switch-thumb"] {\n\tbackground-color: var(--foreground-disabled);`
		);
	});

	it('drops the dead dark-only knob colours (standard.css sets the knob for both states)', () => {
		render(<Switch aria-label="Knob" />);
		const thumb = screen.getByRole('switch', { name: 'Knob' }).querySelector('[data-slot="switch-thumb"]');
		expect(thumb?.className).not.toMatch(/dark:data-(un)?checked:bg-/);
	});
});
