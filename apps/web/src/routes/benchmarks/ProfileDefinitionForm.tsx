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
	reasoning_effort_default: null,
	notes: ''
};

// spec/samplers/extra are argv token lists on the backend
// (models/benchmark_profiles.py), edited here as one command-line string.
// The raw text is kept as typed and only split on submit -- re-deriving the
// input's value from the parsed list on every keystroke ate commas and spaces
// (docs/bug-review-2026-09-27.md M7). Split shell-style: whitespace separates
// tokens, and single or double quotes keep a value with spaces or commas in
// one token (`-ot "a=CUDA0,b=CUDA0"`).
const quoteArg = (arg: string) => (/[\s'"]/.test(arg) || arg === '' ? `'${arg.replace(/'/g, `'"'"'`)}'` : arg);
export const argvToText = (values: string[] | null | undefined) => (values ?? []).map(quoteArg).join(' ');
export function textToArgv(text: string): string[] {
	const out: string[] = [];
	let cur = '';
	let has = false;
	let quote: '"' | "'" | null = null;
	for (const ch of text) {
		if (quote) {
			if (ch === quote) quote = null;
			else cur += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			has = true;
		} else if (/\s/.test(ch)) {
			if (has) out.push(cur);
			cur = '';
			has = false;
		} else {
			cur += ch;
			has = true;
		}
	}
	if (has) out.push(cur);
	return out;
}

/** Empty text is "none", not an empty string (see validate_definition's BLANK_MEANS_NONE). */
const orNull = (value: string) => (value.trim() ? value : null);

type ArgvKey = 'spec' | 'samplers' | 'extra';

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
	const [argvText, setArgvText] = useState<Record<ArgvKey, string>>(() => ({
		spec: argvToText((initial ?? emptyDefinition).spec),
		samplers: argvToText((initial ?? emptyDefinition).samplers),
		extra: argvToText((initial ?? emptyDefinition).extra)
	}));

	const set = <K extends keyof ProfileDefinition>(key: K, value: ProfileDefinition[K]) =>
		setDefinition((d) => ({ ...d, [key]: value }));

	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(e) => {
				e.preventDefault();
				onSubmit(
					{
						...definition,
						spec: textToArgv(argvText.spec),
						samplers: textToArgv(argvText.samplers),
						extra: textToArgv(argvText.extra),
						override_tensors: orNull(definition.override_tensors ?? ''),
						reasoning_effort_default: orNull(definition.reasoning_effort_default ?? '')
					},
					note
				);
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
					<Label htmlFor="def-spec">spec (command-line arguments)</Label>
					<Input
						id="def-spec"
						placeholder="--flag value"
						value={argvText.spec}
						onChange={(e) => setArgvText((t) => ({ ...t, spec: e.target.value }))}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="def-samplers">samplers (command-line arguments)</Label>
					<Input
						id="def-samplers"
						placeholder="--flag value"
						value={argvText.samplers}
						onChange={(e) => setArgvText((t) => ({ ...t, samplers: e.target.value }))}
					/>
				</div>
				<div className="flex flex-col gap-1">
					<Label htmlFor="def-extra">extra (command-line arguments)</Label>
					<Input
						id="def-extra"
						placeholder="--flag value"
						value={argvText.extra}
						onChange={(e) => setArgvText((t) => ({ ...t, extra: e.target.value }))}
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
