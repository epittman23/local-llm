import { DownloadIcon, ExternalLinkIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { CanvasDocument } from '@/lib/chat/documents';
import { contentUrl, fileIdOf, formatSize, kindIcon } from '../present';

/** Anything the canvas cannot show (CNV-4): its name, its size and a Download button. The server always sends the file as an attachment. */
export function DownloadView({ doc }: { doc: CanvasDocument }) {
	const id = fileIdOf(doc);
	const Icon = kindIcon(doc);
	const size = formatSize(doc.bytes);
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
			<Icon aria-hidden className="text-foreground-muted size-6" />
			<div className="min-w-0 max-w-full">
				<p className="font-strong truncate" title={doc.name}>
					{doc.name}
				</p>
				{size ? <p className="text-dense text-foreground-muted">{size}</p> : null}
			</div>
			{id !== null && doc.source.type === 'knowledge' && doc.kind === 'pdf' && doc.source.page !== undefined && (
				<Button asChild variant="outline">
					<a href={`${contentUrl(id)}#page=${doc.source.page}`} target="_blank" rel="noopener noreferrer">
						<ExternalLinkIcon aria-hidden />
						Open at page {doc.source.page}
					</a>
				</Button>
			)}
			{id !== null && (
				<Button asChild variant="outline">
					<a href={contentUrl(id, true)} download={doc.name} aria-label={`Download ${doc.name}`}>
						<DownloadIcon aria-hidden />
						Download
					</a>
				</Button>
			)}
		</div>
	);
}
