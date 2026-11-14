import * as React from 'react';
import { cn } from 'cn';

/**
 * A whole row that is one click target (the interface standard, ACT-7): a
 * list entry with an image or icon, a name and a second line, which opens
 * the item. The shared `Button` is a single-line, fixed-height control and is
 * wrong for this. Hand-written, not shadcn output.
 *
 * It sets no layout of its own beyond the full width: give it `flex`, a gap
 * and padding in `className`. Mark the open or selected row with
 * `aria-current="true"`.
 */
function RowButton({ className, type = 'button', ...props }: React.ComponentProps<'button'>) {
	return (
		<button
			type={type}
			data-slot="row-button"
			className={cn(
				'w-full min-w-0 cursor-pointer rounded-lg text-left text-body transition-colors duration-(--motion-fast) hover:bg-surface-3 aria-[current=true]:bg-surface-3 disabled:pointer-events-none disabled:text-foreground-disabled',
				className
			)}
			{...props}
		/>
	);
}

export { RowButton };
