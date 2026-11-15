import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AdvancedParams } from '@/components/common/AdvancedParams';
import type { Params } from '@/components/common/advancedParamDefs';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useThemeChoice } from '@/lib/settings/useThemeChoice';
import { isThemeId, THEMES } from '@/lib/theme';
import { SettingField, SettingRow, SettingsForm, SettingsSection, SettingTextarea } from '../controls';
import { generalPatch, paramsForForm } from './personalSettings';

/**
 * Ports Settings/General.svelte: theme (applied at once and saved with the
 * account, labelled as instant since the rest of the tab saves on request:
 * FRM-3, #1089), the default system prompt for new chats, and the user's default
 * generation parameters (saved with the SaveBar). There is no language picker:
 * the app ships only the en-US locale.
 */
export default function General() {
	const { settings, update } = useUserSettings();
	const [theme, chooseTheme] = useThemeChoice();
	const [system, setSystem] = useState('');
	const [params, setParams] = useState<Params>({});
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [saving, setSaving] = useState(false);

	// Keyed on the saved values, not the settings object: saving the theme
	// replaces that object, and must not throw away unsaved edits below.
	const loaded = Boolean(settings);
	const savedSystem = String(settings?.system ?? '');
	const savedParams = JSON.stringify(settings?.params ?? null);
	const reset = useCallback(() => {
		if (!loaded) return;
		setSystem(savedSystem);
		setParams(paramsForForm((JSON.parse(savedParams) ?? undefined) as Params | undefined));
	}, [loaded, savedSystem, savedParams]);
	useEffect(reset, [reset]);
	// Compared as they would be saved, so an emptied field that was never set is not a change.
	const dirty =
		Boolean(settings) &&
		JSON.stringify(generalPatch(system, params)) !==
			JSON.stringify(
				generalPatch(String(settings?.system ?? ''), paramsForForm(settings?.params as Params | undefined))
			);

	return (
		<SettingsForm
			title="General"
			saving={saving}
			dirty={dirty}
			onDiscard={reset}
			onSubmit={async () => {
				setSaving(true);
				await update(generalPatch(system, params)).then(
					() => toast.success('Settings saved'),
					(e) => toast.error(`${e}`)
				);
				setSaving(false);
			}}
		>
			<SettingsSection title="Appearance" first>
				<SettingRow
					label="Theme"
					description="Applies at once and is saved with your account. Black uses pure black surfaces, for OLED screens."
				>
					{(id) => (
						<SegmentedControl
							aria-labelledby={id}
							value={theme}
							onValueChange={(v) => isThemeId(v) && chooseTheme(v)}
							options={THEMES.map((t) => ({ value: t.id, label: t.label, icon: t.icon }))}
						/>
					)}
				</SettingRow>
			</SettingsSection>
			<SettingsSection title="System prompt">
				<SettingField description="The instructions every new chat starts with.">
					<SettingTextarea
						aria-label="System prompt"
						rows={4}
						placeholder="Enter system prompt here"
						value={system}
						onChange={(e) => setSystem(e.target.value)}
					/>
				</SettingField>
			</SettingsSection>
			<SettingsSection title="Advanced parameters">
				<SettingRow label="Model parameters" description="Show or hide custom generation parameters.">
					<Button variant="link" size="xs" type="button" onClick={() => setShowAdvanced((s) => !s)}>
						{showAdvanced ? 'Hide' : 'Show'}
					</Button>
				</SettingRow>
				{showAdvanced && <AdvancedParams params={params} onChange={setParams} />}
			</SettingsSection>
		</SettingsForm>
	);
}
