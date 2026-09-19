import type { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Ports common/Tooltip.svelte's common use: wrap an element, show `content` on
 * hover/focus. With empty `content` it renders the child untouched, which is
 * how the Svelte version behaves too (several call sites pass a conditional
 * string that is '' most of the time).
 */
export function Tip({
	content,
	children,
	side
}: {
	content?: ReactNode;
	children: ReactNode;
	side?: 'top' | 'right' | 'bottom' | 'left';
}) {
	if (!content) return <>{children}</>;
	return (
		<Tooltip>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent side={side}>{content}</TooltipContent>
		</Tooltip>
	);
}
