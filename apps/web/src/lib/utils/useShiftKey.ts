import { useEffect, useState } from 'react';

/**
 * True while Shift is held. The workspace lists use it to swap each row's
 * copy/menu controls for a one-click delete, as the Svelte pages do. Cleared on
 * window blur so alt-tabbing away with Shift down doesn't leave it stuck on.
 */
export function useShiftKey(): boolean {
	const [shift, setShift] = useState(false);
	useEffect(() => {
		const down = (e: KeyboardEvent) => e.key === 'Shift' && setShift(true);
		const up = (e: KeyboardEvent) => e.key === 'Shift' && setShift(false);
		const blur = () => setShift(false);
		window.addEventListener('keydown', down);
		window.addEventListener('keyup', up);
		window.addEventListener('blur', blur);
		return () => {
			window.removeEventListener('keydown', down);
			window.removeEventListener('keyup', up);
			window.removeEventListener('blur', blur);
		};
	}, []);
	return shift;
}
