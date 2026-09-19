import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { SafeMarkdown } from '@/components/common/SafeMarkdown';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';

export type ValveProperty = {
	title?: string;
	description?: string | null;
	type?: string;
	default?: unknown;
	enum?: string[];
	input?: { type?: string; options?: Array<{ value: string; label?: string } | string> };
};
export type ValvesSpec = { properties?: Record<string, ValveProperty>; required?: string[] } | null;
export type ValveValues = Record<string, unknown>;

const fieldClass = 'border-border bg-background w-full rounded-lg border px-3 py-2 text-sm outline-hidden';

const optionValue = (o: { value: string; label?: string } | string) => (typeof o === 'string' ? o : o.value);
const optionLabel = (o: { value: string; label?: string } | string) => (typeof o === 'string' ? o : (o.label ?? o.value));

/** A password-style valve: masked, with a show/hide toggle. */
function SecretInput({
	id,
	value,
	placeholder,
	required,
	onChange
}: {
	id: string;
	value: string;
	placeholder: string;
	required: boolean;
	onChange: (v: string) => void;
}) {
	const [shown, setShown] = useState(false);
	return (
		<div className={`${fieldClass} flex items-center gap-2`}>
			<input
				id={id}
				className="w-full bg-transparent outline-hidden"
				type={shown ? 'text' : 'password'}
				value={value}
				placeholder={placeholder}
				required={required}
				autoComplete="off"
				onChange={(e) => onChange(e.target.value)}
			/>
			<button type="button" aria-label={shown ? 'Hide value' : 'Show value'} onClick={() => setShown((s) => !s)}>
				{shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
			</button>
		</div>
	);
}

/**
 * Ports common/Valves.svelte: a form generated from a plugin's JSON-schema-like
 * valve spec. Each property is either at its default (`null`) or overridden
 * ("Custom"); the header button flips between the two.
 *
 * Input types handled: enum, boolean, string (textarea), string with
 * `input.type` password / select / color, array with `input.type` multiselect,
 * and array / number / other non-string types as a text field (arrays as
 * comma-separated, converted by the caller on save -- see ValvesModal).
 * Not ported: the `map` input type (a Leaflet map picker, marked EXPERIMENTAL DO
 * NOT USE IN PRODUCTION in the original) -- it degrades to a plain
 * "lat, lng" text field.
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
	if (!spec || names.length === 0) return <div className="text-xs">No valves</div>;

	const required = spec.required ?? [];
	const set = (name: string, value: unknown) => onChange({ ...valves, [name]: value });

	const toggleCustom = (name: string) => {
		const p = properties[name] ?? {};
		if ((valves[name] ?? null) === null) {
			if (p.type === 'array') {
				const def = Array.isArray(p.default) ? p.default : [];
				set(name, p.input?.type === 'multiselect' ? [...def] : def.join(', '));
			} else {
				set(name, p.default ?? '');
			}
		} else {
			set(name, null);
		}
	};

	return (
		<>
			{names.map((name) => {
				const p = properties[name];
				const value = valves[name] ?? null;
				const isRequired = required.includes(name);
				const inputType = p.input?.type;

				let field: React.ReactNode = null;
				if (value !== null) {
					if (p.enum) {
						field = (
							<select className={fieldClass} value={String(value)} onChange={(e) => set(name, e.target.value)}>
								{p.enum.map((option) => (
									<option key={option} value={option}>
										{option}
									</option>
								))}
							</select>
						);
					} else if (p.type === 'boolean') {
						field = (
							<div className="flex items-center justify-between">
								<div className="text-muted-foreground text-xs">{value ? 'Enabled' : 'Disabled'}</div>
								<div className="pr-2">
									<Switch aria-label={p.title ?? name} checked={Boolean(value)} onCheckedChange={(c) => set(name, c)} />
								</div>
							</div>
						);
					} else if (inputType === 'multiselect' && p.input?.options) {
						const picked = Array.isArray(value) ? (value as string[]) : [];
						field = (
							<div className={`${fieldClass} flex flex-col gap-1`}>
								{p.input.options.map((o) => (
									<label key={optionValue(o)} className="flex items-center gap-2 text-sm">
										<Checkbox
											checked={picked.includes(optionValue(o))}
											onCheckedChange={(c) =>
												set(name, c === true ? [...picked, optionValue(o)] : picked.filter((v) => v !== optionValue(o)))
											}
										/>
										{optionLabel(o)}
									</label>
								))}
							</div>
						);
					} else if (p.type !== 'string') {
						field = (
							<input
								className={fieldClass}
								type="text"
								placeholder={p.title}
								aria-label={p.title ?? name}
								value={String(value)}
								autoComplete="off"
								required
								onChange={(e) => set(name, e.target.value)}
							/>
						);
					} else if (p.input) {
						if (inputType === 'password') {
							field = (
								<SecretInput
									id={`valve-${name}`}
									value={String(value)}
									placeholder={p.description ?? ''}
									required={isRequired}
									onChange={(v) => set(name, v)}
								/>
							);
						} else if (inputType === 'select' && p.input.options) {
							field = (
								<select className={fieldClass} value={String(value)} onChange={(e) => set(name, e.target.value)}>
									<option value="" disabled>
										{p.description ?? 'Select an option'}
									</option>
									{p.input.options.map((o) => (
										<option key={optionValue(o)} value={optionValue(o)}>
											{optionLabel(o)}
										</option>
									))}
								</select>
							);
						} else if (inputType === 'color') {
							field = (
								<div className="flex items-center gap-2">
									<input
										type="color"
										aria-label={`${p.title ?? name} color`}
										className="size-6 cursor-pointer rounded border"
										value={/^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : '#000000'}
										onChange={(e) => set(name, e.target.value.toUpperCase())}
									/>
									<input className={`${fieldClass} flex-1`} type="text" value={String(value)} disabled readOnly />
								</div>
							);
						} else {
							// `map` and any input type this port doesn't know: a plain text field.
							field = (
								<input
									className={fieldClass}
									type="text"
									aria-label={p.title ?? name}
									placeholder={inputType === 'map' ? 'Enter coordinates (e.g. 51.505, -0.09)' : p.title}
									value={String(value)}
									autoComplete="off"
									onChange={(e) => set(name, e.target.value)}
								/>
							);
						}
					} else {
						field = (
							<textarea
								className={fieldClass}
								placeholder={p.title}
								aria-label={p.title ?? name}
								value={String(value)}
								autoComplete="off"
								required
								onChange={(e) => set(name, e.target.value)}
							/>
						);
					}
				}

				return (
					<div key={name} className="w-full py-0.5">
						<div className="flex w-full justify-between">
							<div className="self-center text-xs font-normal">
								{p.title ?? name}
								{isRequired && <span className="text-muted-foreground"> *required</span>}
							</div>
							<button
								type="button"
								className="hover:bg-muted/70 flex rounded-lg px-2 py-1 text-xs transition"
								aria-label={`${p.title ?? name}: ${value === null ? (isRequired ? 'None' : 'Default') : 'Custom'}`}
								onClick={() => toggleCustom(name)}
							>
								<span className="ml-2 self-center">
									{value === null ? (isRequired ? 'None' : 'Default') : 'Custom'}
								</span>
							</button>
						</div>
						{field && <div className="mt-0.5 mb-0.5 min-w-0">{field}</div>}
						{p.description != null && <SafeMarkdown text={p.description} className="text-muted-foreground" />}
					</div>
				);
			})}
		</>
	);
}
