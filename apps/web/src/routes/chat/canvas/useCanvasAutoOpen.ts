import { useEffect, useRef, useState } from 'react';
import { countsForAutoOpen, messageDocuments } from '@/lib/chat/documents';
import type { Message } from '@/lib/chat/history';
import type { CanvasState } from './useCanvas';

/**
 * Opens the canvas by itself when a reply finishes with exactly one new
 * document (docs/plans/canvas.md, C10): a sandbox output, or a fenced html or
 * svg block that qualifies. It fires on `generating` going from true to false
 * in this session, so never on loading or reloading a chat; only for the
 * finished reply, once per message; only when `enabled` (the setting), the
 * window is `lg` or wider (`isLg`), and no document is open already. The
 * address entry is replaced, not pushed, so Back leaves the chat as it was.
 *
 * `history` is the branch shown, oldest first. Returns the id it opened, or
 * null: pass `focusOnOpen={canvas.openId !== autoOpened}` to the panel so a
 * person typing the next message keeps focus. It goes back to null when the
 * canvas closes, so a card click on the same document focuses as usual.
 */
export function useCanvasAutoOpen({
	history,
	generating,
	enabled,
	isLg,
	canvas
}: {
	history: Message[];
	generating: boolean;
	enabled: boolean;
	isLg: boolean;
	canvas: Pick<CanvasState, 'openId' | 'open'>;
}): string | null {
	const latest = useRef({ history, enabled, isLg, canvas });
	latest.current = { history, enabled, isLg, canvas };
	const was = useRef(generating);
	const seen = useRef(new Set<string>());
	const [autoOpened, setAutoOpened] = useState<string | null>(null);

	useEffect(() => {
		const finished = was.current && !generating;
		was.current = generating;
		if (!finished) return;
		const { history, enabled, isLg, canvas } = latest.current;
		const last = [...history].reverse().find((m) => m.role === 'assistant');
		if (!last || seen.current.has(last.id)) return;
		seen.current.add(last.id);
		if (!enabled || !isLg || canvas.openId !== null) return;
		const documents = messageDocuments(last).filter(countsForAutoOpen);
		if (documents.length !== 1) return;
		setAutoOpened(documents[0].id);
		canvas.open(documents[0].id, { replace: true });
	}, [generating]);

	useEffect(() => {
		if (canvas.openId === null) setAutoOpened(null);
	}, [canvas.openId]);

	return autoOpened;
}
