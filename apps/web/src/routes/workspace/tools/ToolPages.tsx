import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { type CodeSource, readCodeSource } from '@/components/common/codeSource';
import { Spinner } from '@/components/common/Spinner';
import { createNewTool, getToolById, updateToolById } from '@/lib/apis/tools';
import { useAuthStore } from '@/lib/stores/authStore';
import { refusedForVersion } from '@/lib/utils/pluginVersion';
import { routePaths } from '@/routes/routePaths';
import { ToolkitEditor } from './ToolkitEditor';
import { sanitizeIncomingTool, type ToolDraft } from './toolTypes';

const payload = (t: ToolDraft) => ({
	id: t.id,
	name: t.name,
	meta: t.meta,
	content: t.content,
	access_grants: t.access_grants
});

/**
 * Ports (app)/workspace/tools/create/+page.svelte. The form can be pre-filled
 * from a clone or a link import (left in `sessionStorage.tool`, read once).
 */
export function ToolCreatePage() {
	const token = useAuthStore((s) => s.token) ?? '';
	// Read once: the draft, and where its code came from (S4-D4).
	const [{ stash, source }] = useState((): { stash: ToolDraft | null; source: CodeSource | null } => {
		const raw = sessionStorage.tool;
		if (!raw) return { stash: null, source: null };
		sessionStorage.removeItem('tool');
		try {
			const parsed: unknown = JSON.parse(raw);
			return { stash: sanitizeIncomingTool(parsed, { withGrants: true }), source: readCodeSource(parsed) };
		} catch {
			return { stash: null, source: null };
		}
	});
	const tool: ToolDraft | null = stash;

	// The editor returns to the list once created; a failure throws, and the editor says why.
	const onSave = async (data: ToolDraft) => {
		if (refusedForVersion(data.content)) return false;
		await createNewTool(token, payload(data));
		toast.success('Tool created');
		return true;
	};

	return (
		<div className="h-full min-w-0 overflow-x-hidden">
			<ToolkitEditor tool={tool} clone={stash !== null} source={source} onSave={onSave} />
		</div>
	);
}

/** Ports (app)/workspace/tools/edit/+page.svelte: the tool is named by `?id=`; read-only tools bounce back. */
export function ToolEditPage() {
	const token = useAuthStore((s) => s.token) ?? '';
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const id = params.get('id');
	const [tool, setTool] = useState<ToolDraft | null>(null);

	useEffect(() => {
		if (!id) {
			navigate(routePaths.workspaceTools, { replace: true });
			return;
		}
		let cancelled = false;
		setTool(null);
		getToolById(token, id)
			.catch((error) => {
				toast.error(`${error}`);
				return null;
			})
			.then((res) => {
				if (cancelled) return;
				if (!res) {
					navigate(routePaths.workspaceTools);
					return;
				}
				if (!res.write_access) {
					toast.error('You do not have permission to edit this tool');
					navigate(routePaths.workspaceTools);
					return;
				}
				setTool({
					id: res.id,
					name: res.name,
					meta: res.meta ?? { description: '' },
					content: res.content ?? '',
					access_grants: res.access_grants ?? []
				});
			});
		return () => {
			cancelled = true;
		};
	}, [id, token, navigate]);

	const onSave = async (data: ToolDraft) => {
		if (!tool || refusedForVersion(data.content)) return false;
		await updateToolById(token, tool.id, payload(data));
		toast.success('Tool saved');
		return true;
	};

	if (!tool) {
		return (
			<div className="flex h-full items-center justify-center pb-16">
				<Spinner />
			</div>
		);
	}
	return (
		<div className="h-full min-w-0 overflow-x-hidden">
			<ToolkitEditor key={tool.id} tool={tool} edit onSave={onSave} />
		</div>
	);
}
