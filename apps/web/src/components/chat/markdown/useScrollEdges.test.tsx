// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useScrollEdges } from './useScrollEdges';

function Probe({ text }: { text: string }) {
	const [ref, edges] = useScrollEdges<HTMLDivElement>();
	return (
		<div ref={ref} data-testid="scroller" data-start={edges.start} data-end={edges.end}>
			{text}
		</div>
	);
}

describe('useScrollEdges', () => {
	afterEach(() => vi.restoreAllMocks());

	it('says which ends hide content as the element scrolls and its content changes', async () => {
		const scrollWidth = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(300);
		vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
		const { rerender } = render(<Probe text="short" />);
		const el = screen.getByTestId('scroller');
		expect([el.dataset.start, el.dataset.end]).toEqual(['false', 'false']);
		scrollWidth.mockReturnValue(900);
		rerender(<Probe text="a much longer line" />);
		await act(async () => {}); // the MutationObserver's callback
		expect([el.dataset.start, el.dataset.end]).toEqual(['false', 'true']);
		el.scrollLeft = 600;
		act(() => el.dispatchEvent(new Event('scroll')));
		expect([el.dataset.start, el.dataset.end]).toEqual(['true', 'false']);
		el.scrollLeft = 200;
		act(() => window.dispatchEvent(new Event('resize')));
		expect([el.dataset.start, el.dataset.end]).toEqual(['true', 'true']);
	});
});
