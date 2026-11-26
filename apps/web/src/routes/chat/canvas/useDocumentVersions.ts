import { useQuery } from '@tanstack/react-query';
import { type FileVersion, listFileVersions } from '@/lib/apis/files/versions';
import type { CanvasDocument } from '@/lib/chat/documents';
import { useAuthStore } from '@/lib/stores/authStore';
import { canEditDocument } from './present';

/** The query key of a document's saved versions, by its original file's id. */
export const versionsKey = (rootId: string) => ['file-versions', rootId] as const;

/**
 * The saved versions of an editable document, oldest first, the original being
 * version 1 (GET /files/{id}/versions); `latest` is the one to show and edit.
 * Only a document the canvas can edit is asked about, so other kinds make no
 * request. A failure leaves `versions` empty: the viewer works with the one
 * file it has, with no version switcher. It is kept until a save invalidates it.
 */
export function useDocumentVersions(
	doc: CanvasDocument | null,
	enabled = true
): {
	versions: FileVersion[];
	latest: FileVersion | null;
	/** Asked and not yet answered: which version is the latest is not known. */
	loading: boolean;
} {
	const token = useAuthStore((s) => s.token) ?? '';
	const rootId = doc && (doc.source.type === 'output' || doc.source.type === 'upload') ? doc.source.fileId : null;
	const asked = enabled && doc !== null && rootId !== null && canEditDocument(doc);
	const query = useQuery({
		queryKey: versionsKey(rootId ?? ''),
		queryFn: ({ signal }) => listFileVersions(token, rootId as string, signal),
		enabled: asked,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false
	});
	const versions = query.data ?? [];
	return {
		versions,
		latest: versions.length ? versions[versions.length - 1] : null,
		loading: asked && query.isPending
	};
}
