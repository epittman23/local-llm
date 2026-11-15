import { ChevronLeft } from 'lucide-react';
import { lazy, Suspense, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { AccessButton } from '@/components/common/AccessButton';
import { AccessControlModal } from '@/components/common/AccessControlModal';
import type { CodeEditorHandle, CodeParseError } from '@/components/common/CodeEditor';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { acknowledgement, type CodeSource } from '@/components/common/codeSource';
import { EditorError, type EditorProblem, parseProblem, saveProblem } from '@/components/common/EditorError';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { FieldMessage, fieldProps } from '@/components/ui/field-message';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SaveBar } from '@/components/ui/save-bar';
import { LineTextarea, Textarea } from '@/components/ui/textarea';
import { useAccessGrants } from '@/lib/access/useAccessGrants';
import { updateToolAccessGrants } from '@/lib/apis/tools';
import { useAuthStore } from '@/lib/stores/authStore';
import { useFieldErrors } from '@/lib/ui/useFieldErrors';
import { useUnsavedChanges } from '@/lib/ui/useUnsavedChanges';
import { extractFrontmatter, nameToId } from '@/lib/utils/plugins';
import { formatSkillName } from '@/lib/utils/skills';
import { routePaths } from '@/routes/routePaths';
import { useSingleUser } from '@/routes/workspace/workspaceAccess';
import { toolBoilerplate } from './toolBoilerplate';
import type { ToolDraft } from './toolTypes';

// CodeMirror is heavy; only this page needs it.
const CodeEditor = lazy(() => import('@/components/common/CodeEditor'));

/**
 * Ports workspace/Tools/ToolkitEditor.svelte: name / id / description over a
 * Python code editor, an Access button, and the standing warning that tools
 * execute arbitrary code.
 *
 * - Create: the id follows the name (`nameToId`) until typed into; a `title:` /
 *   `description:` in the code's docstring header fills a blank name/description.
 *   Saving first asks the user to acknowledge the code-execution warning.
 * - Edit: the id is fixed; saving goes straight through.
 * - Either way the code is formatted (Black, via the backend, admins only) just
 *   before saving; if formatting fails the unformatted code is saved.
 * - Ctrl/Cmd+S in the editor submits the form while there is something to save.
 * - Saves on request (FRM-3): the SaveBar says whether the form matches what
 *   is stored, and leaving with unsaved changes asks first. A clone or import
 *   is unsaved from the start: nothing is stored yet. `onSave` resolves true
 *   once stored (a create then returns to the list), false when it refused
 *   (and said why), and throws when the server failed.
 */
