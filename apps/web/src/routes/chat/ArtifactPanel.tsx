import saveAs from 'file-saver';
import { Download } from 'lucide-react';
import { Tip } from '@/components/common/Tip';
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
 * neither is ported.) It is the body of the chat's side panel (`SidePanel`),
 * titled "Preview", with `ArtifactDownload` among its header actions.
 */
export function ArtifactPanel({ code }: { code: string }) {
	return (
		<iframe
			title="Artifact preview"
			className="bg-canvas border-border mx-2 mb-2 min-h-0 flex-1 rounded-lg border"
			sandbox="allow-scripts allow-forms allow-modals"
			srcDoc={artifactDocument(code)}
		/>
	);
}

/** The preview's Download, a header action of the side panel that holds it. */
export function ArtifactDownload({ code }: { code: string }) {
	return (
		<Tip content="Download">
			<Button
				type="button"
				aria-label="Download preview"
				variant="ghost"
				size="icon-sm"
				onClick={() => saveAs(new Blob([artifactDocument(code)], { type: 'text/html' }), 'artifact.html')}
			>
				<Download />
			</Button>
		</Tip>
	);
}
