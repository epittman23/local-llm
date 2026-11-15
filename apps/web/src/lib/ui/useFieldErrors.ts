import { useRef, useState } from 'react';

/**
 * FRM-2 for a form whose fields are checked in the page (a `noValidate` form,
 * never the browser's bubbles). `problems` is what is wrong now, by field;
 * `order` is the fields in page order. A field's error shows once the person
 * has left it or submitted, and goes as soon as it is put right.
 *
 * Spread `field(name)` on each field (its ref and its blur), show `errors`
 * with `FieldMessage`/`fieldProps`, and call `submit()` before saving: it
 * shows every error, focuses the first wrong field (once it is on the page,
 * for one a click away), and says whether the form may be sent.
 */
export function useFieldErrors<F extends string>(problems: Partial<Record<F, string>>, order: readonly F[]) {
	const [shown, setShown] = useState<ReadonlySet<F>>(() => new Set());
	const elements = useRef(new Map<F, HTMLElement | null>());

	const errors: Partial<Record<F, string>> = {};
	for (const name of order) if (shown.has(name) && problems[name]) errors[name] = problems[name];

	const focus = (name: F, tries = 2) => {
		const element = elements.current.get(name);
		if (element) {
			element.scrollIntoView?.({ block: 'nearest' });
			element.focus();
		} else if (tries > 0) setTimeout(() => focus(name, tries - 1));
	};

	return {
		errors,
		field: (name: F) => ({
			ref: (element: HTMLElement | null) => {
				elements.current.set(name, element);
			},
			onBlur: () => setShown((s) => (s.has(name) ? s : new Set(s).add(name)))
		}),
		submit: (): boolean => {
			setShown(new Set(order));
			const first = order.find((name) => problems[name]);
			if (first) focus(first);
			return first === undefined;
		},
		/** Forget what was shown, as after Discard changes. */
		reset: () => setShown(new Set())
	};
}
