import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppMark, MARK_CURSOR, MARK_PATHS } from './app-mark';

afterEach(cleanup);

describe('AppMark', () => {
	it('is decorative by default, at 24 px, drawn with the tokens (WRD-3)', () => {
		const { container } = render(<AppMark />);
		const svg = container.querySelector('svg') as SVGElement;
		expect(svg.getAttribute('aria-hidden')).toBe('true');
		expect(svg.getAttribute('role')).toBeNull();
		expect(svg.getAttribute('class')).toContain('size-6');
		const [tile, letters] = Array.from(container.querySelectorAll('path'));
		expect(tile.getAttribute('class')).toBe('fill-surface-1');
		expect(tile.getAttribute('d')).toBe(MARK_PATHS.tile);
		expect(letters.getAttribute('class')).toBe('stroke-foreground-strong');
		expect(letters.getAttribute('d')).toBe(MARK_PATHS.letters);
		expect(container.querySelector('rect')?.getAttribute('class')).toBe('fill-brand');
	});

	it('is an image named by its label when it stands for the name', () => {
		render(<AppMark label="local-llm" size={32} className="extra" />);
		const img = screen.getByRole('img', { name: 'local-llm' });
		expect(img.getAttribute('aria-hidden')).toBeNull();
		expect(img.getAttribute('class')).toContain('size-8');
		expect(img.getAttribute('class')).toContain('extra');
	});

	it('comes at 20 px too', () => {
		const { container } = render(<AppMark size={20} />);
		expect(container.querySelector('svg')?.getAttribute('class')).toContain('size-5');
	});
});

describe('the mark\'s other copies', () => {
	const cursor = Object.entries(MARK_CURSOR)
		.map(([name, value]) => `${name}="${value}"`)
		.join(' ');
	const copies = {
		'the static splash': 'src/layouts/Base.astro',
		'the favicon': 'public/favicon.svg',
		"the desktop app's windows": '../desktop/static/mark.svg'
	};

	for (const [what, path] of Object.entries(copies)) {
		it(`${what} draws the same mark as AppMark`, () => {
			const source = readFileSync(resolve(process.cwd(), path), 'utf8');
			expect(source).toContain(`d="${MARK_PATHS.tile}"`);
			expect(source).toContain(`d="${MARK_PATHS.letters}"`);
			expect(source).toContain(cursor);
		});
	}
});
