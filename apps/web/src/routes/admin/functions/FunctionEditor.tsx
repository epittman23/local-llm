import { ChevronLeft } from 'lucide-react';
import { lazy, Suspense, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { CodeEditorHandle, CodeParseError } from '@/components/common/CodeEditor';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { acknowledgement, type CodeSource } from '@/components/common/codeSource';
import { EditorError, type EditorProblem, parseProblem, saveProblem } from '@/components/common/EditorError';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SaveBar } from '@/components/ui/save-bar';
import { useUnsavedChanges } from '@/lib/ui/useUnsavedChanges';
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
 * Saves on request, as the Tools editor does (FRM-3): a SaveBar, and a guard
 * before leaving with unsaved changes; `onSave` resolves true once stored.
 */
export function FunctionEditor({
	fn,
	edit = false,
	clone = false,
	source = null,
	onSave
}: {
	fn: FunctionDraft | null;
	edit?: boolean;
	/** Pre-filled from a clone, a link or a file: creating it asks first (S4-D4). */
	clone?: boolean;
	/** Where a clone's or import's code came from, named in that question. */
	source?: CodeSource | null;
	onSave: (fn: FunctionDraft) => Promise<boolean>;
}) {
	const navigate = useNavigate();
	const form = useRef<HTMLFormElement>(null);
	const editor = useRef<CodeEditorHandle>(null);
	const codeHelp = useId();

	// A new function starts with the name, ID and description its boilerplate's
	// header gives, so the untouched page is not a change (#905): taken before
	// the editor reports the boilerplate, not after.
	const [seed] = useState(() => {
		if (fn) return { name: fn.name ?? '', id: fn.id ?? '', description: fn.meta?.description ?? '' };
		const fm = extractFrontmatter(filterBoilerplate);
		return {
			name: fm.title ? formatSkillName(fm.title) : '',
			id: fm.title ? nameToId(fm.title) : '',
			description: fm.description ?? ''
		};
	});
	const [name, setName] = useState(seed.name);
	const [id, setId] = useState(seed.id);
	const [meta, setMeta] = useState(fn?.meta ?? { description: seed.description });
	const [starter, setStarter] = useState<Starter>('filter');
	// `code` is what the editor holds now, for a save right after a format; `codeNow` renders it.
	const code = useRef(fn?.content || filterBoilerplate);
	const [codeNow, setCodeNow] = useState(code.current);
	// What Discard goes back to and "saved" compares with (see ToolkitEditor).
	const [saved, setSaved] = useState(() => ({ ...seed, content: code.current }));
	const dirty =
		(!edit && fn !== null) ||
		name !== saved.name ||
		id !== saved.id ||
		meta.description !== saved.description ||
		codeNow !== saved.content;
	const { dialog: leaveDialog, allowNext } = useUnsavedChanges(dirty);
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
		setCodeNow(value);
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
		editor.current?.replace(boilerplateFor(next));
	};

	const submit = async () => {
		setLoading(true);
		try {
			setProblem(null);
			// Code that isn't valid Python is not sent: the editor marks the line and
			// onParseError says where. Code that could not be formatted for another
			// reason (not an admin, no answer) is saved as it is.
			if ((await editor.current?.formatPython()) === 'invalid') return;
			const content = code.current;
			const stored = await onSave({ id, name, meta, content }).catch((error) => {
				setProblem(saveProblem(error, 'function'));
				return false;
			});
			if (!stored) return;
			setSaved({ name, id, description: meta.description, content });
			if (!edit) {
				allowNext();
				navigate(routePaths.adminFunctions);
			}
		} finally {
			setLoading(false);
		}
	};

	const discard = () => {
		setName(saved.name);
		nameNow.current = saved.name;
		setId(saved.id);
		setMeta((m) => ({ ...m, description: saved.description }));
		if (!edit) setStarter('filter');
		editor.current?.replace(saved.content);
		setProblem(null);
	};

	return (
		<div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
			{leaveDialog}
			<ConfirmDialog
				open={showConfirm}
				onOpenChange={setShowConfirm}
				title="Create function?"
				confirmLabel="Create function"
				onConfirm={() => {
					setShowConfirm(false);
					submit();
				}}
			>
				<FunctionCodeWarning source={source} />
			</ConfirmDialog>

			<form
				ref={form}
				className="flex h-full min-h-0 min-w-0 flex-col max-sm:overflow-y-auto"
				onSubmit={(e) => {
					e.preventDefault();
					// Code from elsewhere is acknowledged before it is created; code written
					// here is the person's own, and saves without asking (S4-D4).
					if (!edit && clone) setShowConfirm(true);
					else submit();
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
				{/* On a phone the form scrolls, so the editor keeps a usable height. */}
				<div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border-control bg-surface-1 max-sm:min-h-72">
					<Suspense
						fallback={
							<div className="flex h-full items-center justify-center">
								<Spinner />
							</div>
						}
					>
						<CodeEditor
							ref={editor}
							value={fn?.content ?? ''}
							boilerplate={filterBoilerplate}
							lang="python"
							className="text-caption"
							placeholder=""
							ariaLabel="Function code"
							describedBy={codeHelp}
							onParseError={onParseError}
							onChange={onCodeChange}
							onSave={() => {
								if (dirty && !loading) form.current?.requestSubmit();
							}}
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

				<p className="text-foreground-muted text-dense shrink-0 px-1 pt-1">
					Functions run their code on this server. Only add functions from sources you trust.
				</p>
				<SaveBar
					creating={!edit}
					className="mt-2 shrink-0 pb-2"
					dirty={dirty}
					saving={loading}
					onDiscard={discard}
					saveLabel={edit ? 'Save changes' : 'Create function'}
				/>
			</form>
		</div>
	);
}

/**
 * The acknowledgement asked before code from elsewhere becomes a function: one
 * sentence naming its source (S4-D4). Also used by the list page's file import,
 * with `verb="import"`.
 */
export function FunctionCodeWarning({
	source = null,
	verb = 'create'
}: {
	source?: CodeSource | null;
	verb?: 'create' | 'import';
}) {
	return <p>{acknowledgement('function', source, verb)}</p>;
}
