import { useEffect, useId, useMemo, useState } from 'react';
import { Tip } from '@/components/common/Tip';
import { useMdUp } from '@/components/layout/SidePanel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { blockDocument, type CanvasDocument } from '@/lib/chat/documents';
import { withHtmlPolicy } from '@/lib/chat/htmlPolicy';
import { cn } from '@/lib/utils';
import { SandboxedHtmlFrame } from './SandboxedHtmlFrame';
import { SourceView, type SourceEdit } from './SourceView';

/** How long "Update as I type" waits after the last keystroke. */
export const LIVE_DELAY_MS = 800;

/**
 * A page being edited, with its preview beside the source (CNV-5, CNV-6). The
 * draft reaches the frame only as `srcDoc`, with the content-security policy
 * put in front by `withHtmlPolicy`, in the same `SandboxedHtmlFrame` a fenced
 * block uses: nothing runs on the app's origin, and the draft is only text in
 * React state. It is not sent on every keystroke, because a half-typed script
 * run again and again can freeze the tab: the preview is what the draft was at
 * the last Update preview (the button, or Ctrl or Cmd+Enter in the editor),
 * and says "Out of date" while the two differ. "Update as I type" (off) updates
 * 800 ms after typing stops.
 *
 * Side by side when the panel is 44 rem wide (a container query), below `md`
 * and when narrower the panel's own View switch (`mode`) shows one pane.
 */
export function HtmlEditView({
	doc,
	edit,
	mode
}: {
	doc: CanvasDocument;
	edit: SourceEdit;
	mode: 'preview' | 'source';
}) {
	const mdUp = useMdUp();
	const liveId = useId();
	const [applied, setApplied] = useState(edit.draft);
	const [live, setLive] = useState(false);
	const outOfDate = applied !== edit.draft;
	const update = () => setApplied(edit.draft);
	useEffect(() => {
		if (!live || applied === edit.draft) return;
		const timer = setTimeout(() => setApplied(edit.draft), LIVE_DELAY_MS);
		return () => clearTimeout(timer);
	}, [live, applied, edit.draft]);
	const isBlock = doc.source.type === 'block';
	const html = useMemo(() => withHtmlPolicy(isBlock ? blockDocument(applied) : applied), [applied, isBlock]);
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="bg-surface-2 text-dense flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5">
				<Tip content="Update preview (Ctrl or Cmd+Enter)">
					<Button variant="outline" size="xs" aria-keyshortcuts="Control+Enter Meta+Enter" onClick={update}>
						Update preview
					</Button>
				</Tip>
				{outOfDate && <Badge variant="warning">Out of date</Badge>}
				<Label htmlFor={liveId} className="text-dense ms-auto font-normal">
					<Switch id={liveId} size="sm" checked={live} onCheckedChange={setLive} />
					Update as I type
				</Label>
			</div>
			<div
				data-testid="html-edit-panes"
				className={cn('grid min-h-0 flex-1 grid-cols-1 grid-rows-1', mdUp && '@min-[44rem]:grid-cols-2')}
			>
				<div
					className={cn(
						'min-h-0 min-w-0',
						mode === 'source' ? 'block' : 'hidden',
						mdUp && '@min-[44rem]:block @min-[44rem]:border-e'
					)}
				>
					<SourceView doc={doc} edit={{ ...edit, onRun: update }} />
				</div>
				<div
					className={cn(
						'bg-surface-1 min-h-0 min-w-0 p-3',
						mode === 'preview' ? 'block' : 'hidden',
						mdUp && '@min-[44rem]:block'
					)}
				>
					<SandboxedHtmlFrame html={html} title={`Preview of ${doc.name}`} />
				</div>
			</div>
		</div>
	);
}
