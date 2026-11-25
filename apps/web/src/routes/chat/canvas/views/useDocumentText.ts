import { useQuery } from '@tanstack/react-query';
import { getSandboxOutputText } from '@/lib/apis/sandbox';
import type { CanvasDocument } from '@/lib/chat/documents';
import { useAuthStore } from '@/lib/stores/authStore';
import { fileIdOf } from '../present';

/**
 * A file document's start as text, at most `cap` bytes (GET /files/{id}/content),
 * keyed by file id so an upload and an output share the entry. A fenced block
 * has its text already and is never fetched.
 */
export function useDocumentText(doc: CanvasDocument, cap: number) {
	const token = useAuthStore((s) => s.token) ?? '';
	const fileId = fileIdOf(doc);
	return useQuery({
		queryKey: ['sandbox-output-text', fileId, cap],
		queryFn: ({ signal }) => getSandboxOutputText(token, fileId as string, cap, signal),
		enabled: fileId !== null,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false
	});
}
