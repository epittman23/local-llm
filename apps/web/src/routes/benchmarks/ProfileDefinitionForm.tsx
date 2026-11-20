import { CircleAlertIcon } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Spinner } from '@/components/common/Spinner';
import { FormField } from '@/components/settings/formFields';
import { Button } from '@/components/ui/button';
import { DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { ProfileDefinition } from '@/lib/apis/benchmarks/profiles';
import { useFieldErrors } from '@/lib/ui/useFieldErrors';
import { ChoiceSelect, FlagLabel } from './fields';
import {
	ARCH_OPTIONS,
	argvToText,
	CACHE_TYPES,
	type DefinitionKey,
	definitionChanges,
	FIELD_META,
	REASONING_LEVELS,
	textToArgv,
	withOther
} from './profileForm';

const emptyDefinition: ProfileDefinition = {
	arch: 'dense',
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

/** Mirrors routers/benchmarks/profiles.py's _check_name. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** What is wrong with a new profile's name, or nothing (FRM-2). Shared with Clone. */
export function nameProblem(name: string): string | undefined {
	if (!NAME_PATTERN.test(name)) return 'Use 1 to 64 characters: a-z, 0-9, - and _, starting with a letter or digit.';
	if (name === 'default') return "'default' is reserved. Choose another name.";
	return undefined;
}

/** The profile's identity, asked for only when creating one (it never changes afterwards). */
export type Identity = { name: string; displayName: string };

const NUMBER_FIELDS = {
	ngl: { min: 0, unit: 'layers' },
	moe: { min: 0, unit: 'layers' },
	ctx: { min: 1, unit: 'tokens' },
	parallel: { min: 1, unit: 'slots' },
	threads: { min: 1, unit: 'threads' },
	batch: { min: 1, unit: 'tokens' },
	ubatch: { min: 1, unit: 'tokens' }
} as const;
type NumberKey = keyof typeof NUMBER_FIELDS;
const ARGV_KEYS = ['spec', 'samplers', 'extra'] as const;
type ArgvKey = (typeof ARGV_KEYS)[number];

/** Every field the form checks, in page order (FRM-2: Save focuses the first wrong one). */
const ORDER = [
	'name',
	'displayName',
	'model_path',
	'alias',
	'arch',
	'ngl',
	'moe',
	'ctx',
	'parallel',
	'threads',
	'batch',
	'ubatch',
	'samplers',
	'spec',
	'extra'
] as const;
type Checked = (typeof ORDER)[number];

/** Which field a server refusal is about, so it is said under that field (FBK-1); null for the form as a whole. */
export function fieldOfServerError(message: string): Checked | null {
	if (/already exists|reserved|\bname must/i.test(message)) return 'name';
	if (/display_name/i.test(message)) return 'displayName';
	if (/arch must/i.test(message)) return 'arch';
	if (/n-cpu-moe/i.test(message)) return 'moe';
	if (/reasoning_effort|-fit|--parallel/i.test(message)) return 'extra';
	return null;
}

const shownNumber = (value: number | null | undefined) => (value === null || value === undefined ? '' : String(value));

type Props = {
	/** The version this one replaces; the form starts from it and lists what differs (#1052). */
	initial?: ProfileDefinition;
	/** Its number, for "Changes from v3". */
	baselineVersion?: number;
	/** Changes laid over `initial` when the form opens (a "Create profile version" link, B-D8). */
	prefill?: Partial<ProfileDefinition>;
	initialNote?: string;
	/** Ask for the new profile's name and display name (Create). */
	withIdentity?: boolean;
	submitLabel: string;
	busyLabel?: string;
	onSubmit: (definition: ProfileDefinition, note: string, identity: Identity) => void;
	onCancel: () => void;
	pending?: boolean;
	/** The server's refusal of the last save, said under its field when it names one. */
	serverError?: string | null;
	onDirtyChange?: (dirty: boolean) => void;
};

/**
 * The DefinitionForm fields from apps/server/local_llm/routers/benchmarks/
 * profiles.py -- everything a profile *version* carries -- grouped as
 * Model, Offload, Context and batching, Sampling and reasoning, Extra
 * arguments and Notes (FRM-6), each named in words with its llama-server
 * flag beside it (WRD-2). The enumerations are selects (B-D8) that keep a
 * stored value they do not know. Fields are checked as they are left
 * (FRM-2), a server refusal lands under the field it is about (FBK-1), and
 * an edit lists what will change before "Save as new version". The body
 * scrolls between the dialog's header and a pinned footer (OVL-1).
 */
export function ProfileDefinitionForm({
	initial,
	baselineVersion,
	prefill,
	initialNote = '',
	withIdentity = false,
	submitLabel,
	busyLabel = 'Saving…',
	onSubmit,
	onCancel,
	pending,
	serverError,
	onDirtyChange
}: Props) {
	const [start] = useState<ProfileDefinition>(() => ({ ...(initial ?? emptyDefinition), ...prefill }));
	const [definition, setDefinition] = useState<ProfileDefinition>(start);
	const [numbers, setNumbers] = useState<Record<NumberKey, string>>(
		() =>
			Object.fromEntries(
				Object.keys(NUMBER_FIELDS).map((key) => [key, shownNumber(start[key as NumberKey])])
			) as Record<NumberKey, string>
	);
	const [argvText, setArgvText] = useState<Record<ArgvKey, string>>(() => ({
		spec: argvToText(start.spec),
		samplers: argvToText(start.samplers),
		extra: argvToText(start.extra)
	}));
	const [note, setNote] = useState(initialNote);
	const [identity, setIdentity] = useState<Identity>({ name: '', displayName: '' });
	const [refused, setRefused] = useState<{ field: Checked | null; message: string } | null>(null);
	const formRef = useRef<HTMLFormElement>(null);

	const clearRefusal = (key: string) => {
		if (refused?.field === key) setRefused(null);
	};
	const set = <K extends keyof ProfileDefinition>(key: K, value: ProfileDefinition[K]) => {
		setDefinition((d) => ({ ...d, [key]: value }));
		clearRefusal(key);
	};

	const built = {
		...definition,
		...Object.fromEntries(
			Object.entries(numbers).map(([key, raw]) => [key, raw.trim() === '' ? null : Number(raw.trim())])
		),
		spec: textToArgv(argvText.spec),
		samplers: textToArgv(argvText.samplers),
		extra: textToArgv(argvText.extra),
		override_tensors: definition.override_tensors?.trim() ? definition.override_tensors : null,
		reasoning_effort_default: definition.reasoning_effort_default || null
	} as ProfileDefinition;

	const problems: Partial<Record<Checked, string>> = {};
	if (withIdentity) {
		problems.name = nameProblem(identity.name);
		if (!identity.displayName.trim()) problems.displayName = 'Enter a display name, such as "Qwen3.8 27B (dense)".';
	}
	if (!definition.model_path.trim()) problems.model_path = 'Enter the model file, such as {LLAMA_MODELS}/model.gguf.';
	if (!definition.alias.trim()) problems.alias = 'Enter the name the server answers to, such as qwen3.8-27b.';
	for (const [key, { min, unit }] of Object.entries(NUMBER_FIELDS) as [NumberKey, { min: number; unit: string }][]) {
		const raw = numbers[key].trim();
		if (raw === '' && key === 'moe') continue;
		if (!/^\d+$/.test(raw) || Number(raw) < min) problems[key] = `Enter a whole number of ${unit}, ${min} or more.`;
	}
	if (!problems.moe && definition.arch === 'dense' && numbers.moe.trim())
		problems.moe = 'A dense model has no experts to keep on the CPU. Leave this empty.';
	for (const key of ['spec', 'extra'] as const) {
		const args = textToArgv(argvText[key]);
		if (args.some((a) => a === '--parallel' || a === '-np' || a.startsWith('--parallel=')))
			problems[key] = 'Set the slot count with Parallel slots, not here.';
		else if (args.some((a) => a === '-fit' || a === '--fit' || a.startsWith('-fit=') || a.startsWith('--fit=')))
			problems[key] = 'Remove -fit: the launcher always passes -fit off.';
	}
	if (!problems.extra && textToArgv(argvText.extra).some((a) => a.includes('reasoning_effort')))
		problems.extra = 'Set the thinking budget with Default reasoning effort, not here.';

	const { errors, field, submit } = useFieldErrors(problems, ORDER, { inDialog: true });
	const shownErrors: Partial<Record<Checked, string>> = { ...errors };
	if (refused?.field && !shownErrors[refused.field]) shownErrors[refused.field] = refused.message;

	// A refusal from the server: under its field, which takes focus, or above the footer (FBK-1).
	useEffect(() => {
		if (!serverError) {
			setRefused(null);
			return;
		}
		const target = fieldOfServerError(serverError);
		setRefused({ field: target, message: serverError });
		if (target) {
			const el = formRef.current?.querySelector<HTMLElement>(`#def-${target}`);
			el?.scrollIntoView?.({ block: 'nearest' });
			el?.focus();
		}
	}, [serverError]);

	const changes = initial ? definitionChanges(initial, built) : [];
	// Unsaved work is measured against what is saved, not against the form's
	// first state: a prefilled edit (a pre-screen candidate, a Tune winner)
	// is already unsaved, so closing it asks first (FRM-*, OVL-*).
	const dirty =
		(withIdentity && (identity.name !== '' || identity.displayName !== '')) ||
		note !== (prefill ? '' : initialNote) ||
		definitionChanges(initial ?? start, built).length > 0;
	useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

	const label = (key: DefinitionKey) => (
		<FlagLabel label={FIELD_META[key].label} flag={(FIELD_META[key] as { flag?: string }).flag} />
	);

	const num = (key: NumberKey, optional = false) => (
		<FormField
			id={`def-${key}`}
			label={label(key)}
			optional={optional}
			error={shownErrors[key]}
			help={key === 'moe' ? 'Only for mixture-of-experts models.' : undefined}
		>
			{(props) => (
				<Input
					{...props}
					{...field(key)}
					inputMode="numeric"
					autoComplete="off"
					value={numbers[key]}
					onChange={(e) => {
						setNumbers((n) => ({ ...n, [key]: e.target.value }));
						clearRefusal(key);
					}}
				/>
			)}
		</FormField>
	);

	const checkedText = (key: 'model_path' | 'alias') => (
		<FormField id={`def-${key}`} label={label(key)} error={shownErrors[key]}>
			{(props) => (
				<Input
					{...props}
					{...field(key)}
					autoComplete="off"
					className={key === 'model_path' ? 'font-mono' : undefined}
					value={definition[key]}
					onChange={(e) => set(key, e.target.value)}
				/>
			)}
		</FormField>
	);

	const optionalText = (key: 'hf_repo' | 'hf_pattern' | 'override_tensors', help?: string) => (
		<FormField id={`def-${key}`} label={label(key)} optional help={help}>
			{(props) => (
				<Input
					{...props}
					autoComplete="off"
					className="font-mono"
					value={definition[key] ?? ''}
					onChange={(e) => set(key, e.target.value)}
				/>
			)}
		</FormField>
	);

	const argv = (key: ArgvKey, help: string) => (
		<FormField id={`def-${key}`} label={FIELD_META[key].label} optional error={shownErrors[key]} help={help}>
			{(props) => (
				<Input
					{...props}
					{...field(key)}
					autoComplete="off"
					className="font-mono"
					placeholder="--flag value"
					value={argvText[key]}
					onChange={(e) => {
						setArgvText((t) => ({ ...t, [key]: e.target.value }));
						clearRefusal(key);
					}}
				/>
			)}
		</FormField>
	);

	return (
		<form
			ref={formRef}
			noValidate
			className="flex min-h-0 flex-1 flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				if (!submit()) return;
				onSubmit(built, note, { name: identity.name, displayName: identity.displayName.trim() });
			}}
		>
			<DialogBody>
				{withIdentity && (
					<Group
						title="Identity"
						description="Serve and links refer to a profile by its name, which can't change later."
					>
						<FormField id="def-name" label="Name" error={shownErrors.name} help="Such as qwen38-ctx32k.">
							{(props) => (
								<Input
									{...props}
									{...field('name')}
									autoComplete="off"
									className="font-mono"
									value={identity.name}
									onChange={(e) => {
										setIdentity((i) => ({ ...i, name: e.target.value }));
										clearRefusal('name');
									}}
								/>
							)}
						</FormField>
						<FormField id="def-displayName" label="Display name" error={shownErrors.displayName}>
							{(props) => (
								<Input
									{...props}
									{...field('displayName')}
									autoComplete="off"
									value={identity.displayName}
									onChange={(e) => {
										setIdentity((i) => ({ ...i, displayName: e.target.value }));
										clearRefusal('displayName');
									}}
								/>
							)}
						</FormField>
					</Group>
				)}

				<Group title="Model">
					<div className="sm:col-span-2">{checkedText('model_path')}</div>
					{checkedText('alias')}
					<FormField id="def-arch" label={FIELD_META.arch.label} error={shownErrors.arch}>
						{(props) => (
							<ChoiceSelect
								{...props}
								value={definition.arch}
								onChange={(v) => set('arch', v)}
								options={withOther(ARCH_OPTIONS, definition.arch)}
							/>
						)}
					</FormField>
					{optionalText('hf_repo')}
					{optionalText('hf_pattern')}
				</Group>

				<Group title="Offload" description="How much of the model sits on the GPU.">
					{num('ngl')}
					{num('moe', true)}
					<div className="sm:col-span-2">
						{optionalText('override_tensors', 'A tensor pattern and where its tensors go: pattern=CPU.')}
					</div>
				</Group>

				<Group title="Context and batching">
					{num('ctx')}
					{num('parallel')}
					{num('threads')}
					<div aria-hidden className="hidden sm:block" />
					{num('batch')}
					{num('ubatch')}
					{(['cache_k', 'cache_v'] as const).map((key) => (
						<FormField key={key} id={`def-${key}`} label={label(key)}>
							{(props) => (
								<ChoiceSelect
									{...props}
									value={definition[key] ?? ''}
									onChange={(v) => set(key, v)}
									options={withOther(
										CACHE_TYPES.map((t) => [t, t] as const),
										definition[key]
									)}
								/>
							)}
						</FormField>
					))}
				</Group>

				<Group title="Sampling and reasoning">
					<FormField
						id="def-reasoning_effort_default"
						label={FIELD_META.reasoning_effort_default.label}
						help="None for a model that doesn't think. Serve can change the level for one start."
					>
						{(props) => (
							<ChoiceSelect
								{...props}
								value={definition.reasoning_effort_default ?? ''}
								onChange={(v) => set('reasoning_effort_default', v || null)}
								options={withOther(
									[
										['', 'None (not a thinking model)'],
										...REASONING_LEVELS.map((l) => [l, l[0].toUpperCase() + l.slice(1)] as const)
									],
									definition.reasoning_effort_default
								)}
							/>
						)}
					</FormField>
					<div aria-hidden className="hidden sm:block" />
					<div className="sm:col-span-2">
						{argv('samplers', 'Flags and values, as on a command line: --temp 0.6 --top-p 0.95.')}
					</div>
					<div className="sm:col-span-2">
						{argv('spec', 'The speculative decoding flags. Serve can turn them off for one start.')}
					</div>
				</Group>

				<Group title="Extra arguments">
					<div className="sm:col-span-2">
						{argv('extra', 'Anything else llama-server should get. Quote a value that has spaces.')}
					</div>
				</Group>

				<FormField id="def-notes" label="Notes" optional help="Why the profile is set up this way.">
					{(props) => (
						<Textarea
							{...props}
							rows={4}
							value={definition.notes ?? ''}
							onChange={(e) => set('notes', e.target.value)}
						/>
					)}
				</FormField>
				<FormField
					id="def-note"
					label="Version note"
					optional
					help="Why this version: the reason, not a list of what changed."
				>
					{(props) => <Textarea {...props} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
				</FormField>

				{initial && (
					<section aria-labelledby="def-changes-title" className="flex flex-col gap-2 rounded-lg border p-3">
						<h3 id="def-changes-title" className="font-strong">
							Changes from {baselineVersion ? `v${baselineVersion}` : 'the current version'}
						</h3>
						{changes.length === 0 ? (
							<p className="text-foreground-muted text-dense">
								No changes yet. Saving now would repeat the current version.
							</p>
						) : (
							<ChangeList changes={changes} />
						)}
					</section>
				)}
			</DialogBody>

			{refused && !refused.field && (
				<div role="alert" className="text-danger text-dense flex shrink-0 items-start gap-1.5">
					<CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
					<p>Couldn't save: {refused.message}</p>
				</div>
			)}
			<DialogFooter>
				<Button type="button" variant="outline" onClick={onCancel}>
					Cancel
				</Button>
				<Button type="submit" disabled={pending} aria-busy={pending || undefined}>
					{pending && <Spinner className="size-3.5" />}
					{pending ? busyLabel : submitLabel}
				</Button>
			</DialogFooter>
		</form>
	);
}

/** FRM-6: one titled group of the form, two columns where there is room. */
function Group({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
	return (
		<fieldset className="flex min-w-0 flex-col gap-3">
			<legend className="font-strong text-foreground-strong mb-3">{title}</legend>
			{description && <p className="text-foreground-muted text-dense -mt-2">{description}</p>}
			<div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
		</fieldset>
	);
}

/** "GPU layers 20 → 22", one line per changed field (#978, #1052). */
export function ChangeList({ changes }: { changes: { key: DefinitionKey; before: string; after: string }[] }) {
	return (
		<ul className="flex flex-col gap-1 text-dense">
			{changes.map((c) => (
				<li key={c.key} className="min-w-0 break-words">
					<span className="text-foreground-muted">{FIELD_META[c.key].label}: </span>
					{c.key === 'notes' ? (
						<span>changed</span>
					) : (
						<>
							<span className="font-mono">{c.before}</span>
							<span aria-hidden> → </span>
							<span className="sr-only"> becomes </span>
							<span className="font-mono">{c.after}</span>
						</>
					)}
				</li>
			))}
		</ul>
	);
}
