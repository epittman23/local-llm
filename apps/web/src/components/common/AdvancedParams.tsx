import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Plus, RotateCcw } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { getOllamaConfig } from '@/lib/apis/ollama';
import { useAuthStore } from '@/lib/stores/authStore';
import {
	isUnset,
	matchesFilter,
	nextTri,
	overriddenCount,
	type ParamDef,
	type Params,
	paramDefs,
	paramGroups,
	shownValue,
	triLabel
} from './advancedParamDefs';

/** A closed group of rows (FRM-6): a show/hide toggle, then its rows once open. */
function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	const id = useId();
	return (
		<div className="flex flex-col gap-1">
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="self-start aria-expanded:bg-transparent"
				aria-expanded={open}
				aria-controls={id}
				onClick={() => setOpen((o) => !o)}
			>
				{open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
				{title}
				{count > 0 && <span className="text-foreground-muted">({count} set)</span>}
			</Button>
			{open && (
				<div id={id} className="flex flex-col gap-1">
					{children}
				</div>
			)}
		</div>
	);
}

/**
 * The Ollama-only rows, in their own closed group, shown only while the
 * Ollama connection is on (owner decision S3-D3). The switch is read from the
 * admin-only Ollama config; where it cannot be read the group is shown,
 * closed. Only admins see these rows, so only they ask.
 */
function OllamaGroup({ count, children }: { count: number; children: ReactNode }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const config = useQuery({
		queryKey: ['ollama-config'],
		enabled: Boolean(token),
		retry: false,
		queryFn: async () => (await getOllamaConfig(token)) as { ENABLE_OLLAMA_API?: boolean } | null
	});
	if (config.data?.ENABLE_OLLAMA_API === false) return null;
	return (
		<Group title="Ollama only" count={count}>
			<p className="text-caption text-foreground-muted">Used only by models served through Ollama.</p>
			{children}
		</Group>
	);
}

/**
 * Ports chat/Settings/Advanced/AdvancedParams.svelte: the request parameters
 * a model or a chat can override. Each is either at its default (`null`) or
 * "Custom", with a control for the value; a few (streaming, function calling,
 * reasoning tags, think) cycle through named states instead.
 *
 * Grouped (#996, FRM-6): Common first (temperature, max tokens, reasoning
 * effort, seed), then "More parameters", closed, with a filter, then the
 * Ollama-only rows. Each row is named in words with its API name beside it
 * and one line of help (WRD-2); at rest it says "Default", with the value it
 * falls back to when `defaults` knows it. "Reset all" puts every row shown
 * back to its default.
 *
 * Driven by `paramDefs` (advancedParamDefs.ts), so adding a parameter is one
 * row. `admin` reveals the server- and Ollama-level ones; `custom` (with
 * admin) adds free-form name/value pairs under `params.custom_params`.
 * `layout="grid"` is the model editor's three-column form; `"stack"` is the
 * chat settings' single column.
 */
