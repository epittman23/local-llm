import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Spinner } from '@/components/common/Spinner';
import { type ValveValues, type ValvesSpec, Valves } from '@/components/common/Valves';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import * as functionsApi from '@/lib/apis/functions';
import * as toolsApi from '@/lib/apis/tools';
import { useAuthStore } from '@/lib/stores/authStore';

type Kind = 'tool' | 'function';

const api = (type: Kind, userValves: boolean) => {
	const m: any = type === 'tool' ? toolsApi : functionsApi;
	return userValves
		? { get: m.getUserValvesById, spec: m.getUserValvesSpecById, update: m.updateUserValvesById }
		: type === 'tool'
			? { get: m.getToolValvesById, spec: m.getToolValvesSpecById, update: m.updateToolValvesById }
			: { get: m.getFunctionValvesById, spec: m.getFunctionValvesSpecById, update: m.updateFunctionValvesById };
};

/**
 * Ports workspace/common/ValvesModal.svelte: loads a tool's (or function's)
 * valves and their spec, edits them with <Valves>, and saves. Array valves are
 * edited as comma-separated text (multiselect ones excepted) and split back into
 * arrays on save. `userValves` switches to the per-user valves endpoints.
 */
export function ValvesModal({
	open,
	onOpenChange,
	type = 'tool',
	id,
	userValves = false,
	onSaved
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	type?: Kind;
	id: string | null;
	userValves?: boolean;
	onSaved?: () => void;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [spec, setSpec] = useState<ValvesSpec>(null);
	const [valves, setValves] = useState<ValveValues>({});
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!open || !id) return;
		let cancelled = false;
		setLoading(true);
		setSpec(null);
		setValves({});
		(async () => {
			try {
				const a = api(type, userValves);
				const [loaded, loadedSpec] = [await a.get(token, id), await a.spec(token, id)];
				if (cancelled) return;
				const next: ValveValues = { ...(loaded ?? {}) };
				for (const [name, prop] of Object.entries((loadedSpec as ValvesSpec)?.properties ?? {})) {
					if (prop?.type !== 'array' || prop.input?.type === 'multiselect') continue;
					next[name] = next[name] != null ? (Array.isArray(next[name]) ? (next[name] as unknown[]) : []).join(',') : null;
				}
				setValves(next);
				setSpec(loadedSpec as ValvesSpec);
				setLoading(false);
			} catch {
				if (cancelled) return;
				toast.error('Error fetching valves');
				onOpenChange(false);
			}
		})();
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, id, type, userValves, token]);

	const save = async () => {
		if (!spec || !id) return;
		setSaving(true);
		const out: ValveValues = { ...valves };
		for (const [name, prop] of Object.entries(spec.properties ?? {})) {
			if (prop?.type !== 'array') continue;
			if (typeof out[name] === 'string') {
				out[name] = (out[name] as string)
					.split(',')
					.map((v) => v.trim())
					.filter((v) => v.length > 0);
			} else if (out[name] == null) {
				out[name] = null;
			}
		}
		try {
			const res = await api(type, userValves).update(token, id, out);
			if (res) {
				toast.success('Valves updated successfully');
				onSaved?.();
			}
		} catch (error) {
			toast.error(`${error}`);
		}
		setSaving(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="text-sm">Valves</DialogTitle>
					<DialogDescription className="sr-only">Settings this plugin exposes.</DialogDescription>
				</DialogHeader>
				<form
					className="flex max-h-[70vh] flex-col overflow-y-auto"
					onSubmit={(e) => {
						e.preventDefault();
						save();
					}}
				>
					{loading ? (
						<div className="flex justify-center py-6">
							<Spinner />
						</div>
					) : (
						<Valves spec={spec} valves={valves} onChange={setValves} />
					)}
					<div className="flex justify-end pt-2.5">
						<Button type="submit" size="sm" disabled={saving || loading}>
							Save
							{saving && <Spinner className="size-3.5" />}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
