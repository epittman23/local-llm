import { useCallback, useDeferredValue, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { type CanvasDocument, chatDocuments } from '@/lib/chat/documents';
import type { Message } from '@/lib/chat/history';

export type CanvasState = {
	/** Every document of the branch, oldest first. */
	documents: CanvasDocument[];
	/** The `?canvas=` parameter: the open document's id. */
	openId: string | null;
	doc: CanvasDocument | null;
	/** An id is open, the chat has loaded, and it has no such document (NAV-3). */
	gone: boolean;
	/** A card click or a menu choice pushes a history entry, so Back restores; auto-open replaces. */
	open: (id: string, opts?: { replace?: boolean }) => void;
	close: () => void;
};

/**
 * The canvas's state, kept in the address (CNV-7): `?canvas=<id>`. It reads
 * and writes that one parameter and leaves the page's others alone. `messages`
 * is the branch shown; `loading` is whether the chat is still loading, since
 * until then a missing document may just not have arrived.
 */
export function useCanvas(messages: Message[], loading: boolean): CanvasState {
	const [params, setParams] = useSearchParams();
	const openId = params.get('canvas') || null;
	// Lexing every message for its blocks is not urgent: the reply paints first.
	const deferred = useDeferredValue(messages);
	const documents = useMemo(() => chatDocuments(deferred), [deferred]);
	const doc = useMemo(() => (openId ? (documents.find((d) => d.id === openId) ?? null) : null), [documents, openId]);

	const open = useCallback(
		(id: string, opts?: { replace?: boolean }) =>
			setParams(
				(prev) => {
					const next = new URLSearchParams(prev);
					next.set('canvas', id);
					return next;
				},
				{ replace: opts?.replace ?? false }
			),
		[setParams]
	);
	const close = useCallback(
		() =>
			setParams((prev) => {
				const next = new URLSearchParams(prev);
				next.delete('canvas');
				return next;
			}),
		[setParams]
	);

	return { documents, openId, doc, gone: openId !== null && !loading && doc === null, open, close };
}