export function AdvancedParams({
	params,
	onChange,
	admin = false,
	custom = false,
	layout = 'stack',
	defaults
}: {
	params: Params;
	onChange: (params: Params) => void;
	admin?: boolean;
	custom?: boolean;
	layout?: 'stack' | 'grid';
	/** The values a row falls back to when not set here (Controls: the user's own defaults), shown at rest. */
	defaults?: Params;
}) {
	const set = (key: string, value: unknown) => onChange({ ...params, [key]: value });
	const [filter, setFilter] = useState('');
	const defs = paramDefs.filter((d) => admin || !d.admin);
	const groups = paramGroups(defs);
	const grid =
		layout === 'grid' ? 'grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3' : 'flex flex-col gap-1';
	const changed = overriddenCount(params, defs);

	const renderControl = (def: ParamDef) => {
		const value = params[def.key];
		switch (def.kind) {
			case 'range': {
				const numberMax = def.numberMax === null ? undefined : (def.numberMax ?? def.max);
				const onNumber = (raw: string) => {
					if (def.integer) {
						// top_k: whole numbers in range only; anything else snaps back.
						const n = Number(raw);
						if (!/^\d+$/.test(raw) || n < def.min || n > def.max) return;
						set(def.key, n);
						return;
					}
					set(def.key, raw === '' ? '' : Number(raw));
				};
				return (
					<div className="flex items-center gap-2">
						<input
							type="range"
							aria-label={`${def.label} slider`}
							min={def.min}
							max={def.max}
							step={def.step}
							value={value}
							onChange={(e) => set(def.key, Number(e.target.value))}
							className="h-2 min-w-0 flex-1 cursor-pointer"
						/>
						<Input
							type="number"
							aria-label={def.label}
							className="w-24 shrink-0"
							min={def.min}
							max={numberMax}
							step={def.numberStep ?? 'any'}
							value={value}
							onChange={(e) => onNumber(e.target.value)}
						/>
					</div>
				);
			}
			case 'number':
				return (
					<Input
						type="number"
						aria-label={def.label}
						placeholder={def.placeholder}
						min={def.min}
						step={def.step}
						autoComplete="off"
						value={value}
						onChange={(e) => set(def.key, e.target.value === '' ? '' : Number(e.target.value))}
					/>
				);
			case 'text':
				return (
					<Input
						type="text"
						aria-label={def.label}
						placeholder={def.placeholder}
						autoComplete="off"
						value={value}
						onChange={(e) => set(def.key, e.target.value)}
					/>
				);
			case 'switch':
				return (
					<div className="flex items-center justify-between">
						<span className="text-foreground-muted">{value ? 'On' : 'Off'}</span>
						<Switch aria-label={def.label} checked={Boolean(value)} onCheckedChange={(c) => set(def.key, c)} />
					</div>
				);
			default:
				return null;
		}
	};

	const renderDef = (def: ParamDef) => {
		const value = params[def.key];
		const fallback = defaults?.[def.key];
		let state: string;
		let onToggle: () => void;
		let body: ReactNode = null;

		if (def.kind === 'tri') {
			state = triLabel(def.tri, value);
			if (state === 'Default' && !isUnset(fallback)) state = `Default (${triLabel(def.tri, fallback)})`;
			onToggle = () => set(def.key, nextTri(def.tri, value));
			if (def.tri === 'reasoning_tags' && Array.isArray(value) && value.length === 2) {
				body = (
					<div className="flex gap-2">
						{['Start tag', 'End tag'].map((label, i) => (
							<Input
								key={label}
								type="text"
								aria-label={label}
								placeholder={label}
								autoComplete="off"
								value={value[i]}
								onChange={(e) => set(def.key, i === 0 ? [e.target.value, value[1]] : [value[0], e.target.value])}
							/>
						))}
					</div>
				);
			} else if (def.tri === 'think' && typeof value === 'string') {
				body = (
					<Input
						type="text"
						aria-label={def.label}
						placeholder="low, medium or high"
						autoComplete="off"
						value={value}
						onChange={(e) => set(def.key, e.target.value)}
					/>
				);
			}
		} else {
			const own = !isUnset(value);
			state = own ? 'Custom' : isUnset(fallback) ? 'Default' : `Default (${shownValue(fallback)})`;
			onToggle = () => set(def.key, own ? null : def.seed);
			body = own ? renderControl(def) : null;
		}

		return (
			<div key={def.key} className="flex min-w-0 flex-col gap-1 py-1">
				<div className="flex items-center justify-between gap-2">
					<div className="min-w-0">
						<span className="font-strong text-foreground">{def.label}</span>
						{def.key !== def.label.toLowerCase() && (
							<span aria-hidden className="ms-1.5 font-mono text-caption text-foreground-muted">
								{def.key}
							</span>
						)}
					</div>
					<Button variant="ghost" size="sm" type="button" aria-label={`${def.label}: ${state}`} onClick={onToggle}>
						{state}
					</Button>
				</div>
				<p className="text-caption text-foreground-muted">{def.help}</p>
				{body}
			</div>
		);
	};

	const customParams = (params.custom_params ?? {}) as Record<string, string>;
	const setCustom = (next: Record<string, string>) => set('custom_params', next);
	const moreShown = groups.more.filter((d) => matchesFilter(d, filter));

	return (
		<div className="flex flex-col gap-2 text-body">
			<div className="flex items-center justify-between gap-2">
				<span className="text-caption font-strong text-foreground-muted">Common</span>
				{changed > 0 && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => onChange({ ...params, ...Object.fromEntries(defs.map((d) => [d.key, null])) })}
					>
						<RotateCcw aria-hidden /> Reset all
					</Button>
				)}
			</div>
			<div className={grid}>{groups.common.map(renderDef)}</div>

			<Group title="More parameters" count={overriddenCount(params, groups.more)}>
				<Input
					type="search"
					aria-label="Filter parameters"
					placeholder="Filter, e.g. top_p or penalty"
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
				/>
				{moreShown.length ? (
					<div className={grid}>{moreShown.map(renderDef)}</div>
				) : (
					<p className="py-2 text-foreground-muted">No parameters match “{filter.trim()}”</p>
				)}
			</Group>

			{admin && groups.ollama.length > 0 && (
				<OllamaGroup count={overriddenCount(params, groups.ollama)}>
					<div className={grid}>{groups.ollama.map(renderDef)}</div>
				</OllamaGroup>
			)}

			{custom && admin && (
				<div className="flex flex-col gap-2">
					{Object.keys(customParams).map((key) => (
						<div key={key} className="flex flex-col gap-1">
							<div className="flex items-center gap-2">
								<Input
									type="text"
									aria-label="Custom parameter name"
									placeholder="Custom parameter name"
									defaultValue={key}
									onBlur={(e) => {
										const next = e.currentTarget.value.trim();
										if (next && next !== key) {
											const { [key]: moved, ...rest } = customParams;
											setCustom({ ...rest, [next]: moved });
										}
									}}
								/>
								<Button
									variant="ghost"
									size="sm"
									type="button"
									aria-label={`Remove ${key}`}
									onClick={() => {
										const { [key]: _removed, ...rest } = customParams;
										setCustom(rest);
									}}
								>
									Remove
								</Button>
							</div>
							<Input
								type="text"
								aria-label="Custom parameter value"
								placeholder="Custom parameter value"
								value={customParams[key]}
								onChange={(e) => setCustom({ ...customParams, [key]: e.target.value })}
							/>
						</div>
					))}
					<Button
						variant="ghost"
						className="self-start"
						type="button"
						onClick={() => setCustom({ ...customParams, custom_param_name: 'custom_param_value' })}
					>
						<Plus aria-hidden /> Add custom parameter
					</Button>
				</div>
			)}
		</div>
	);
}
