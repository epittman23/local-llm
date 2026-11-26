import { useContext } from 'react';
import { RowButton } from '@/components/ui/row-button';
import type { CanvasDocument } from '@/lib/chat/documents';
import { cn } from '@/lib/utils';
import { CanvasContext } from './CanvasContext';
import { contentUrl, fileIdOf, formatSize, kindIcon, kindLabel } from './present';

/**
 * CNV-1: what the model provides is a card in the reply that opens the canvas:
 * an icon for its kind (a thumbnail for an image), its name, its kind and
 * size. The card of the open document is marked with `aria-current`. A fenced
 * block still being written says "Writing…"; the canvas shows it filling in.
 */
export function DocumentCard({ document: doc }: { document: CanvasDocument }) {
	const canvas = useContext(CanvasContext);
	const open = canvas?.openId === doc.id;
	const Icon = kindIcon(doc);
	const writing = doc.source.type === 'block' && !doc.source.closed;
	const fileId = fileIdOf(doc);
	const detail = writing ? 'Writing…' : [kindLabel(doc), formatSize(doc.bytes)].filter(Boolean).join(', ');
	return (
		<RowButton
			aria-current={open ? 'true' : undefined}
			onClick={() => canvas?.open(doc.id)}
			data-testid="document-card"
			data-kind={doc.kind}
			className={cn(
				'rounded-panel my-2 flex max-w-sm items-center justify-start gap-3 border p-3',
				open && 'border-brand'
			)}
		>
			{doc.kind === 'image' && fileId !== null ? (
				<img
					src={contentUrl(fileId)}
					alt=""
					loading="lazy"
					className="bg-surface-3 size-9 shrink-0 rounded-lg object-cover"
				/>
			) : (
				<span className="bg-surface-3 flex size-9 shrink-0 items-center justify-center rounded-lg">
					<Icon aria-hidden className={cn('size-4', open ? 'text-brand' : 'text-foreground-muted')} />
				</span>
			)}
			<span className="min-w-0">
				<span className="font-strong block truncate" title={doc.name}>
					{doc.name}
				</span>
				<span className="text-dense text-foreground-muted block">{detail}</span>
			</span>
		</RowButton>
	);
}
