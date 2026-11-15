import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A multi-line field that grows with its text (`field-sizing: content`).
 * `rows` is its least height, in lines, on every pointer: on touch it is never
 * under the 44 px target (LAY-3) and never cut to it either, since the size
 * lives here and not in standard.css's unlayered touch rule, which a caller's
 * class could not beat.
 */
function Textarea({ className, rows = 2, style, ...props }: React.ComponentProps<'textarea'>) {
	return (
		<textarea
			data-slot="textarea"
			rows={rows}
			style={{ '--rows': rows, ...style } as React.CSSProperties}
			className={cn(
				'flex field-sizing-content min-h-[calc(var(--rows)*1lh_+_1rem_+_2px)] pointer-coarse:min-h-[max(var(--control-touch),calc(var(--rows)*1lh_+_1rem_+_2px))] w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-body dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
				className
			)}
			{...props}
		/>
	);
}

export { Textarea };
