import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { copyToClipboard } from '@/lib/utils';

/** How long a copy control says "Copied" after a success. */
export const COPIED_MS = 1500;

/**
 * FBK-3: every copy control answers the same way. `copy` writes the text and
 * returns whether it reached the clipboard; on success `copied` is true for
 * 1.5 s (the control swaps its icon and says "Copied"), and a refused write
 * (permission denied, an insecure LAN origin) says so in a toast instead of
 * failing silently. `what` names the thing in that toast ("the table").
 */
export function useCopy(): { copied: boolean; copy: (text: string, what?: string) => Promise<boolean> } {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const copy = useCallback(async (text: string, what?: string) => {
		const ok = await copyToClipboard(text);
		if (!ok) {
			toast.error(`Couldn't copy${what ? ` the ${what}` : ''}: the browser blocked clipboard access`);
			return false;
		}
		clearTimeout(timer.current);
		setCopied(true);
		timer.current = setTimeout(() => setCopied(false), COPIED_MS);
		return true;
	}, []);
	return { copied, copy };
}
