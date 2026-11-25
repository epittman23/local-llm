import type { ReactNode } from 'react';

/** A line under a view: why it shows less than the whole document, or why it shows nothing. */
export function Note({ children }: { children: ReactNode }) {
	return <div className="text-foreground-muted text-dense px-3 py-2">{children}</div>;
}

export function Loading() {
	return <div className="bg-surface-3 h-16 animate-pulse" role="status" aria-label="Loading" />;
}
