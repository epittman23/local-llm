import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppMark } from './app-mark';

afterEach(cleanup);

describe('AppMark', () => {
	it('is decorative by default, at 24 px, drawn with the tokens (WRD-3)', () => {
		const { container } = render(<AppMark />);
		const svg = container.querySelector('svg') as SVGElement;
		expect(svg.getAttribute('aria-hidden')).toBe('true');
		expect(svg.getAttribute('role')).toBeNull();
		expect(svg.getAttribute('class')).toContain('size-6');
		expect(container.querySelector('rect')?.getAttribute('class')).toBe('fill-surface-1');
		expect(container.querySelector('path')?.getAttribute('class')).toBe('stroke-brand');
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

describe('the static splash', () => {
	it("draws the same mark as AppMark and the favicon, before any script runs", () => {
		const { container } = render(<AppMark />);
		const d = container.querySelector('path')?.getAttribute('d') ?? '';
		expect(d).not.toBe('');
		expect(readFileSync(resolve(process.cwd(), 'src/layouts/Base.astro'), 'utf8')).toContain(`d="${d}"`);
		expect(readFileSync(resolve(process.cwd(), 'public/favicon.svg'), 'utf8')).toContain(`d="${d}"`);
	});
});
