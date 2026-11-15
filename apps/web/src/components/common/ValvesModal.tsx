import { CircleAlertIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { failureCause } from '@/components/common/LoadFailed';
import { Spinner } from '@/components/common/Spinner';
import { Valves, type ValvesSpec, type ValveValues } from '@/components/common/Valves';
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
 *
 * Called "Settings" in the interface (WRD-2: "valves" is the plugin API's
 * word). OVL-1: 32 rem wide, with a fixed header and footer around a body
 * that scrolls, so the dialog never jumps as fields change (#1016). A plugin
 * with no settings says so, with Save off (ACT-5). Load and save failures are
 * said in the dialog (FBK-1, #1095).
 */
export function ValvesModal({
	open,
	onOpenChange,
	type = 'tool',
	id,
	userValves = false,
	name,
	onSaved
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	type?: Kind;
	id: string | null;
	userValves?: boolean;
	/** The plugin's name, for the title: "Settings for Unit converter". */
	name?: string;
	onSaved?: () => void;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [spec, setSpec] = useState<ValvesSpec>(null);
	const [valves, setValves] = useState<ValveValues>({});
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		if (!open || !id) return;
		let cancelled = false;
		setLoading(true);
		setProblem(null);
		setSpec(null);
		setValves({});
		void attempt;
		(async () => {
			try {
				const a = api(type, userValves);
				const [loaded, loadedSpec] = [await a.get(token, id), await a.spec(token, id)];
				if (cancelled) return;
				const next: ValveValues = { ...(loaded ?? {}) };
				for (const [name, prop] of Object.entries((loadedSpec as ValvesSpec)?.properties ?? {})) {
					if (prop?.type !== 'array' || prop.input?.type === 'multiselect') continue;
					next[name] =
						next[name] != null ? (Array.isArray(next[name]) ? (next[name] as unknown[]) : []).join(',') : null;
				}
				setValves(next);
				setSpec(loadedSpec as ValvesSpec);
				setLoading(false);
			} catch (error) {
				if (cancelled) return;
				setProblem(`Couldn't load the settings. ${failureCause(error).cause}`);
				setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, id, type, userValves, token, attempt]);

	const save = async () => {
		if (!spec || !id) return;
		setSaving(true);
		setProblem(null);
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
				toast.success(name ? `Settings for ${name} saved` : 'Settings saved');
				onSaved?.();
			}
		} catch (error) {
			const { cause, detail } = failureCause(error);
			setProblem(`Couldn't save the settings. ${detail ?? cause}`);
		}
		setSaving(false);
	};

	const empty = !loading && !problem && Object.keys(spec?.properties ?? {}).length === 0;
	const failedToLoad = problem !== null && spec === null;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[min(40rem,calc(100dvh-2rem))] flex-col gap-0 p-0 sm:max-w-lg">
				{/* The title wraps short of the close button, which sits over the top-right corner. */}
				<DialogHeader className="shrink-0 border-b ps-5 pe-11 pt-5 pb-3">
					<DialogTitle className="leading-snug break-words">{name ? `Settings for ${name}` : 'Settings'}</DialogTitle>
					<DialogDescription>
						{userValves ? `Your own settings for this ${type}.` : `Settings this ${type} takes.`} Leave a field empty to
						use its default.
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex min-h-0 flex-1 flex-col"
					onSubmit={(e) => {
						e.preventDefault();
						save();
					}}
				>
					<div className="min-h-48 flex-1 overflow-y-auto px-5 py-4">
						{loading ? (
							<div className="flex justify-center py-6">
								<Spinner />
							</div>
						) : empty ? (
							<p className="text-foreground-muted py-6 text-center">This {type} has no settings.</p>
						) : (
							<Valves spec={spec} valves={valves} onChange={setValves} />
						)}
						{problem && (
							<div role="alert" className="text-danger text-dense mt-3 flex items-start gap-1.5">
								<CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
								<span>{problem}</span>
							</div>
						)}
					</div>
					<div className="flex shrink-0 flex-wrap justify-end gap-2 border-t px-5 py-3">
						<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						{failedToLoad ? (
							<Button type="button" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
								Try again
							</Button>
						) : (
							<Button type="submit" disabled={saving || loading || empty} aria-busy={saving || undefined}>
								{saving && <Spinner className="size-3.5" />}
								{saving ? 'Saving…' : 'Save settings'}
							</Button>
						)}
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
