import { Lock } from 'lucide-react';
import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';

/** Ports common/AccessButton.svelte: the lock-icon "Access" button that opens the modal. */
export function AccessButton({
	label = 'Access',
	...props
}: { label?: string } & Omit<ComponentProps<typeof Button>, 'children'>) {
	return (
		<Button type="button" variant="outline" size="sm" {...props}>
			<Lock />
			<span>{label}</span>
		</Button>
	);
}
