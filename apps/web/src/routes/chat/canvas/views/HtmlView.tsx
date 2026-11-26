import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { errorMessage } from '@/lib/apis/errors';
import { getSandboxOutputHtml } from '@/lib/apis/sandbox';
import { blockDocument, type CanvasDocument } from '@/lib/chat/documents';
import { withHtmlPolicy } from '@/lib/chat/htmlPolicy';
import { useAuthStore } from '@/lib/stores/authStore';
import { HTML_MAX_BYTES } from '../limits';
import { Loading, Note } from './parts';
import { SandboxedHtmlFrame } from './SandboxedHtmlFrame';

/**
 * A page of HTML as a live frame on a themed surround (CNV-4, CNV-5). Its
 * document is one of two, never anything else: a sandbox output's, which the
 * server sends with the content-security policy in front
 * (`getSandboxOutputHtml`), or a fenced block's text with the same policy put
 * in front here. An uploaded page is a person's file, not the model's output
 * of this chat's sandbox: it is never framed and never sent to that route
 * (Source and Download only), so it renders nothing here.
 * `reloads` counts presses of Reload: each remounts the frame, and refetches
 * an output's page.
 */
export function HtmlView({ doc, reloads = 0 }: { doc: CanvasDocument; reloads?: number }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const source = doc.source;
	const fileId = source.type === 'output' ? source.fileId : null;
	const tooLarge = typeof doc.bytes === 'number' && doc.bytes > HTML_MAX_BYTES;
	const page = useQuery({
		queryKey: ['sandbox-output-html', fileId],
		queryFn: ({ signal }) => getSandboxOutputHtml(token, fileId as string, signal),
		enabled: fileId !== null && !tooLarge,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false
	});
	const refetch = page.refetch;
	useEffect(() => {
		if (reloads > 0 && fileId !== null && !tooLarge) void refetch();
	}, [reloads, fileId, tooLarge, refetch]);
	const blockText = source.type === 'block' ? source.text : null;
	const blockHtml = useMemo(() => (blockText === null ? null : withHtmlPolicy(blockDocument(blockText))), [blockText]);

	let html: string | null = null;
	if (blockHtml !== null) html = blockHtml;
	else if (fileId !== null) {
		if (tooLarge) return <Note>Too large to show here; download it instead.</Note>;
		if (page.isError) return <Note>Could not show this page: {errorMessage(page.error)}</Note>;
		if (page.data === undefined) return <Loading />;
		html = page.data;
	}
	if (html === null) return null;
	return (
		<div className="bg-surface-1 h-full p-3">
			<SandboxedHtmlFrame key={reloads} html={html} title={`Preview of ${doc.name}`} />
		</div>
	);
}
