import type { ReactNode } from 'react';
import { SensitiveInput } from '@/components/common/SensitiveInput';
import { Tip } from '@/components/common/Tip';
import {
	SettingField,
	SettingInput,
	SettingNumber,
	SettingRow,
	SettingSelect,
	SettingSwitch,
	SettingTextarea
} from './controls';

// Settings tabs edit one flat config object, and each field is "this key of that
// object, with a label and a hint". These bind that shape once: pass the object
// (`config`), a function that merges changes into it (`set`), and the key (`name`).
// A field's element id is derived from the key, so `idPrefix` only matters when a
// tab shows two config objects that share key names.

type Rec = Record<string, any>;
type Bound = { config: Rec; set: (changes: Rec) => void; name: string; idPrefix?: string };
type Described = { label: string; description?: string };

const fieldId = ({ idPrefix = 'field', name }: Pick<Bound, 'idPrefix' | 'name'>) => `${idPrefix}-${name}`;

/** A labelled on/off row. */
export function BoundToggle({ config, set, name, label, description, muted }: Bound & Described & { muted?: boolean }) {
	return (
		<SettingRow label={label} description={description} labelClassName={muted ? 'text-muted-foreground/70' : undefined}>
			{(id) => <SettingSwitch checked={Boolean(config[name])} onChange={(v) => set({ [name]: v })} labelledBy={id} />}
		</SettingRow>
	);
}

/** A labelled text box; `tip` shows on hover, `children` sit under it (help links, warnings). */
export function BoundText({
	config,
	set,
	name,
	idPrefix,
	label,
	description,
	placeholder,
	tip,
	required,
	type = 'text',
	list,
	children
}: Bound &
	Described & {
		placeholder?: string;
		tip?: string;
		required?: boolean;
		type?: string;
		list?: string;
		children?: ReactNode;
	}) {
	const id = fieldId({ idPrefix, name });
	return (
		<SettingField label={label} description={description} htmlFor={id}>
			<Tip content={tip}>
				<SettingInput
					id={id}
					type={type}
					list={list}
					required={required}
					placeholder={placeholder}
					value={config[name] ?? ''}
					onChange={(e) => set({ [name]: e.target.value })}
				/>
			</Tip>
			{children}
		</SettingField>
	);
}

/** A masked box for keys and tokens. */
export function BoundSecret({
	config,
	set,
	name,
	idPrefix,
	label,
	description,
	placeholder,
	required = false
}: Bound & Described & { placeholder: string; required?: boolean }) {
	const id = fieldId({ idPrefix, name });
	return (
		<SettingField label={label} description={description} htmlFor={id}>
			<SensitiveInput
				id={id}
				variant="settings"
				placeholder={placeholder}
				required={required}
				value={config[name] ?? ''}
				onChange={(v) => set({ [name]: v })}
			/>
		</SettingField>
	);
}

/** A number box in which "empty" is stored as null. */
export function BoundNumber({
	config,
	set,
	name,
	idPrefix,
	label,
	description,
	placeholder,
	min,
	max,
	step,
	required,
	title
}: Bound &
	Described & {
		placeholder?: string;
		min?: number;
		max?: number;
		step?: number | string;
		required?: boolean;
		title?: string;
	}) {
	const id = fieldId({ idPrefix, name });
	return (
		<SettingField label={label} description={description} htmlFor={id}>
			<SettingNumber
				id={id}
				placeholder={placeholder}
				min={min}
				max={max}
				step={step}
				required={required}
				title={title}
				autoComplete="off"
				value={config[name]}
				onChange={(v) => set({ [name]: v === '' ? null : v })}
			/>
		</SettingField>
	);
}

/** A labelled multi-line box. */
export function BoundTextarea({
	config,
	set,
	name,
	idPrefix,
	label,
	description,
	placeholder,
	rows,
	children
}: Bound & Described & { placeholder?: string; rows?: number; children?: ReactNode }) {
	const id = fieldId({ idPrefix, name });
	return (
		<SettingField label={label} description={description} htmlFor={id}>
			<SettingTextarea
				id={id}
				rows={rows}
				placeholder={placeholder}
				value={config[name] ?? ''}
				onChange={(e) => set({ [name]: e.target.value })}
			/>
			{children}
		</SettingField>
	);
}

/** A label-and-dropdown row. `onPick` runs after the value is stored (to reset dependent fields). */
export function BoundSelect({
	config,
	set,
	name,
	label,
	description,
	options,
	onPick
}: Bound &
	Described & { options: readonly (readonly [value: string, label: string])[]; onPick?: (value: string) => void }) {
	return (
		<SettingRow label={label} description={description}>
			<SettingSelect
				value={config[name]}
				onChange={(v) => {
					set({ [name]: v });
					onPick?.(v);
				}}
				aria-label={label}
			>
				{options.map(([value, text]) => (
					<option key={value} value={value}>
						{text}
					</option>
				))}
			</SettingSelect>
		</SettingRow>
	);
}
