import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Spinner } from '@/components/common/Spinner';
import { createNewTool, getToolById, updateToolById } from '@/lib/apis/tools';
import { useAuthStore } from '@/lib/stores/authStore';
import { refusedForVersion } from '@/lib/utils/pluginVersion';
import { routePaths } from '@/routes/routePaths';
import { ToolkitEditor } from './ToolkitEditor';
import { type ToolDraft, sanitizeIncomingTool } from './toolTypes';

const COMMUNITY_ORIGINS = ['https://openwebui.com', 'https://www.openwebui.com', 'http://localhost:9999'];

const payload = (t: ToolDraft) => ({ id: t.id, name: t.name, meta: t.meta, content: t.content, access_grants: t.access_grants });

/**
 * Ports (app)/workspace/tools/create/+page.svelte. The form can be pre-filled
 * from a clone or a link import (left in `sessionStorage.tool`, read once) or by
 * a message from the Open WebUI community site -- which is sanitized and never
 * carries grants. When such a message arrives the editor is remounted with it.
 */
export function ToolCreatePage() {
	const token = useAuthStore((s) => s.token) ?? '';
	const navigate = useNavigate();
	const [stash] = useState(() => {
		const raw = sessionStorage.tool;
		if (!raw) return null;
		sessionStorage.removeItem('tool');
		try {
			return sanitizeIncomingTool(JSON.parse(raw), { withGrants: true });
		} catch {
			return null;
		}
	});
	const [tool, setTool] = useState<ToolDraft | null>(stash);
	const [revision, setRevision] = useState(0);

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			if (!COMMUNITY_ORIGINS.includes(event.origin)) return;
			try {
				const incoming = sanitizeIncomingTool(JSON.parse(event.data), { withGrants: false });
				if (!incoming) return;
				setTool(incoming);
				setRevision((r) => r + 1);
			} catch (error) {
				console.error('Ignoring malformed tool from community site', error);
			}
		};
		window.addEventListener('message', onMessage);
		// A fixed string with no data in it, so '*' discloses nothing.
		if (window.opener) window.opener.postMessage('loaded', '*');
		return () => window.removeEventListener('message', onMessage);
	}, []);

	const onSave = async (data: ToolDraft) => {
		if (refusedForVersion(data.content)) return;
		const res = await createNewTool(token, payload(data)).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (res) {
			toast.success('Tool created successfully');
			navigate(routePaths.workspaceTools);
		}
	};

	return (
		<div className="h-full min-w-0 overflow-x-hidden">
			<ToolkitEditor key={revision} tool={tool} clone={stash !== null} onSave={onSave} />
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
		if (!tool || refusedForVersion(data.content)) return;
		const res = await updateToolById(token, tool.id, payload(data)).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (res) toast.success('Tool updated successfully');
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
