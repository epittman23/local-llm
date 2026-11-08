// A send made before the page can send waits in the box, then the box is
// submitted again, with what it holds then; another chat drops it (#373).
// Meanwhile the box says so, and it can be called off; `?q=` goes through the
// same wait (#659).
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

		expect(result.current.send('hi', [])).toBe(true);
		expect(send).toHaveBeenCalledWith('hi', []);
		expect(resubmit).not.toHaveBeenCalled();
	});

	it('holds a send, leaving the text in the box, and submits the box again once ready', () => {
		const { send, resubmit, props, result, rerender } = setup();
		let kept: boolean | undefined;
		act(() => {
			kept = result.current.send('typed early', []);
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
				).send;
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
			result.current.send('meant for a new chat', []);
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
			result.current.send('one', []);
			result.current.send('one', []);
		});

		props.ready = true;
		rerender();
		expect(resubmit).toHaveBeenCalledTimes(1);
	});

	it('says a send is waiting while the page cannot send yet, and not once it can', () => {
		const { props, result, rerender } = setup();
		expect(result.current.waiting).toBe(false);
		act(() => {
			result.current.send('typed early', []);
		});
		expect(result.current.waiting).toBe(true);

		props.ready = true;
		rerender();
		expect(result.current.waiting).toBe(false);
	});

	it('can be called off', () => {
		const { resubmit, props, result, rerender } = setup();
		act(() => {
			result.current.send('typed early', []);
		});
		act(() => result.current.cancel());
		expect(result.current.waiting).toBe(false);

		props.ready = true;
		rerender();
		expect(resubmit).not.toHaveBeenCalled();
	});

	it('no longer says a send is waiting once the route moves to another chat', () => {
		const { props, result, rerender } = setup();
		act(() => {
			result.current.send('meant for a new chat', []);
		});
		props.route = 'c2';
		rerender();
		expect(result.current.waiting).toBe(false);
	});

	it('holds a send made as the models land, so their default tools are in (`?q=`)', () => {
		const seen: boolean[] = [];
		const { rerender } = renderHook(
			({ ready }) => {
				// The defaults effect and the `?q=` effect both run in the commit the pick lands in.
				const [defaultsIn, setDefaultsIn] = useState(false);
				useEffect(() => {
					if (ready) setDefaultsIn(true);
				}, [ready]);
				const held = useHeldSend(
					ready,
					'new:',
					() => true,
					() => seen.push(defaultsIn)
				);
				const { hold } = held;
				useEffect(() => {
					if (ready) hold();
				}, [ready, hold]);
				return held;
			},
			{ initialProps: { ready: false } }
		);

		rerender({ ready: true });
		expect(seen).toEqual([true]);
	});
});
