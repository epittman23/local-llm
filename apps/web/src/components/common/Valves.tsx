import { Eye, EyeOff } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { SafeMarkdown } from '@/components/common/SafeMarkdown';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

export type ValveProperty = {
	title?: string;
	description?: string | null;
	type?: string;
	default?: unknown;
	enum?: Array<string | number | boolean | null>;
	input?: { type?: string; options?: Array<{ value: string; label?: string } | string> };
	format?: string;
};
export type ValvesSpec = { properties?: Record<string, ValveProperty>; required?: string[] } | null;
export type ValveValues = Record<string, unknown>;

// FRM-1: the field's edge and fill, for the boxes that hold more than one control.
const boxClass = 'border-border-control bg-surface-1 w-full rounded-lg border';
// FRM-4: a native select drawn as the shared field.
const selectClass =
	'border-border-control bg-surface-1 h-(--control) w-full rounded-lg border px-3 text-body pointer-coarse:h-(--control-touch)';

const ACRONYMS = new Set([
	'api',
	'url',
	'uri',
	'id',
	'llm',
	'http',
	'https',
	'json',
	'sql',
	'ssl',
	'tls',
	'ui',
	'ip',
	'ai',
	'csv'
]);

/** A setting's label in sentence case (WRD-1): "api_base" and "Api Base" both read "API base". */
export function settingLabel(title: string): string {
	const words = title
		.replace(/[_-]+/g, ' ')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.trim()
		.split(/\s+/);
	return words
		.map((word, i) => {
			const lower = word.toLowerCase();
			if (ACRONYMS.has(lower)) return lower.toUpperCase();
			return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
		})
		.join(' ');
}

// Words that name a secret wherever they stand in a setting's name.
const SECRET_WORDS = new Set(['secret', 'token', 'password', 'passwd', 'apikey', 'credential', 'credentials']);
// A name ending in "key" is a secret (api_key, OPENAI_KEY, key) unless the word before
// it says it is a lookup key instead.
const LOOKUP_KEYS = new Set(['sort', 'primary', 'foreign', 'partition', 'cache', 'group', 'index', 'lookup', 'hot']);

/**
 * A setting whose value should not show on screen: by its input type, its
 * format, or its name. The name is read as words (split on `_`, `-`, spaces
 * and camelCase), so `keywords`, `tokenizer` and `sort_key` show and
 * `github_token`, `apiKey` and `OPENAI_API_KEY` are masked.
 */
export function isSecret(name: string, p: ValveProperty): boolean {
	if (p.input?.type === 'password' || p.format === 'password') return true;
	const words = name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.toLowerCase()
		.split(/[\s_\-.]+/)
		.filter(Boolean);
	if (words.some((word) => SECRET_WORDS.has(word))) return true;
	const last = words.length - 1;
	return words[last] === 'key' && (last === 0 || !LOOKUP_KEYS.has(words[last - 1]));
}

/** The default as the help line says it (FRM-2): "Default: 100", "Default: off", or none. */
export function defaultText(p: ValveProperty): string | null {
	const d = p.default;
	if (d === undefined || d === null || d === '' || (Array.isArray(d) && d.length === 0)) return null;
	if (typeof d === 'boolean') return `Default: ${d ? 'on' : 'off'}`;
	return `Default: ${Array.isArray(d) ? d.join(', ') : String(d)}`;
}

/** The enum entry a `<select>`'s text stands for, with its own type: `'2'` is `2` in `[1, 2, 3]`. */
export const enumOption = (options: ReadonlyArray<unknown>, text: string): unknown =>
	options.find((option) => option !== null && String(option) === text) ?? text;

/**
 * The entries a valve's `<select>` offers. A `null` entry (an Optional
 * Literal) is left out: choosing it is the valve's "Default" state, which
 * this form shows as the None/Custom switch.
 */
export const enumChoices = (options: ReadonlyArray<unknown> = []) =>
	options.filter((option): option is string | number | boolean => option !== null && option !== undefined);