export function ToolkitEditor({
	tool,
	edit = false,
	clone = false,
	source = null,
	onSave
}: {
	tool: ToolDraft | null;
	edit?: boolean;
	/** Pre-filled from a clone, a link or a file: creating it asks first (S4-D4). */
	clone?: boolean;
	/** Where a clone's or import's code came from, named in that question. */
	source?: CodeSource | null;
	onSave: (tool: ToolDraft) => Promise<boolean>;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const isAdmin = user?.role === 'admin';
	// Access says nothing while this install has one account (S4-D1, WRD-4).
	const singleUser = useSingleUser();
	const navigate = useNavigate();
	const form = useRef<HTMLFormElement>(null);
	const editor = useRef<CodeEditorHandle>(null);
	const codeHelp = useId();

	const [name, setName] = useState(tool?.name ?? '');
	const [id, setId] = useState(tool?.id ?? '');
	const [meta, setMeta] = useState(tool?.meta ?? { description: '' });
	const [accessGrants, changeAccess] = useAccessGrants(
		tool?.access_grants ?? [],
		edit && id ? (grants) => updateToolAccessGrants(token, id, grants) : null
	);
	// The editor owns the document; this ref tracks its live text so a save reads
	// the latest even right after an async format, and `codeNow` renders it.
	const code = useRef(tool?.content || toolBoilerplate);
	const [codeNow, setCodeNow] = useState(code.current);
	// What Discard goes back to, and what "saved" compares with: the stored tool,
	// or the empty form with the boilerplate. A clone or import has nothing
	// stored, so it counts as unsaved until created.
	const [saved, setSaved] = useState(() => ({
		name: tool?.name ?? '',
		id: tool?.id ?? '',
		description: tool?.meta?.description ?? '',
		content: code.current
	}));
	const unsavedImport = !edit && tool !== null;
	const dirty =
		unsavedImport ||
		name !== saved.name ||
		id !== saved.id ||
		meta.description !== saved.description ||
		codeNow !== saved.content;
	const { dialog: leaveDialog, allowNext } = useUnsavedChanges(dirty);
	const [showAccess, setShowAccess] = useState(false);
	const [showConfirm, setShowConfirm] = useState(false);
	const [loading, setLoading] = useState(false);
	// Shown in place of the code's help line: Black's parse error, or why the save failed.
	const [problem, setProblem] = useState<EditorProblem | null>(null);
	const onParseError = (error: CodeParseError | null) => setProblem(error ? parseProblem(error) : null);
	// FRM-2: the fields are checked here and say what is wrong under themselves (#1010).
	const {
		errors,
		field,
		submit: checkFields,
		reset: resetErrors
	} = useFieldErrors(
		{
			name: name.trim() ? undefined : 'Enter a name for this tool.',
			id: edit || id.trim() ? undefined : 'Enter an ID: it names the tool in the API.'
		},
		['name', 'id'] as const
	);

	const onNameChange = (value: string) => {
		setName(value);
		if (value && !edit && !clone) setId(nameToId(value));
	};

	const onCodeChange = (value: string) => {
		code.current = value;
		setCodeNow(value);
		if (edit) return;
		const fm = extractFrontmatter(value);
		if (fm.title && !name) {
			setName(formatSkillName(fm.title));
			setId(nameToId(fm.title));
		}
		if (fm.description && !meta.description) setMeta((m) => ({ ...m, description: fm.description }));
	};

	const submit = async () => {
		setLoading(true);
		try {
			setProblem(null);
			// Code that isn't valid Python is not sent: the editor marks the line and
			// onParseError says where. Code that could not be formatted for another
			// reason (not an admin, no answer) is saved as it is.
			if ((await editor.current?.formatPython()) === 'invalid') return;
			const sent = { id, name, meta, content: code.current, access_grants: accessGrants };
			const stored = await onSave(sent).catch((error) => {
				setProblem(saveProblem(error, 'tool'));
				return false;
			});
			if (!stored) return;
			setSaved({ name, id, description: meta.description, content: sent.content });
			if (!edit) {
				allowNext();
				navigate(routePaths.workspaceTools);
			}
		} finally {
			setLoading(false);
		}
	};

	const discard = () => {
		resetErrors();
		setName(saved.name);
		setId(saved.id);
		setMeta((m) => ({ ...m, description: saved.description }));
		code.current = saved.content;
		setCodeNow(saved.content);
		editor.current?.replace(saved.content);
		setProblem(null);
	};

	return (
		<div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
			{leaveDialog}
			<AccessControlModal
				open={showAccess}
				onOpenChange={setShowAccess}
				accessGrants={accessGrants}
				accessRoles={['read', 'write']}
				share={Boolean(user?.permissions?.sharing?.tools) || isAdmin}
				sharePublic={Boolean(user?.permissions?.sharing?.public_tools) || isAdmin}
				shareUsers={(user?.permissions?.access_grants?.allow_users ?? true) || isAdmin}
				onChange={changeAccess}
			/>

			<ConfirmDialog
				open={showConfirm}
				onOpenChange={setShowConfirm}
				title="Create tool?"
				confirmLabel="Create tool"
				onConfirm={() => {
					setShowConfirm(false);
					submit();
				}}
			>
				<CodeExecutionWarning source={source} />
			</ConfirmDialog>

			<form
				ref={form}
				className="flex h-full min-h-0 min-w-0 flex-col max-sm:overflow-y-auto"
				noValidate
				onSubmit={(e) => {
					e.preventDefault();
					if (!checkFields()) return;
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
					onClick={() => navigate(routePaths.workspaceTools)}
				>
					<ChevronLeft className="size-3" strokeWidth={2} />
					<span>Back</span>
				</Button>

				<div className="flex shrink-0 flex-col gap-2 px-1 pb-3 sm:flex-row sm:items-start">
					<div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
						<div className="flex min-w-0 flex-col gap-1.5">
							<Label htmlFor="tool-name">Tool name</Label>
							<LineTextarea
								id="tool-name"
								placeholder="e.g. My Tools"
								value={name}
								onChange={(e) => onNameChange(e.target.value)}
								{...field('name')}
								{...fieldProps('tool-name-note', { error: errors.name })}
							/>
							<FieldMessage id="tool-name-note" error={errors.name} />
						</div>
						<div className="flex min-w-0 flex-col gap-1.5">
							{edit ? (
								<>
									{/* Fixed once created: shown as text, not a field. */}
									<span className="text-sm leading-none font-medium">Tool ID</span>
									<span className="flex h-9 min-w-0 items-center truncate font-mono text-dense" title={id}>
										{id}
									</span>
								</>
							) : (
								<>
									<Label htmlFor="tool-id">Tool ID</Label>
									<Input
										id="tool-id"
										className="font-mono"
										type="text"
										placeholder="e.g. my_tools"
										value={id}
										onChange={(e) => setId(e.target.value)}
										{...field('id')}
										{...fieldProps('tool-id-note', { error: errors.id })}
									/>
									<FieldMessage id="tool-id-note" error={errors.id} />
								</>
							)}
						</div>
						<div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
							<Label htmlFor="tool-description">
								Tool description <span className="text-foreground-muted font-normal">(optional)</span>
							</Label>
							<Textarea
								id="tool-description"
								rows={2}
								// Two lines, growing with the text to six, then scrolling (FRM-1).
								className="max-h-40 resize-none"
								placeholder="e.g. Tools for performing various operations"
								value={meta.description}
								onChange={(e) => setMeta({ ...meta, description: e.target.value })}
							/>
						</div>
					</div>
					{!singleUser && (
						<div className="order-first flex shrink-0 items-center gap-1 self-end sm:order-none sm:mt-6 sm:self-auto pr-0.5">
							<AccessButton onClick={() => setShowAccess(true)} />
						</div>
					)}
				</div>

				<span className="px-1 pb-1.5 text-sm leading-none font-medium">Tool code</span>
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
							value={tool?.content ?? ''}
							boilerplate={toolBoilerplate}
							lang="python"
							className="text-caption"
							placeholder=""
							ariaLabel="Tool code"
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
					Tools run their code on this server. Only add tools from sources you trust.
				</p>
				<SaveBar
					creating={!edit}
					className="mt-2 shrink-0 pb-2"
					dirty={dirty}
					saving={loading}
					onDiscard={discard}
					saveLabel={edit ? 'Save changes' : 'Create tool'}
				/>
			</form>
		</div>
	);
}

/**
 * The acknowledgement asked before code from elsewhere becomes a tool: one
 * sentence naming its source (S4-D4). Also used by the list page's file import,
 * with `verb="import"`.
 */
export function CodeExecutionWarning({
	source = null,
	verb = 'create'
}: {
	source?: CodeSource | null;
	verb?: 'create' | 'import';
}) {
	return <p>{acknowledgement('tool', source, verb)}</p>;
}
