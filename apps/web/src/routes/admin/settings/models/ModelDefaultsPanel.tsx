import { AdvancedParams } from '@/components/common/AdvancedParams';
import { Disclosure } from '@/components/settings/formFields';
import { CheckboxGrid } from '@/routes/workspace/models/EditorPickers';
import {
	availableFeatures,
	builtinToolItems,
	capabilityItems,
	featureItems
} from '@/routes/workspace/models/modelEditorLabels';
import { PromptSuggestionsEditor } from '@/routes/workspace/models/PromptSuggestionsEditor';
import type { DefaultsState } from './adminModels';

/**
 * Ports admin/Settings/Models/ModelDefaultsPanel.svelte: the capabilities, default
 * features, builtin tools, request parameters and starter prompts a new model
 * starts with. It only edits `value`; the tab decides when that is saved (the
 * Svelte panel fetched and saved its own copy of the models config, so saving
 * it after toggling a default model wrote the older lists back).
 *
 * #960, FRM-6: one closed disclosure holding three more, each a chevron button
 * at body size. They open in the tab's own scroller (no inner scroll box) and
 * bring what they opened into view.
 */
export function ModelDefaultsPanel({
	value,
	onChange
}: {
	value: DefaultsState;
	onChange: (next: DefaultsState) => void;
}) {
	const set = (changes: Partial<DefaultsState>) => onChange({ ...value, ...changes });
	const features = availableFeatures(value.capabilities);

	return (
		<Disclosure
			title="Model defaults"
			description="What a new model starts with until its own settings change it."
			className="shrink-0"
		>
			<div className="flex flex-col gap-1">
				<Disclosure title="Capabilities">
					<CheckboxGrid
						title="What a new model can do"
						items={capabilityItems.filter((c) => !(c.id === 'file_context' && !value.capabilities.file_upload))}
						isChecked={(id) => Boolean(value.capabilities[id])}
						onToggle={(id, checked) => set({ capabilities: { ...value.capabilities, [id]: checked } })}
					/>
					{features.length > 0 && (
						<div className="mt-4">
							<CheckboxGrid
								title="On by default in a new chat"
								items={featureItems.filter((f) => features.includes(f.id))}
								isChecked={(id) => value.defaultFeatureIds.includes(id)}
								onToggle={(id, checked) =>
									set({
										defaultFeatureIds: checked
											? value.defaultFeatureIds.includes(id)
												? value.defaultFeatureIds
												: [...value.defaultFeatureIds, id]
											: value.defaultFeatureIds.filter((x) => x !== id)
									})
								}
							/>
						</div>
					)}
					{value.capabilities.builtin_tools && (
						<div className="mt-4">
							<CheckboxGrid
								title="Builtin tools"
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
				</Disclosure>

				<Disclosure title="Parameters">
					<AdvancedParams admin custom params={value.params} onChange={(params) => set({ params })} />
				</Disclosure>

				<Disclosure title="Prompt suggestions">
					<PromptSuggestionsEditor
						value={value.promptSuggestions}
						onChange={(promptSuggestions) => set({ promptSuggestions })}
					/>
				</Disclosure>
			</div>
		</Disclosure>
	);
}
