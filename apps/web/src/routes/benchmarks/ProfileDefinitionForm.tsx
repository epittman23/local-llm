import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { ProfileDefinition } from '@/lib/apis/benchmarks/profiles';

const emptyDefinition: ProfileDefinition = {
	arch: '',
	alias: '',
	model_path: '',
	hf_repo: '',
	hf_pattern: '',
	ctx: 4096,
	threads: 6,
	ngl: 99,
	moe: null,
	override_tensors: '',
	parallel: 1,
	cache_k: 'q8_0',
	cache_v: 'q8_0',
	batch: 512,
	ubatch: 512,
	spec: [],
	samplers: [],
	extra: [],
	reasoning_effort_default: '',
	notes: ''
};

// spec/samplers/extra are string[] on the backend (models/benchmark_profiles.py);
// represented here as comma-separated text rather than a per-item array editor --
// a reasonable simplification for a first version of a panel that previously
// didn't exist in any frontend (see this directory's own ProfilesPanel.tsx),
// not a port of an existing UI's own convention.
const toCsv = (values: string[] | undefined) => (values ?? []).join(', ');
const fromCsv = (csv: string) =>
	csv
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

type Props = {
	initial?: ProfileDefinition;
	submitLabel: string;
	onSubmit: (definition: ProfileDefinition, note: string) => void;
	onCancel: () => void;
	pending?: boolean;
};

/**
 * The DefinitionForm fields from backend/open_webui/routers/benchmarks/
 * profiles.py -- everything a profile *version* carries, deliberately
 * excluding name/display_name/is_default (the profile's identity, handled
 * by ProfilesPanel.tsx itself). Shared between create, clone, and
 * add-version, since all three submit the same shape.
 */
export function ProfileDefinitionForm({ initial, submitLabel, onSubmit, onCancel, pending }: Props) {
	const [definition, setDefinition] = useState<ProfileDefinition>(initial ?? emptyDefinition);
	const [note, setNote] = useState('');

	const set = <K extends keyof ProfileDefinition>(key: K, value: ProfileDefinition[K]) =>
		setDefinition((d) => ({ ...d, [key]: value }));

	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(e) => {
				e.preventDefault();
				onSubmit(definition, note);
			}}
		>
			<div className="grid grid-cols-2 gap-3">
				<div className="flex flex-col gap-1">
					<Label htmlFor="def-arch">arch</Label>
					<Input
						id="def-arch"
						required
						value={definition.arch}
						onChange={(e) => set('arch', e.target.value)}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="def-alias">alias</Label>
					<Input
						id="def-alias"
						required
						value={definition.alias}
						onChange={(e) => set('alias', e.target.value)}
					/>
				</div>
				<div className="col-span-2 flex flex-col gap-1">
					<Label htmlFor="def-model-path">model_path</Label>
					<Input
						id="def-model-path"
						required
						value={definition.model_path}
						onChange={(e) => set('model_path', e.target.value)}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="def-hf-repo">hf_repo</Label>
					<Input
						id="def-hf-repo"
						value={definition.hf_repo}
						onChange={(e) => set('hf_repo', e.target.value)}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="def-hf-pattern">hf_pattern</Label>
					<Input
						id="def-hf-pattern"
						value={definition.hf_pattern}
						onChange={(e) => set('hf_pattern', e.target.value)}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="def-ctx">ctx</Label>
					<Input
						id="def-ctx"
						type="number"
						required
						value={definition.ctx}
						onChange={(e) => set('ctx', Number(e.target.value))}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="def-threads">threads</Label>
					<Input
						id="def-threads"
						type="number"
						required
						value={definition.threads}
						onChange={(e) => set('threads', Number(e.target.value))}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="def-ngl">ngl</Label>
					<Input
						id="def-ngl"
						type="number"
						required
						value={definition.ngl}
						onChange={(e) => set('ngl', Number(e.target.value))}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="def-moe">moe (n-cpu-moe)</Label>
					<Input
						id="def-moe"
						type="number"
						value={definition.moe ?? ''}
						onChange={(e) => set('moe', e.target.value === '' ? null : Number(e.target.value))}
					/>
				</div>
				<div className="col-span-2 flex flex-col gap-1">
					<Label htmlFor="def-ot">override_tensors</Label>
					<Input
						id="def-ot"
						value={definition.override_tensors ?? ''}
						onChange={(e) => set('override_tensors', e.target.value)}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="def-parallel">parallel</Label>
					<Input
						id="def-parallel"
						type="number"
						value={definition.parallel}
						onChange={(e) => set('parallel', Number(e.target.value))}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="def-cache-k">cache_k</Label>
					<Input
						id="def-cache-k"
						value={definition.cache_k}
						onChange={(e) => set('cache_k', e.target.value)}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="def-cache-v">cache_v</Label>
					<Input
						id="def-cache-v"
						value={definition.cache_v}
						onChange={(e) => set('cache_v', e.target.value)}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="def-batch">batch</Label>
					<Input
						id="def-batch"
						type="number"
						value={definition.batch}
						onChange={(e) => set('batch', Number(e.target.value))}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="def-ubatch">ubatch</Label>
					<Input
						id="def-ubatch"
						type="number"
						value={definition.ubatch}
						onChange={(e) => set('ubatch', Number(e.target.value))}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="def-reasoning">reasoning_effort_default</Label>
					<Input
						id="def-reasoning"
						value={definition.reasoning_effort_default ?? ''}
						onChange={(e) => set('reasoning_effort_default', e.target.value)}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="def-spec">spec (comma-separated)</Label>
					<Input
						id="def-spec"
						value={toCsv(definition.spec)}
						onChange={(e) => set('spec', fromCsv(e.target.value))}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="def-samplers">samplers (comma-separated)</Label>
					<Input
						id="def-samplers"
						value={toCsv(definition.samplers)}
						onChange={(e) => set('samplers', fromCsv(e.target.value))}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="def-extra">extra (comma-separated)</Label>
					<Input
						id="def-extra"
						value={toCsv(definition.extra)}
						onChange={(e) => set('extra', fromCsv(e.target.value))}
					/>
				</div>
			</div>

			<div className="flex flex-col gap-1">
				<Label htmlFor="def-notes">notes</Label>
				<Textarea
					id="def-notes"
					rows={2}
					value={definition.notes}
					onChange={(e) => set('notes', e.target.value)}
				/>
			</div>

			<div className="flex flex-col gap-1">
				<Label htmlFor="def-note">Version note</Label>
				<Textarea
					id="def-note"
					rows={2}
					placeholder="Why this version -- rationale, not a changelog restatement"
					value={note}
					onChange={(e) => setNote(e.target.value)}
				/>
			</div>

			<div className="flex justify-end gap-2">
				<Button type="button" variant="ghost" onClick={onCancel}>
					Cancel
				</Button>
				<Button type="submit" disabled={pending}>
					{pending ? 'Saving…' : submitLabel}
				</Button>
			</div>
		</form>
	);
}
