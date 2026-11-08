import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatFile } from '@/lib/chat/history';

type Send = (text: string, files: ChatFile[]) => boolean;

/**
 * The message box's send, held until the page can send (#373). Sent the moment
 * the box appeared, before the page had chosen its models, a message was
 * refused with "Model not selected". Now a send made then leaves the text in
 * the box, and once `ready` the box is submitted again by `resubmit`, with
 * whatever it holds then. Only that a send is waiting is kept, for the chat
 * `route` it was made in: moving to another chat drops it. If a file is still
 * uploading at that moment, the box holds the send in turn and sends it once
 * the upload is done (ChatInput).
 *
 * `waiting` says a send is held while the page cannot send yet, for the box to
 * show, and `cancel` calls it off (#659). `hold` holds a send whatever `ready`
 * is: `?q=` sends in the commit the models land in, before their default tools
 * and switches are set, so it goes through the same wait.
 */
export function useHeldSend(ready: boolean, route: string, send: Send, resubmit: () => void) {
	const [held, setHeld] = useState<{ route: string; go: boolean } | null>(null);
	const latest = useRef(resubmit);
	latest.current = resubmit;
	useEffect(() => {
		if (!held) return;
		if (held.route !== route) return setHeld(null);
		if (!ready) return;
		// One render more first: the models' default tools and toggles are set as the pick lands.
		if (!held.go) return setHeld({ route, go: true });
		setHeld(null);
		latest.current();
	}, [ready, route, held]);
	const hold = useCallback(() => setHeld({ route, go: false }), [route]);
	const cancel = useCallback(() => setHeld(null), []);
	return {
		send: (text: string, files: ChatFile[]) => {
			if (ready) return send(text, files);
			hold();
			return false;
		},
		hold,
		cancel,
		waiting: held?.route === route && !ready
	};
}
