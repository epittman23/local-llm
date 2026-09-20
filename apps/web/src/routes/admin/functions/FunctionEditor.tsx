import { ChevronLeft } from 'lucide-react';
import { Suspense, lazy, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { CodeEditorHandle } from '@/components/common/CodeEditor';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { extractFrontmatter, nameToId } from '@/lib/utils/plugins';
import { formatSkillName } from '@/lib/utils/skills';
import { routePaths } from '@/routes/routePaths';
import { eventBoilerplate, filterBoilerplate } from './functionBoilerplate';
import type { FunctionDraft } from './functionTypes';

// CodeMirror is heavy; only this page needs it.
const CodeEditor = lazy(() => import('@/components/common/CodeEditor'));

type Starter = 'filter' | 'event';
const boilerplateFor = (starter: Starter) => (starter === 'event' ? eventBoilerplate : filterBoilerplate);

/**
 * Ports admin/Functions/FunctionEditor.svelte. The same shape as the Tools
 * editor (see workspace/tools/ToolkitEditor.tsx) without access control, plus a
 * Filter / Event starter picker on create -- picking one replaces the code with
 * that starter, exactly as the original does.
 *
 * Create: the id follows the name until typed into (not on a clone); a
 * `title:` / `description:` in the docstring header fills a blank name /
 * description; saving first asks the user to acknowledge that functions run
 * arbitrary code. Edit: the id is fixed and saving goes straight through.
 */
export function FunctionEditor({
	fn,
	edit = false,
	clone = false,
	onSave
}: {
	fn: FunctionDraft | null;
	edit?: boolean;
	clone?: boolean;
	onSave: (fn: FunctionDraft) => Promise<void>;
}) {
	const navigate = useNavigate();
	const form = useRef<HTMLFormElement>(null);
	const editor = useRef<CodeEditorHandle>(null);

	const [name, setName] = useState(fn?.name ?? '');
	const [id, setId] = useState(fn?.id ?? '');
	const [meta, setMeta] = useState(fn?.meta ?? { description: '' });
	const [starter, setStarter] = useState<Starter>('filter');
	// `seed` is what the editor is told to show; `code` is what it currently holds.
	const [seed, setSeed] = useState(fn?.content ?? '');
	const code = useRef(fn?.content || filterBoilerplate);
	const [showConfirm, setShowConfirm] = useState(false);
	const [loading, setLoading] = useState(false);

	const onNameChange = (value: string) => {
		setName(value);
		if (value && !edit && !clone) setId(nameToId(value));
	};

	const onCodeChange = (value: string) => {
		code.current = value;
		if (edit) return;
		const fm = extractFrontmatter(value);
		if (fm.title && !name) {
			setName(formatSkillName(fm.title));
			setId(nameToId(fm.title));
		}
		if (fm.description && !meta.description) setMeta((m) => ({ ...m, description: fm.description }));
	};

	const chooseStarter = (value: string) => {
		const next: Starter = value === 'event' ? 'event' : 'filter';
		setStarter(next);
		code.current = boilerplateFor(next);
		setSeed(code.current);
	};

	const submit = async () => {
		setLoading(true);
		try {
			const formatted = await editor.current?.formatPython();
			if (!formatted) console.warn('Code formatting failed or was skipped, saving unformatted code');
			await onSave({ id, name, meta, content: code.current });
		} finally {
			setLoading(false);
		}
	};

	return (
		<div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
			<ConfirmDialog
				open={showConfirm}
				onOpenChange={setShowConfirm}
				title="Confirm"
				onConfirm={() => {
					setShowConfirm(false);
					submit();
				}}
			>
				<FunctionCodeWarning />
			</ConfirmDialog>

			<form
				ref={form}
				className="flex h-full min-h-0 min-w-0 flex-col"
				onSubmit={(e) => {
					e.preventDefault();
					if (edit) submit();
					else setShowConfirm(true);
				}}
			>
				<button
					type="button"
					className="text-muted-foreground hover:text-foreground mb-1 flex h-6 w-fit items-center gap-1 rounded-md text-xs transition-colors"
					onClick={() => navigate(routePaths.adminFunctions)}
				>
					<ChevronLeft className="size-3" strokeWidth={2} />
					<span>Back</span>
				</button>

				<div className="flex shrink-0 items-start gap-2 px-1 pb-2">
					<div className="min-w-0 flex-1">
						<Tip content="e.g. My Filter" side="top">
							<input
								className="w-full bg-transparent text-sm outline-hidden"
								type="text"
								placeholder="Function Name"
								aria-label="Function Name"
								value={name}
								required
								onChange={(e) => onNameChange(e.target.value)}
							/>
						</Tip>
						<div className="text-muted-foreground mt-0.5 flex min-w-0 items-center gap-2 text-xs">
							{edit ? (
								<div className="shrink-0 truncate font-mono" title={id}>
									{id}
								</div>
							) : (
								<Tip content="e.g. my_filter" side="top">
									<input
										className="min-w-32 flex-1 bg-transparent font-mono outline-hidden"
										type="text"
										placeholder="Function ID"
										aria-label="Function ID"
										value={id}
										required
										onChange={(e) => setId(e.target.value)}
									/>
								</Tip>
							)}
							<Tip content="e.g. A filter to remove profanity from text" side="top">
								<input
									className="min-w-0 flex-1 bg-transparent outline-hidden"
									type="text"
									placeholder="Function Description"
									aria-label="Function Description"
									value={meta.description}
									required
									onChange={(e) => setMeta({ ...meta, description: e.target.value })}
								/>
							</Tip>
						</div>
					</div>

					<div className="flex shrink-0 items-center gap-1">
						{!edit && (
							<select
								className="h-7 rounded-lg border bg-transparent px-2 text-xs outline-hidden"
								value={starter}
								onChange={(e) => chooseStarter(e.target.value)}
								aria-label="Function starter"
							>
								<option value="filter">Filter</option>
								<option value="event">Event</option>
							</select>
						)}
					</div>
				</div>

				<div className="min-h-0 flex-1 overflow-hidden rounded-lg border">
					<Suspense
						fallback={
							<div className="flex h-full items-center justify-center">
								<Spinner />
							</div>
						}
					>
						<CodeEditor
							ref={editor}
							value={seed}
							boilerplate={filterBoilerplate}
							lang="python"
							className="text-[0.6875rem]"
							onChange={onCodeChange}
							onSave={() => form.current?.requestSubmit()}
						/>
					</Suspense>
				</div>

				<div className="text-muted-foreground shrink-0 py-2 text-xs">
					<div className="flex items-center justify-between gap-3">
						<div className="min-w-0">
							<span className="text-foreground font-normal">Warning:</span> Functions can execute arbitrary code.{' '}
							<span className="font-normal">Only install functions from sources you trust.</span>
						</div>
						<Button type="submit" size="sm" disabled={loading}>
							{edit ? 'Save' : 'Save & Create'}
							{loading && <Spinner className="size-3" />}
						</Button>
					</div>
				</div>
			</form>
		</div>
	);
}

/** The acknowledgement shown before a function is created or imported from a file. */
export function FunctionCodeWarning() {
	return (
		<div className="text-sm">
			<div className="rounded-lg bg-yellow-500/20 px-4 py-3 text-yellow-700 dark:text-yellow-200">
				<div>Please carefully review the following warnings:</div>
				<ul className="mt-1 list-disc pl-4 text-xs">
					<li>Functions allow arbitrary code execution.</li>
					<li>Do not install functions from sources you do not fully trust.</li>
				</ul>
			</div>
			<div className="my-3">
				I acknowledge that I have read and I understand the implications of my action. I am aware of the risks
				associated with executing arbitrary code and I have verified the trustworthiness of the source.
			</div>
		</div>
	);
}
