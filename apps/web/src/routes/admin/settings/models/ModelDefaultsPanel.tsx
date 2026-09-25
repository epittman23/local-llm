import { type ReactNode, useState } from 'react';
import { AdvancedParams } from '@/components/common/AdvancedParams';
import { CheckboxGrid } from '@/routes/workspace/models/EditorPickers';
import { PromptSuggestionsEditor } from '@/routes/workspace/models/PromptSuggestionsEditor';
import { availableFeatures, builtinToolItems, capabilityItems, featureItems } from '@/routes/workspace/models/modelEditorLabels';
import type { DefaultsState } from './adminModels';

/** A heading row that opens and closes its body. */
function Collapsible({ title, children, className = 'py-0.5' }: { title: string; children: ReactNode; className?: string }) {
	const [open, setOpen] = useState(false);
	return (
		<div>
			<button type="button" aria-expanded={open} className={`flex w-full items-center justify-between gap-4 text-left ${className}`} onClick={() => setOpen((o) => !o)}>
				<span className="text-muted-foreground text-xs">{title}</span>
				<span className="text-muted-foreground/70 text-[0.6875rem]">{open ? 'Close' : 'Configure'}</span>
			</button>
			{open && <div className="max-h-[24rem] overflow-y-auto pr-1 pb-2">{children}</div>}
		</div>
	);
}

/**
 * Ports admin/Settings/Models/ModelDefaultsPanel.svelte: the capabilities, default
 * features, builtin tools, request parameters and starter prompts a new model
 * starts with. It only edits `value`; the tab decides when that is saved (the
 * Svelte panel fetched and saved its own copy of the models config, so saving
 * it after toggling a default model wrote the older lists back).
 */
export function ModelDefaultsPanel({ value, onChange }: { value: DefaultsState; onChange: (next: DefaultsState) => void }) {
	const [expanded, setExpanded] = useState(false);
	const set = (changes: Partial<DefaultsState>) => onChange({ ...value, ...changes });
	const features = availableFeatures(value.capabilities);

	return (
		<div className="shrink-0">
			<div className="flex items-center justify-between gap-4 py-0.5">
				<button type="button" className="text-muted-foreground hover:text-foreground min-w-0 flex-1 text-left text-xs transition-colors" onClick={() => setExpanded((e) => !e)}>
					Model Defaults
				</button>
				<button type="button" aria-expanded={expanded} aria-label="Configure model defaults" className="text-muted-foreground/70 hover:text-foreground shrink-0 text-[0.6875rem] transition-colors" onClick={() => setExpanded((e) => !e)}>
					{expanded ? 'Close' : 'Configure'}
				</button>
			</div>

			{expanded && (
				<div className="mt-0.5 space-y-1">
					<Collapsible title="Model Capabilities">
						<CheckboxGrid
							title="Capabilities"
							items={capabilityItems.filter((c) => !(c.id === 'file_context' && !value.capabilities.file_upload))}
							isChecked={(id) => Boolean(value.capabilities[id])}
							onToggle={(id, checked) => set({ capabilities: { ...value.capabilities, [id]: checked } })}
						/>
						{features.length > 0 && (
							<div className="mt-4">
								<CheckboxGrid
									title="Default Features"
									items={featureItems.filter((f) => features.includes(f.id))}
									isChecked={(id) => value.defaultFeatureIds.includes(id)}
									onToggle={(id, checked) => set({ defaultFeatureIds: checked ? (value.defaultFeatureIds.includes(id) ? value.defaultFeatureIds : [...value.defaultFeatureIds, id]) : value.defaultFeatureIds.filter((x) => x !== id) })}
								/>
							</div>
						)}
						{value.capabilities.builtin_tools && (
							<div className="mt-4">
								<CheckboxGrid
									title="Builtin Tools"
									items={builtinToolItems}
									// Builtin tools are all on unless one is explicitly switched off.
									isChecked={(id) => value.builtinTools[id] !== false}
									onToggle={(id, checked) => {
										const next = { ...value.builtinTools };
										if (checked) delete next[id];
										else next[id] = false;
										set({ builtinTools: next });
									}}
								/>
							</div>
						)}
					</Collapsible>

					<Collapsible title="Model Parameters">
						<AdvancedParams admin custom params={value.params} onChange={(params) => set({ params })} />
					</Collapsible>

					<Collapsible title="Prompt Suggestions">
						<PromptSuggestionsEditor value={value.promptSuggestions} onChange={(promptSuggestions) => set({ promptSuggestions })} />
					</Collapsible>
				</div>
			)}
		</div>
	);
}
