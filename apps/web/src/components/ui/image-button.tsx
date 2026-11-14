import * as React from 'react';
import { cn } from 'cn';

/**
 * A picture that is itself the click target (the interface standard, ACT-8):
 * a profile image you press to change it. The picture fills the button, with
 * no padding. `overlay` (an icon) is shown over a scrim on hover and on
 * keyboard focus; it is decoration, so the button needs an `aria-label`.
 * Hand-written, not shadcn output.
 */
function ImageButton({
	className,
	shape = 'rounded',
	overlay,
	children,
	type = 'button',
	...props
}: React.ComponentProps<'button'> & { shape?: 'circle' | 'rounded'; overlay?: React.ReactNode }) {
	return (
		<button
			type={type}
			data-slot="image-button"
			className={cn(
				'group/image-button relative inline-flex shrink-0 cursor-pointer overflow-hidden border border-border-control disabled:pointer-events-none',
				shape === 'circle' ? 'rounded-full' : 'rounded-panel',
				className
			)}
			{...props}
		>
			{children}
			{overlay && (
				<span
					aria-hidden
					className="absolute inset-0 flex items-center justify-center bg-scrim text-on-scrim opacity-0 transition-opacity duration-(--motion-fast) group-hover/image-button:opacity-100 group-focus-visible/image-button:opacity-100 [&_svg]:size-4"
				>
					{overlay}
				</span>
			)}
		</button>
	);
}

export { ImageButton };
