import { useEffect, useRef, useState } from 'react';
import type { ChatFile } from '@/lib/chat/history';

type Send = (text: string, files: ChatFile[]) => boolean;

/**
 * The message box's send, held until the page can send (#373). Sent the moment
 * the box appeared, before the page had chosen its models, a message was
 * refused with "Model not selected". Now it stays in the box and goes as soon
 * as `ready`, and `sent` then clears the box.
 */
export function useHeldSend(ready: boolean, send: Send, sent: () => void): Send {
	const [held, setHeld] = useState<{ text: string; files: ChatFile[] } | null>(null);
	const latest = useRef({ send, sent });
	latest.current = { send, sent };
	useEffect(() => {
		if (!ready || !held) return;
		setHeld(null);
		if (latest.current.send(held.text, held.files)) latest.current.sent();
	}, [ready, held]);
	return (text, files) => {
		if (ready) return send(text, files);
		setHeld({ text, files });
		return false;
	};
}
