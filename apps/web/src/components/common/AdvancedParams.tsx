import { Plus } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { Tip } from '@/components/common/Tip';
import { type ParamDef, type Params, isUnset, nextTri, paramDefs, triLabel } from './advancedParamDefs';

const inputClass = 'w-full bg-transparent text-sm outline-hidden';
const toggleButton = 'flex shrink-0 rounded-sm p-1 px-3 text-xs outline-hidden transition';

/**
 * Ports chat/Settings/Advanced/AdvancedParams.svelte: the request parameters
 * (temperature, top_p, ...) a model or a chat can override. Each is either at its
 * default (`null`) or "Custom", with a control for the value; a few (streaming,
 * function calling, reasoning tags, think) cycle through named states instead.
 *
 * Driven by `paramDefs` (advancedParamDefs.ts), so adding a parameter is one row.
 * `admin` reveals the server- and Ollama-level ones; `custom` (with admin) adds
 * free-form name/value pairs under `params.custom_params`. `layout="grid"` is the
 * model editor's three-column form; `"stack"` is the chat settings' single column.
 */
export function AdvancedParams({
	params,
	onChange,
	admin = false,
	custom = false,
	layout = 'stack'
}: {
	params: Params;
	onChange: (params: Params) => void;
	admin?: boolean;
	custom?: boolean;
	layout?: 'stack' | 'grid';
}) {
	const set = (key: string, value: unknown) => onChange({ ...params, [key]: value });

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
					<div className="mt-0.5 flex space-x-2">
						<div className="flex-1">
							<input
								type="range"
								aria-label={`${def.label} slider`}
								min={def.min}
								max={def.max}
								step={def.step}
								value={value}
								onChange={(e) => set(def.key, Number(e.target.value))}
								className="bg-muted h-2 w-full cursor-pointer appearance-none rounded-lg"
							/>
						</div>
						<div>
							<input
								type="number"
								aria-label={def.label}
								className="w-14 bg-transparent text-center"
								min={def.min}
								max={numberMax}
								step={def.numberStep ?? 'any'}
								value={value}
								onChange={(e) => onNumber(e.target.value)}
							/>
						</div>
					</div>
				);
			}
			case 'number':
				return (
					<input
						className={cn(inputClass, 'mt-0.5')}
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
					<input
						className={cn(inputClass, 'mt-0.5')}
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
					<div className="mt-1 flex items-center justify-between">
						<div className="text-muted-foreground text-xs">{value ? 'Enabled' : 'Disabled'}</div>
						<div className="pr-2">
							<Switch aria-label={def.label} checked={Boolean(value)} onCheckedChange={(c) => set(def.key, c)} />
						</div>
					</div>
				);
			default:
				return null;
		}
	};

	const renderDef = (def: ParamDef) => {
		let header: React.ReactNode;
		let body: React.ReactNode = null;

		if (def.kind === 'tri') {
			header = (
				<button type="button" className={toggleButton} aria-label={`${def.label}: ${triLabel(def.tri, params[def.key])}`} onClick={() => set(def.key, nextTri(def.tri, params[def.key]))}>
					<span className="ml-2 self-center">{triLabel(def.tri, params[def.key])}</span>
				</button>
			);
			const v = params[def.key];
			if (def.tri === 'reasoning_tags' && Array.isArray(v) && v.length === 2) {
				body = (
					<div className="mt-0.5 flex space-x-2">
						{['Start Tag', 'End Tag'].map((label, i) => (
							<div key={label} className="flex-1">
								<input
									className={inputClass}
									type="text"
									aria-label={label}
									placeholder={label}
									autoComplete="off"
									value={v[i]}
									onChange={(e) => set(def.key, i === 0 ? [e.target.value, v[1]] : [v[0], e.target.value])}
								/>
							</div>
						))}
					</div>
				);
			} else if (def.tri === 'think' && typeof v === 'string') {
				body = (
					<div className="mt-0.5 flex space-x-2">
						<div className="flex-1">
							<input className={inputClass} type="text" aria-label={def.label} placeholder="e.g. 'low', 'medium', 'high'" autoComplete="off" value={v} onChange={(e) => set(def.key, e.target.value)} />
						</div>
					</div>
				);
			}
		} else {
			const custom = !isUnset(params[def.key]);
			header = (
				<button type="button" className={toggleButton} aria-label={`${def.label}: ${custom ? 'Custom' : 'Default'}`} onClick={() => set(def.key, custom ? null : def.seed)}>
					<span className="ml-2 self-center">{custom ? 'Custom' : 'Default'}</span>
				</button>
			);
			body = custom ? renderControl(def) : null;
		}

		return (
			<div key={def.key} className="w-full justify-between py-0.5">
				<Tip content={def.tip} side="top">
					<div className="flex w-full justify-between">
						<div className="self-center text-xs">{def.label}</div>
						{header}
					</div>
				</Tip>
				{body}
			</div>
		);
	};

	const customParams = (params.custom_params ?? {}) as Record<string, string>;
	const setCustom = (next: Record<string, string>) => set('custom_params', next);

	return (
		<div
			className={cn(
				'text-muted-foreground text-xs',
				layout === 'grid' ? 'grid grid-cols-1 gap-x-5 gap-y-1 sm:grid-cols-2 lg:grid-cols-3' : 'space-y-1'
			)}
		>
			{paramDefs.filter((d) => admin || !d.admin).map(renderDef)}

			{custom && admin && (
				<div className="col-span-full flex flex-col justify-center">
					{Object.keys(customParams).map((key) => (
						<div key={key} className="mb-1 w-full justify-between py-0.5">
							<div className="flex w-full justify-between">
								<div className="self-center text-xs">
									<input
										type="text"
										className="w-full bg-transparent text-xs outline-none"
										aria-label="Custom Parameter Name"
										placeholder="Custom Parameter Name"
										defaultValue={key}
										onBlur={(e) => {
											const next = e.currentTarget.value.trim();
											if (next && next !== key) {
												const { [key]: moved, ...rest } = customParams;
												setCustom({ ...rest, [next]: moved });
											}
										}}
									/>
								</div>
								<button
									type="button"
									className={toggleButton}
									onClick={() => {
										const { [key]: _removed, ...rest } = customParams;
										setCustom(rest);
									}}
								>
									Remove
								</button>
							</div>
							<div className="mt-0.5 flex space-x-2">
								<div className="flex-1">
									<input
										type="text"
										className="w-full bg-transparent text-sm outline-hidden"
										aria-label="Custom Parameter Value"
										placeholder="Custom Parameter Value"
										value={customParams[key]}
										onChange={(e) => setCustom({ ...customParams, [key]: e.target.value })}
									/>
								</div>
							</div>
						</div>
					))}
					<button
						type="button"
						className="mt-1 mb-5 flex w-full items-center justify-center gap-2 text-center"
						onClick={() => setCustom({ ...customParams, custom_param_name: 'custom_param_value' })}
					>
						<Plus className="size-4" />
						<div>Add Custom Parameter</div>
					</button>
				</div>
			)}
		</div>
	);
}
