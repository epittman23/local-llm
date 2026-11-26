import { useCallback, useDeferredValue, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { type CanvasDocument, chatDocuments, KNOWLEDGE_ID, knowledgeDocument } from '@/lib/chat/documents';
import type { Message } from '@/lib/chat/history';

export type CanvasState = {
	/** Every document of the branch, oldest first. A knowledge file a reply cited is not one of them: it opens by its address. */
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
 * and writes that one parameter and leaves the page's others alone. `file:<uuid>`
 * is a knowledge file the branch cites (read-only, outside the list); any other
 * `file:` id is gone, and the server checks access when the file is fetched. `messages`
 * is the branch shown; `loading` is whether the chat is still loading, since
 * until then a missing document may just not have arrived.
 */
export function useCanvas(messages: Message[], loading: boolean): CanvasState {
	const [params, setParams] = useSearchParams();
	const openId = params.get('canvas') || null;
	// Lexing every message for its blocks is not urgent: the reply paints first.
	const deferred = useDeferredValue(messages);
	const documents = useMemo(() => chatDocuments(deferred), [deferred]);
	const doc = useMemo(() => {
		if (!openId) return null;
		const known = documents.find((d) => d.id === openId);
		if (known) return known;
		const fileId = KNOWLEDGE_ID.exec(openId)?.[1];
		return fileId ? knowledgeDocument(deferred, fileId, documents) : null;
	}, [documents, deferred, openId]);

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
	// A cited file that is also one of the chat's own documents opens as that document: the address moves to its
	// own id (replacing the entry), so the open card and the file menu agree with it.
	useEffect(() => {
		if (doc && openId && doc.id !== openId) open(doc.id, { replace: true });
	}, [doc, openId, open]);
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
