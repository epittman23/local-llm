import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { toastFailure } from '@/components/common/failureToast';
import { createFileVersion, type FileVersion, type SavedVersion } from '@/lib/apis/files/versions';
import { useAuthStore } from '@/lib/stores/authStore';
import { TEXT_MAX_BYTES } from './limits';
import { versionsKey } from './useDocumentVersions';

/** A text uses CRLF throughout: the editor works in LF, as a <textarea> does, and the lines are put back on save. */
const usesCrlf = (text: string) => text.includes('\r\n') && !/(^|[^\r])\n/.test(text);

export type DocumentEdit = {
	editing: boolean;
	draft: string;
	setDraft: (value: string) => void;
	/** The draft differs from the text it started from (values, not change events, FRM-3). */
	dirty: boolean;
	saving: boolean;
	/** Why the draft cannot be saved even though it changed, or null. */
	blocked: string | null;
	start: () => void;
	discard: () => void;
	save: () => Promise<void>;
};

/**
 * The edit state of one file (CNV-6): the draft, whether it differs from the
 * text it started from, and saving it as a new version (POST
 * /files/{id}/versions). `fileId` is the file shown (the latest version) and
 * `rootId` the document's original, which the version list is keyed by.
 * `text` is the fetched text, undefined until it has loaded. Editing ends when
 * the file shown changes: whatever moved it has already asked about the draft.
 *
 * `draftOnly` (a fenced block, which has no file to version) keeps the draft and
 * never saves it: `fileId` is then only the key the draft belongs to, and `save` does nothing.
 *
 * A saved version is put in the text cache under its own id, so the canvas
 * shows it at once, and in the version list; `onSaved` hears of it.
 */
export function useDocumentEdit({
	fileId,
	rootId,
	text,
	draftOnly = false,
	onSaved
}: {
	fileId: string | null;
	rootId: string | null;
	text: string | undefined;
	draftOnly?: boolean;
	onSaved: (saved: SavedVersion) => void;
}): DocumentEdit {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const [state, setState] = useState<{ fileId: string; draft: string } | null>(null);
	const [saving, setSaving] = useState(false);
	const busy = useRef(false);
	const editing = state !== null && state.fileId === fileId;
	useEffect(() => {
		if (state && state.fileId !== fileId) setState(null);
	}, [state, fileId]);

	const crlf = text !== undefined && usesCrlf(text);
	const baseline = text === undefined ? '' : crlf ? text.replace(/\r\n/g, '\n') : text;
	const draft = editing ? state.draft : baseline;
	const dirty = editing && draft !== baseline;

	const start = useCallback(() => {
		if (fileId !== null && text !== undefined) setState({ fileId, draft: baseline });
	}, [fileId, text, baseline]);
	const discard = useCallback(() => setState(null), []);
	const setDraft = useCallback((value: string) => setState((s) => (s ? { ...s, draft: value } : s)), []);

	const save = async () => {
		if (draftOnly || !editing || !dirty || fileId === null || rootId === null || busy.current) return;
		if (draft === '') return;
		const content = crlf ? draft.replace(/\n/g, '\r\n') : draft;
		if (new TextEncoder().encode(content).length > TEXT_MAX_BYTES) {
			toast.error(`Too large to save: ${TEXT_MAX_BYTES / 1024} KiB at most`);
			return;
		}
		busy.current = true;
		setSaving(true);
		try {
			const saved = await createFileVersion(token, fileId, content);
			queryClient.setQueryData(['sandbox-output-text', saved.id, TEXT_MAX_BYTES], { text: content, truncated: false });
			const entry: FileVersion = {
				id: saved.id,
				version: saved.meta?.version ?? 2,
				size: saved.meta?.size ?? new TextEncoder().encode(content).length,
				created_at: Math.floor(Date.now() / 1000),
				name: saved.filename ?? ''
			};
			queryClient.setQueryData<FileVersion[]>(versionsKey(rootId), (old) =>
				old && !old.some((v) => v.id === entry.id) ? [...old, entry] : old
			);
			void queryClient.invalidateQueries({ queryKey: versionsKey(rootId) });
			setState(null);
			onSaved(saved);
		} catch (error) {
			// The draft and the editor stay, so nothing typed is lost.
			toastFailure('Could not save the document. Try again.', error);
		} finally {
			busy.current = false;
			setSaving(false);
		}
	};

	return {
		editing,
		draft,
		setDraft,
		dirty,
		saving,
		blocked: dirty && draft === '' ? 'A document can’t be saved empty' : null,
		start,
		discard,
		save
	};
}