const optionValue = (o: { value: string; label?: string } | string) => (typeof o === 'string' ? o : o.value);
const optionLabel = (o: { value: string; label?: string } | string) =>
	typeof o === 'string' ? o : (o.label ?? o.value);

/** A password-style valve: masked, with a show/hide toggle. */
function SecretInput({
	id,
	value,
	placeholder,
	required,
	describedBy,
	onChange
}: {
	id: string;
	value: string;
	placeholder: string;
	required: boolean;
	describedBy?: string;
	onChange: (v: string) => void;
}) {
	const [shown, setShown] = useState(false);
	return (
		<div
			className={`${boxClass} flex h-(--control) items-center gap-2 ps-3 pe-1 pointer-coarse:h-(--control-touch)`}
			data-composite-field
		>
			<input
				id={id}
				className="text-body h-full w-full min-w-0 bg-transparent"
				type={shown ? 'text' : 'password'}
				value={value}
				placeholder={placeholder}
				required={required}
				autoComplete="off"
				aria-describedby={describedBy}
				onChange={(e) => onChange(e.target.value)}
			/>
			<Button
				variant="ghost"
				size="icon-xs"
				type="button"
				aria-label={shown ? 'Hide value' : 'Show value'}
				onClick={() => setShown((s) => !s)}
			>
				{shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
			</Button>
		</div>
	);
}

/**
 * Ports common/Valves.svelte: a form generated from a plugin's JSON-schema-like
 * spec of its settings (#1016). Every setting shows its field at once, with
 * its default as the help line ("Default: 100"); an empty field, or a switch
 * left at its default, means "use the default" and is stored as null, as the
 * plugin reads it. Labels are sentence case (WRD-1); a secret (by input type,
 * format, or a name with key, secret, token or password) is masked.
 *
 * Input types: enum and `select` (a select whose first choice is the
 * default), boolean (a switch), multiselect (checkboxes), color, password,
 * strings (a field; a textarea for a long or multi-line default), and arrays,
 * numbers and other types as a text field (arrays as comma-separated text,
 * converted by the caller on save -- see ValvesModal). The `map` input type
 * degrades to a "lat, lng" text field.
 */
export function Valves({
	spec,
	valves,
	onChange
}: {
	spec: ValvesSpec;
	valves: ValveValues;
	onChange: (next: ValveValues) => void;
}) {
	const properties = spec?.properties ?? {};
	const names = Object.keys(properties);
	if (!spec || names.length === 0) return null;

	const required = spec.required ?? [];
	const set = (name: string, value: unknown) => onChange({ ...valves, [name]: value });
	// Text fields: empty is "use the default".
	const setText = (name: string, text: string) => set(name, text === '' ? null : text);

	return (
		<div className="flex flex-col gap-4">
			{names.map((name) => {
				const p = properties[name] ?? {};
				const value = valves[name] ?? null;
				const isRequired = required.includes(name);
				const inputType = p.input?.type;
				const id = `valve-${name}`;
				const helpId = `${id}-help`;
				const label = settingLabel(p.title ?? name);
				const def = defaultText(p);
				const text = value === null ? '' : String(value);
				const fallbackText = p.default != null && p.default !== '' ? String(p.default) : '';

				let field: ReactNode;
				if (p.enum || (inputType === 'select' && p.input?.options)) {
					const options = p.enum
						? enumChoices(p.enum).map((o) => ({ value: String(o), label: String(o) }))
						: (p.input?.options ?? []).map((o) => ({ value: optionValue(o), label: optionLabel(o) }));
					field = (
						<select
							id={id}
							className={selectClass}
							value={text}
							aria-describedby={helpId}
							// The option itself, not the select's text: a Literal[1, 2, 3] valve refused "2" (#201).
							onChange={(e) =>
								set(name, e.target.value === '' ? null : p.enum ? enumOption(p.enum, e.target.value) : e.target.value)
							}
						>
							<option value="">{p.default != null ? `Default (${String(p.default)})` : 'Not set'}</option>
							{options.map((o) => (
								<option key={o.value} value={o.value}>
									{o.label}
								</option>
							))}
						</select>
					);
				} else if (p.type === 'boolean') {
					const fallback = Boolean(p.default);
					field = (
						<Switch
							id={id}
							aria-labelledby={`${id}-label`}
							aria-describedby={helpId}
							checked={value === null ? fallback : Boolean(value)}
							// Back at the default is stored as the default (null).
							onCheckedChange={(c) => set(name, c === fallback ? null : c)}
						/>
					);
				} else if (inputType === 'multiselect' && p.input?.options) {
					const fallback = Array.isArray(p.default) ? (p.default as string[]) : [];
					const picked = Array.isArray(value) ? (value as string[]) : fallback;
					field = (
						<fieldset
							id={id}
							aria-labelledby={`${id}-label`}
							aria-describedby={helpId}
							className={`${boxClass} flex flex-col gap-1 px-3 py-2`}
						>
							{p.input.options.map((o) => (
								<label key={optionValue(o)} className="flex items-center gap-2">
									<Checkbox
										checked={picked.includes(optionValue(o))}
										onCheckedChange={(c) =>
											set(name, c === true ? [...picked, optionValue(o)] : picked.filter((v) => v !== optionValue(o)))
										}
									/>
									{optionLabel(o)}
								</label>
							))}
						</fieldset>
					);
				} else if (inputType === 'color') {
					field = (
						<div className="flex items-center gap-2">
							<input
								type="color"
								aria-label={`${label}: pick a colour`}
								className="size-8 shrink-0 cursor-pointer rounded border"
								value={
									/^#[0-9a-f]{6}$/i.test(text) ? text : /^#[0-9a-f]{6}$/i.test(fallbackText) ? fallbackText : '#000000'
								}
								onChange={(e) => set(name, e.target.value.toUpperCase())}
							/>
							<Input id={id} aria-describedby={helpId} value={text} onChange={(e) => setText(name, e.target.value)} />
						</div>
					);
				} else if (p.type === 'string' && isSecret(name, p)) {
					field = (
						<SecretInput
							id={id}
							value={text}
							placeholder=""
							required={isRequired}
							describedBy={helpId}
							onChange={(v) => setText(name, v)}
						/>
					);
				} else if (p.type === 'string' && !inputType && (fallbackText.includes('\n') || fallbackText.length > 80)) {
					field = (
						<Textarea
							id={id}
							rows={3}
							className="max-h-40 resize-none"
							aria-describedby={helpId}
							value={text}
							required={isRequired}
							onChange={(e) => setText(name, e.target.value)}
						/>
					);
				} else {
					field = (
						<Input
							id={id}
							aria-describedby={helpId}
							value={text}
							// The default is the help line, not a placeholder that looks like a value.
							placeholder={inputType === 'map' ? 'e.g. 51.505, -0.09' : undefined}
							autoComplete="off"
							required={isRequired}
							onChange={(e) => setText(name, e.target.value)}
						/>
					);
				}

				const help = def ?? (isRequired ? 'Required.' : 'No default.');
				return (
					<div key={name} className="flex min-w-0 flex-col gap-1.5">
						<Label id={`${id}-label`} htmlFor={p.type === 'boolean' || inputType === 'multiselect' ? undefined : id}>
							{label}
							{isRequired && <span className="text-foreground-muted font-normal"> (required)</span>}
						</Label>
						{p.type === 'boolean' ? (
							<div className="flex items-center gap-3">
								{field}
								<span id={helpId} className="text-foreground-muted text-dense">
									{help}
								</span>
							</div>
						) : (
							<>
								{field}
								<p id={helpId} className="text-foreground-muted text-dense">
									{help}
								</p>
							</>
						)}
						{p.description != null && p.description !== '' && (
							<SafeMarkdown text={p.description} className="text-foreground-muted text-dense" />
						)}
					</div>
				);
			})}
		</div>
	);
}
