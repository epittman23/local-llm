import { ChevronLeft } from 'lucide-react';
import { Suspense, lazy, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AccessButton } from '@/components/common/AccessButton';
import { AccessControlModal } from '@/components/common/AccessControlModal';
import type { CodeEditorHandle } from '@/components/common/CodeEditor';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { Button } from '@/components/ui/button';
import { updateToolAccessGrants } from '@/lib/apis/tools';
import { useAuthStore } from '@/lib/stores/authStore';
import { extractFrontmatter, nameToId } from '@/lib/utils/plugins';
import { formatSkillName } from '@/lib/utils/skills';
import { routePaths } from '@/routes/routePaths';
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
 * - Ctrl/Cmd+S in the editor submits the form.
 */
export function ToolkitEditor({
	tool,
	edit = false,
	clone = false,
	onSave
}: {
	tool: ToolDraft | null;
	edit?: boolean;
	clone?: boolean;
	onSave: (tool: ToolDraft) => Promise<void>;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const user = useAuthStore((s) => s.user);
	const isAdmin = user?.role === 'admin';
	const navigate = useNavigate();
	const form = useRef<HTMLFormElement>(null);
	const editor = useRef<CodeEditorHandle>(null);

	const [name, setName] = useState(tool?.name ?? '');
	const [id, setId] = useState(tool?.id ?? '');
	const [meta, setMeta] = useState(tool?.meta ?? { description: '' });
	const [accessGrants, setAccessGrants] = useState(tool?.access_grants ?? []);
	// The editor owns the document; this ref tracks its live text so a save reads
	// the latest even right after an async format.
	const code = useRef(tool?.content || toolBoilerplate);
	const [showAccess, setShowAccess] = useState(false);
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

	const submit = async () => {
		setLoading(true);
		try {
			const formatted = await editor.current?.formatPython();
			if (!formatted) console.warn('Code formatting failed or was skipped, saving unformatted code');
			await onSave({ id, name, meta, content: code.current, access_grants: accessGrants });
		} finally {
			setLoading(false);
		}
	};

	return (
		<div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
			<AccessControlModal
				open={showAccess}
				onOpenChange={setShowAccess}
				accessGrants={accessGrants}
				accessRoles={['read', 'write']}
				share={Boolean(user?.permissions?.sharing?.tools) || isAdmin}
				sharePublic={Boolean(user?.permissions?.sharing?.public_tools) || isAdmin}
				shareUsers={(user?.permissions?.access_grants?.allow_users ?? true) || isAdmin}
				onChange={async (grants) => {
					setAccessGrants(grants);
					if (edit && id) {
						try {
							await updateToolAccessGrants(token, id, grants);
							toast.success('Saved');
						} catch (error) {
							toast.error(`${error}`);
						}
					}
				}}
			/>

			<ConfirmDialog
				open={showConfirm}
				onOpenChange={setShowConfirm}
				title="Confirm"
				onConfirm={() => {
					setShowConfirm(false);
					submit();
				}}
			>
				<CodeExecutionWarning />
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
					onClick={() => navigate(routePaths.workspaceTools)}
				>
					<ChevronLeft className="size-3" strokeWidth={2} />
					<span>Back</span>
				</button>

				<div className="flex shrink-0 items-start gap-2 px-1 pb-2">
					<div className="min-w-0 flex-1">
						<Tip content="e.g. My Tools" side="top">
							<input
								className="w-full bg-transparent text-sm outline-hidden"
								type="text"
								placeholder="Tool Name"
								aria-label="Tool Name"
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
								<Tip content="e.g. my_tools" side="top">
									<input
										className="min-w-32 flex-1 bg-transparent font-mono outline-hidden"
										type="text"
										placeholder="Tool ID"
										aria-label="Tool ID"
										value={id}
										required
										onChange={(e) => setId(e.target.value)}
									/>
								</Tip>
							)}
							<Tip content="e.g. Tools for performing various operations" side="top">
								<input
									className="min-w-0 flex-1 bg-transparent outline-hidden"
									type="text"
									placeholder="Tool Description"
									aria-label="Tool Description"
									value={meta.description}
									required
									onChange={(e) => setMeta({ ...meta, description: e.target.value })}
								/>
							</Tip>
						</div>
					</div>
					<div className="flex shrink-0 items-center gap-1 pr-0.5">
						<AccessButton onClick={() => setShowAccess(true)} />
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
							value={tool?.content ?? ''}
							boilerplate={toolBoilerplate}
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
							<span className="text-foreground font-normal">Warning:</span> Tools can execute arbitrary code.{' '}
							<span className="font-normal">Only install tools from sources you trust.</span>
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

/** The acknowledgement shown before a tool is created or imported from a file. */
export function CodeExecutionWarning() {
	return (
		<div className="text-sm">
			<div className="rounded-lg bg-yellow-500/20 px-4 py-3 text-yellow-700 dark:text-yellow-200">
				<div>Please carefully review the following warnings:</div>
				<ul className="mt-1 list-disc pl-4 text-xs">
					<li>Tools have a function calling system that allows arbitrary code execution.</li>
					<li>Do not install tools from sources you do not fully trust.</li>
				</ul>
			</div>
			<div className="my-3">
				I acknowledge that I have read and I understand the implications of my action. I am aware of the risks
				associated with executing arbitrary code and I have verified the trustworthiness of the source.
			</div>
		</div>
	);
}
