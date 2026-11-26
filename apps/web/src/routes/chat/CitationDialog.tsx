import { ExternalLink, PanelRightOpenIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { knowledgeFileId } from '@/lib/chat/documents';
import type { Citation } from '@/lib/chat/sources';
import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { Excerpt } from './Excerpt';

/**
 * Ports Citations/CitationModal.svelte: one source's documents, each with a
 * link to the page or file it came from, its page number, and its relevance
 * when the retrieval reported one.
 */
export function CitationDialog({
	source,
	onClose,
	onOpenFile
}: {
	source: Citation | null;
	onClose: () => void;
	/** Opens a knowledge file in the canvas (CNV-1): offered beside the link of a passage that came from one. */
	onOpenFile?: (fileId: string) => void;
}) {
	if (!source) return null;
	const docs = source.document.map((text, i) => ({
		text,
		metadata: source.metadata[i] ?? {},
		distance: source.distances[i]
	}));
	const title = String(source.source?.name ?? source.source?.url ?? 'Citation');
	return (
		<Dialog open onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>Citation</DialogTitle>
					<DialogDescription className="truncate">{title}</DialogDescription>
				</DialogHeader>
				<div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto">
					{docs.map((d, i) => {
						const url = d.metadata.file_id
							? `${WEBUI_API_BASE_URL}/files/${d.metadata.file_id}/content${d.metadata.page !== undefined ? `#page=${d.metadata.page + 1}` : ''}`
							: (d.metadata.source ?? source.source?.url);
						const fileId = knowledgeFileId(d.metadata);
						return (
							<div key={i} className="flex flex-col gap-1 border-b pb-3 last:border-0">
								<div className="flex items-center gap-2 text-sm font-medium">
									{(url && String(url).startsWith('http')) || d.metadata.file_id ? (
										<a
											href={String(url)}
											target="_blank"
											rel="noopener noreferrer"
											className="flex items-center gap-1 underline"
										>
											{String(d.metadata.name ?? d.metadata.source ?? title)} <ExternalLink className="size-3" />
										</a>
									) : (
										<span>{String(d.metadata.name ?? d.metadata.source ?? title)}</span>
									)}
									{fileId !== null && onOpenFile && (
										<Button
											type="button"
											variant="outline"
											size="xs"
											onClick={() => {
												onClose();
												onOpenFile(fileId);
											}}
										>
											<PanelRightOpenIcon aria-hidden />
											Open in canvas
										</Button>
									)}
									{d.metadata.page !== undefined && (
										<span className="text-muted-foreground text-xs">(page {Number(d.metadata.page) + 1})</span>
									)}
									{typeof d.distance === 'number' && (
										<span className="text-muted-foreground ml-auto text-xs">Relevance {d.distance.toFixed(4)}</span>
									)}
								</div>
								<Excerpt text={String(d.text ?? '')} />
							</div>
						);
					})}
					{docs.length === 0 && <p className="text-muted-foreground text-sm">No content.</p>}
				</div>
			</DialogContent>
		</Dialog>
	);
}
