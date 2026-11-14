import saveAs from 'file-saver';
import { Download, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** An svg snippet is shown centred on an otherwise empty page; html is used as written. */
export const artifactDocument = (code: string) =>
	/^\s*<svg[\s>]/i.test(code)
		? `<!doctype html><html><body style="margin:0;display:grid;place-items:center;min-height:100vh">${code}</body></html>`
		: code;

/**
 * A reduced port of chat/Artifacts.svelte: the html or svg code block whose
 * Preview button was pressed, rendered beside the chat. The frame is sandboxed
 * with scripts allowed but *without* `allow-same-origin`, so the page a model
 * wrote runs in an opaque origin: it cannot read this app's storage, cookies
 * or token, or reach into the parent document. (The Svelte panel also merges
 * a message's separate css/js blocks into the page and keeps a version list;
 * neither is ported.)
 */
export function ArtifactPanel({ code, onClose }: { code: string; onClose: () => void }) {
	return (
		<aside className="flex min-h-0 w-full flex-col border-l md:w-[28rem]" aria-label="Artifacts">
			<div className="flex items-center gap-1 px-3 py-2">
				<span className="text-sm font-medium">Artifacts</span>
				<Button
					type="button"
					aria-label="Download artifact"
					variant="ghost"
					size="icon-sm"
					className="ml-auto"
					onClick={() => saveAs(new Blob([artifactDocument(code)], { type: 'text/html' }), 'artifact.html')}
				>
					<Download className="size-4" />
				</Button>
				<Button type="button" aria-label="Close artifacts" variant="ghost" size="icon-sm" onClick={onClose}>
					<X className="size-4" />
				</Button>
			</div>
			<iframe
				title="Artifact preview"
				className="min-h-0 w-full flex-1 bg-white"
				sandbox="allow-scripts allow-forms allow-modals"
				srcDoc={artifactDocument(code)}
			/>
		</aside>
	);
}
