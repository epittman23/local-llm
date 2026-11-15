import { lazy, Suspense, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { CodeEditorHandle, CodeParseError } from '@/components/common/CodeEditor';
import { EditorError, type EditorProblem, parseProblem } from '@/components/common/EditorError';
import { Spinner } from '@/components/common/Spinner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RowButton } from '@/components/ui/row-button';
import { Switch } from '@/components/ui/switch';
import { KnowledgeFileList } from '@/routes/workspace/knowledge/KnowledgeFileList';
import type { UploadingItem } from '@/routes/workspace/knowledge/useKnowledgeUploads';

// The workspace's patterns on /ui: a list row's state, a row that failed, and
// the code editor as a field. Every name is invented.

const CodeEditor = lazy(() => import('@/components/common/CodeEditor'));

const ROWS = [
	{ name: 'Statistics tutor', line: 'qwen/qwen3.6-27b · stats, math', on: true },
	{ name: 'Code reviewer', line: 'qwen/qwen-2.5-coder-32b-instruct', on: false },
	{ name: 'Draft explainer', line: 'qwen/qwen3.6-27b', on: true, hidden: true },
	{ name: 'Shared glossary', line: 'qwen/qwen3.6-27b · terms', on: true, readOnly: true }
];

/**
 * DAT-3, COL-2, A11Y-2: a row's state is a secondary badge on its first line,
 * never opacity; its switch is named for the row, not its state.
 */
export function RowStateDemo() {
	const [on, setOn] = useState<Record<string, boolean>>(Object.fromEntries(ROWS.map((r) => [r.name, r.on])));
	return (
		<ul aria-label="Models" className="flex flex-col gap-px">
			{ROWS.map((row) => (
				<li key={row.name} className="flex items-center gap-2 rounded-lg">
					<RowButton
						className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-2 py-2"
						onClick={() => toast.success(`Opened “${row.name}”`)}
					>
						<span className="flex min-w-0 max-w-full items-center gap-2">
							<span className="font-strong truncate">{row.name}</span>
							{[
								...(row.readOnly ? ['Read only'] : []),
								...(on[row.name] ? [] : ['Off']),
								...(row.hidden ? ['Hidden'] : [])
							].map((badge) => (
								<Badge key={badge} variant="secondary">
									{badge}
								</Badge>
							))}
						</span>
						<span className="text-dense text-foreground-muted max-w-full truncate">{row.line}</span>
					</RowButton>
					{!row.readOnly && (
						<Switch
							aria-label={`Enable ${row.name}`}
							checked={on[row.name]}
							onCheckedChange={(checked) => setOn((prev) => ({ ...prev, [row.name]: checked }))}
						/>
					)}
				</li>
			))}
		</ul>
	);
}

const FAILED_UPLOADS: UploadingItem[] = [
	{
		itemId: 'demo-1',
		name: 'regression-diagnostics-and-residual-plots.pdf',
		size: 1_200_000,
		status: 'failed',
		reason: "It was uploaded but couldn't be processed into searchable text.",
		detail: 'Embedding model not found in the local cache (offline).'
	},
	{
		itemId: 'demo-2',
		name: 'sample-variance.md',
		size: 2_000,
		status: 'failed',
		reason: 'The same content is already in this knowledge base.',
		duplicate: true
	}
];

/** STA-4: a single row that failed stays in place with its reason, Details, Retry and Dismiss. */
export function FailedRowDemo() {
	const [uploading, setUploading] = useState(FAILED_UPLOADS);
	const nothing = () => {};
	return (
		<div className="flex flex-col gap-3">
			<KnowledgeFileList
				files={[]}
				directories={[]}
				uploading={uploading}
				writeAccess
				selectedFileId={null}
				onSelect={nothing}
				onDeleteFile={nothing}
				onRenameFile={nothing}
				onOpenDirectory={nothing}
				onRenameDirectory={nothing}
				onDeleteDirectory={nothing}
				onMove={nothing}
				onRetryUpload={nothing}
				onDismissUpload={(id) => setUploading((prev) => prev.filter((item) => item.itemId !== id))}
				showOwner={false}
			/>
			{uploading.length < FAILED_UPLOADS.length && (
				<div>
					<Button variant="outline" size="sm" onClick={() => setUploading(FAILED_UPLOADS)}>
						Show the rows again
					</Button>
				</div>
			)}
		</div>
	);
}

const BROKEN_CODE = `def mean(values):
    total = sum(values)
    return total / len(values
`;

/**
 * CNT-2, FRM-2: the code editor is a field with a label, the control edge and
 * a help line. "Check the code" formats it with the backend's Black, as the
 * editors do before saving; code it cannot parse marks its line and replaces
 * the help line with where and why.
 */
export function CodeEditorFieldDemo() {
	const editor = useRef<CodeEditorHandle>(null);
	const help = useId();
	const [problem, setProblem] = useState<EditorProblem | null>(null);
	return (
		<div className="flex max-w-[40rem] flex-col">
			<span className="px-1 pb-1.5 text-sm leading-none font-medium">Tool code</span>
			<div className="h-40 overflow-hidden rounded-lg border border-border-control bg-surface-1">
				<Suspense
					fallback={
						<div className="flex h-full items-center justify-center">
							<Spinner />
						</div>
					}
				>
					<CodeEditor
						ref={editor}
						value={BROKEN_CODE}
						lang="python"
						className="text-caption"
						placeholder=""
						ariaLabel="Tool code"
						describedBy={help}
						onParseError={(error: CodeParseError | null) => setProblem(error ? parseProblem(error) : null)}
					/>
				</Suspense>
			</div>
			{problem ? (
				<EditorError id={help} problem={problem} />
			) : (
				<p id={help} className="text-foreground-muted text-dense px-1 pt-1.5">
					Tab indents. Press Esc, then Tab, to leave the editor.
				</p>
			)}
			<div className="pt-3">
				<Button variant="outline" size="sm" onClick={() => void editor.current?.formatPython()}>
					Check the code
				</Button>
			</div>
		</div>
	);
}
