// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Katex } from './Katex';

// The CNT-3 variables in standard.css, read from disk as standard.contrast.test.ts does.
const css = readFileSync(resolve(process.cwd(), 'src/styles/standard.css'), 'utf8');

describe('Katex', () => {
	afterEach(() => vi.restoreAllMocks());

	it('leaves black and white math to the theme, which draws them in the text colour where they would vanish (CNT-3)', () => {
		expect(css).toMatch(/\n\.dark \.katex \{\s*--math-black: currentColor;/);
		expect(css).toMatch(/\n:root:not\(\.dark\) \.katex \{\s*--math-white: currentColor;/);
		const { container, rerender } = render(
			<Katex
				content="\color{black}{x} + \textcolor{#000}{y} + \color{White}{w} + \color{#FFF}{v}"
				displayMode={false}
			/>
		);
		const styles = [...container.querySelectorAll('[style*="color:"]')].map((e) => e.getAttribute('style'));
		expect(styles.length).toBeGreaterThan(0);
		for (const style of styles)
			expect(style).toMatch(/(^|;)color:var\(--math-(black|white),(black|#000|White|#FFF)\);/);
		// Other colours, one starting with #000, a background and the text itself are left as written.
		rerender(<Katex content="\color{#0000ff}{z} + \colorbox{black}{w} + \text{color:black;}" displayMode={false} />);
		expect(container.innerHTML).not.toContain('--math-');
		expect(container.innerHTML).toContain('color:#0000ff;');
		expect(container.innerHTML).toContain('background-color:black;');
	});

	it('renders inline math without a scroll region', () => {
		render(<Katex content="e^{i\pi}" displayMode={false} />);
		expect(screen.queryByRole('figure')).toBeNull();
	});

	it('names a display equation as a figure, a tab stop only while it overflows (A11Y-2)', () => {
		const width = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(774);
		vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(318);
		render(<Katex content="\sum_{i=1}^{n} x_i" displayMode />);
		const eq = screen.getByRole('figure', { name: 'Equation' });
		expect(eq).toBe(screen.getByTestId('display-equation'));
		const frame = eq.parentElement as HTMLElement;
		expect(frame.className).toContain('scroll-edges');
		expect(eq.getAttribute('tabindex')).toBe('0');
		expect(frame.hasAttribute('data-clipped-end')).toBe(true);
		expect(frame.hasAttribute('data-clipped-start')).toBe(false);
		width.mockReturnValue(318);
		act(() => window.dispatchEvent(new Event('resize')));
		expect(eq.getAttribute('tabindex')).toBeNull();
		expect(screen.getByRole('figure', { name: 'Equation' })).toBe(eq);
		expect(frame.hasAttribute('data-clipped-end')).toBe(false);
	});

	it('shows the source when KaTeX throws', async () => {
		const katex = (await import('katex')).default;
		vi.spyOn(katex, 'renderToString').mockImplementation(() => {
			throw new Error('bad');
		});
		render(<Katex content="\bad" displayMode />);
		expect(screen.getByText('\\bad').tagName).toBe('CODE');
	});
});
