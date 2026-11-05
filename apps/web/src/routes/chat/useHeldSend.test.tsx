// A send made before the page can send waits in the box, then the box is
// submitted again, with what it holds then; another chat drops it (#373).
import { act, renderHook } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useHeldSend } from './useHeldSend';

function setup(ready = false, route = 'new:') {
	const send = vi.fn(() => true);
	const resubmit = vi.fn();
	const props = { ready, route };
	const hook = renderHook(() => useHeldSend(props.ready, props.route, send, resubmit));
	return { send, resubmit, props, ...hook };
}

describe('useHeldSend (#373)', () => {
	it('sends at once when the page can send', () => {
		const { send, resubmit, result } = setup(true);

		expect(result.current('hi', [])).toBe(true);
		expect(send).toHaveBeenCalledWith('hi', []);
		expect(resubmit).not.toHaveBeenCalled();
	});

	it('holds a send, leaving the text in the box, and submits the box again once ready', () => {
		const { send, resubmit, props, result, rerender } = setup();
		let kept: boolean | undefined;
		act(() => {
			kept = result.current('typed early', []);
		});
		expect(kept).toBe(false);
		expect(send).not.toHaveBeenCalled();

		props.ready = true;
		rerender();
		// The box is submitted again, so what it holds then goes: not this hook's copy.
		expect(resubmit).toHaveBeenCalledTimes(1);
		expect(send).not.toHaveBeenCalled();
		rerender();
		expect(resubmit).toHaveBeenCalledTimes(1);
	});

	it('waits one render after ready, so what an effect sets as the models land (their default tools) is in', () => {
		const seen: boolean[] = [];
		const { result, rerender } = renderHook(
			({ ready }) => {
				// Like ChatPage's defaults effect: it runs in the same commit as the pick.
				const [defaultsIn, setDefaultsIn] = useState(false);
				useEffect(() => {
					if (ready) setDefaultsIn(true);
				}, [ready]);
				return useHeldSend(
					ready,
					'new:',
					() => true,
					() => seen.push(defaultsIn)
				);
			},
			{ initialProps: { ready: false } }
		);
		act(() => {
			result.current('typed early', []);
		});

		rerender({ ready: true });
		expect(seen).toEqual([true]);
	});

	it('drops a held send when the route moves to another chat', () => {
		const { resubmit, props, result, rerender } = setup();
		act(() => {
			result.current('meant for a new chat', []);
		});

		props.route = 'c2';
		rerender();
		props.ready = true;
		rerender();
		expect(resubmit).not.toHaveBeenCalled();
	});

	it('holds one send however often Enter is pressed', () => {
		const { resubmit, props, result, rerender } = setup();
		act(() => {
			result.current('one', []);
			result.current('one', []);
		});

		props.ready = true;
		rerender();
		expect(resubmit).toHaveBeenCalledTimes(1);
	});
});
