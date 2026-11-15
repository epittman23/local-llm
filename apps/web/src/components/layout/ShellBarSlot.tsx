import { createContext, type ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';

/**
 * The place in the phone's app bar, after the page's name, where a page puts
 * its own buttons (#1091), so a phone has one header row, not two. AppShell
 * provides the element; null where there is none (outside the shell, before
 * the bar mounts).
 */
export const ShellBarSlotContext = createContext<HTMLElement | null>(null);

/** Renders `children` into the phone bar's slot, or nothing where there is no slot. */
export function ShellBarPortal({ children }: { children: ReactNode }) {
	const slot = useContext(ShellBarSlotContext);
	return slot ? createPortal(children, slot) : null;
}
