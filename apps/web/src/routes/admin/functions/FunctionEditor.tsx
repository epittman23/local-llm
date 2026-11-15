import { ChevronLeft } from 'lucide-react';
import { lazy, Suspense, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { CodeEditorHandle, CodeParseError } from '@/components/common/CodeEditor';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { EditorError, type EditorProblem, parseProblem, saveProblem } from '@/components/common/EditorError';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
	const codeHelp = useId();

	const [name, setName] = useState(fn?.name ?? '');
	const [id, setId] = useState(fn?.id ?? '');
	const [meta, setMeta] = useState(fn?.meta ?? { description: '' });
	const [starter, setStarter] = useState<Starter>('filter');
	// `seed` is what the editor is told to show; `code` is what it currently holds.
	const [seed, setSeed] = useState(fn?.content ?? '');
	const code = useRef(fn?.content || filterBoilerplate);
	const [showConfirm, setShowConfirm] = useState(false);
	const [loading, setLoading] = useState(false);
	// Shown in place of the code's help line: Black's parse error, or why the save failed.
	const [problem, setProblem] = useState<EditorProblem | null>(null);
	const onParseError = (error: CodeParseError | null) => setProblem(error ? parseProblem(error) : null);

	// The name as of now, for onCodeChange: the code editor can report its
	// seeded boilerplate through a callback from a render before the user typed a
	// name, and a `name` read from that render then looked blank, so the
	// boilerplate's title replaced what was typed.
	const nameNow = useRef(name);
	const onNameChange = (value: string) => {
		nameNow.current = value;
		setName(value);
		if (value && !edit && !clone) setId(nameToId(value));
	};

	const onCodeChange = (value: string) => {
		code.current = value;
		if (edit) return;
		const fm = extractFrontmatter(value);
		if (fm.title && !nameNow.current) {
			nameNow.current = formatSkillName(fm.title);
			setName(nameNow.current);
			setId(nameToId(fm.title));
		}
		if (fm.description) setMeta((m) => (m.description ? m : { ...m, description: fm.description }));
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
			setProblem(null);
			// Code that isn't valid Python is not sent: the editor marks the line and
			// onParseError says where. Code that could not be formatted for another
			// reason (not an admin, no answer) is saved as it is.
			if ((await editor.current?.formatPython()) === 'invalid') return;
			await onSave({ id, name, meta, content: code.current }).catch((error) =>
				setProblem(saveProblem(error, 'function'))
			);
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
				<Button
					variant="ghost"
					size="sm"
					className="mb-1 w-fit"
					type="button"
					onClick={() => navigate(routePaths.adminFunctions)}
				>
					<ChevronLeft className="size-3" strokeWidth={2} />
					<span>Back</span>
				</Button>

				<div className="flex shrink-0 flex-col gap-2 px-1 pb-3 sm:flex-row sm:items-start">
					<div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
						<div className="flex min-w-0 flex-col gap-1.5">
							<Label htmlFor="function-name">Function name</Label>
							<Input
								id="function-name"
								type="text"
								placeholder="e.g. My Filter"
								value={name}
								required
								onChange={(e) => onNameChange(e.target.value)}
							/>
						</div>
						<div className="flex min-w-0 flex-col gap-1.5">
							{edit ? (
								<>
									{/* Fixed once created: shown as text, not a field. */}
									<span className="text-sm leading-none font-medium">Function ID</span>
									<span className="flex h-9 min-w-0 items-center truncate font-mono text-dense" title={id}>
										{id}
									</span>
								</>
							) : (
								<>
									<Label htmlFor="function-id">Function ID</Label>
									<Input
										id="function-id"
										className="font-mono"
										type="text"
										placeholder="e.g. my_filter"
										value={id}
										required
										onChange={(e) => setId(e.target.value)}
									/>
								</>
							)}
						</div>
						<div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
							<Label htmlFor="function-description">Function description</Label>
							<Input
								id="function-description"
								type="text"
								placeholder="e.g. A filter to remove profanity from text"
								value={meta.description}
								required
								onChange={(e) => setMeta({ ...meta, description: e.target.value })}
							/>
						</div>
					</div>
					<div className="order-first flex shrink-0 items-center gap-1 self-end sm:order-none sm:mt-6 sm:self-auto">
						{!edit && (
							<select
								className="h-7 rounded-lg border bg-transparent px-2 text-xs"
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

				<span className="px-1 pb-1.5 text-sm leading-none font-medium">Function code</span>
				<div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border-control bg-surface-1">
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
							className="text-caption"
							placeholder=""
							ariaLabel="Function code"
							describedBy={codeHelp}
							onParseError={onParseError}
							onChange={onCodeChange}
							onSave={() => form.current?.requestSubmit()}
						/>
					</Suspense>
				</div>
				{problem ? (
					<EditorError id={codeHelp} problem={problem} />
				) : (
					<p id={codeHelp} className="text-foreground-muted text-dense px-1 pt-1.5">
						Tab indents. Press Esc, then Tab, to leave the editor.
					</p>
				)}

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
			<div className="rounded-lg bg-warning/15 px-4 py-3 text-warning">
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
