import { Eye, EyeOff } from 'lucide-react';
import { useEffect } from 'react';
import { Tip } from '@/components/common/Tip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/**
 * Temporary chat on or off, for a new chat (#1080): a toggle whose icon
 * changes with its state, so the state is not carried by a tint alone.
 */
export function TemporaryToggle({
	on,
	disabled,
	onToggle,
	size
}: {
	on: boolean;
	disabled?: boolean;
	onToggle: () => void;
	size: 'icon' | 'icon-sm';
}) {
	return (
		<Tip content={on ? 'Temporary chat is on: it will not be saved' : 'Temporary chat'}>
			<Button
				type="button"
				aria-label="Temporary chat"
				aria-pressed={on}
				disabled={disabled}
				onClick={onToggle}
				variant={on ? 'secondary' : 'ghost'}
				size={size}
			>
				{on ? <EyeOff data-testid="temporary-on" /> : <Eye data-testid="temporary-off" />}
			</Button>
		</Tip>
	);
}

/**
 * What a temporary chat says once it has messages, for as long as it lasts
 * (#1080, FBK-1): it is not saved. A plain badge with an icon, since being
 * temporary is not a status colour (COL-3).
 */
export function TemporaryNotice() {
	return (
		<Badge variant="secondary" data-icon="inline-start" className="h-6">
			<EyeOff aria-hidden />
			Temporary: not saved
		</Badge>
	);
}

/**
 * While `active` (a temporary chat with messages), reloading or closing the
 * page asks first (FRM-3), since it would lose the chat. Not in the desktop
 * app: Electron cancels a prevented unload without asking, so its window
 * would silently refuse to close.
 */
export function useLeaveWarning(active: boolean) {
	useEffect(() => {
		if (!active || 'lllmDesktop' in window) return;
		const ask = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener('beforeunload', ask);
		return () => window.removeEventListener('beforeunload', ask);
	}, [active]);
}
