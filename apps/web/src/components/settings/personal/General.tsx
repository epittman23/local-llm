import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AdvancedParams } from '@/components/common/AdvancedParams';
import type { Params } from '@/components/common/advancedParamDefs';
import { getLanguages } from '@/lib/i18n';
import i18next from '@/lib/i18n';
import { useUserSettings } from '@/lib/settings/userSettings';
import { THEMES, applyTheme, getTheme } from '@/lib/theme';
import { SettingField, SettingRow, SettingSelect, SettingTextarea, SettingsForm, SettingsSection } from '../controls';
import { generalPatch, paramsForForm } from './personalSettings';

/**
 * Ports Settings/General.svelte: theme (applied at once, kept in this
 * browser), language, the default system prompt for new chats, and the
 * user's default generation parameters (saved with the button).
 */
export default function General() {
	const { settings, update } = useUserSettings();
	const languages = useQuery({ queryKey: ['languages'], staleTime: Infinity, queryFn: getLanguages });
	const [theme, setTheme] = useState(getTheme);
	const [lang, setLang] = useState(i18next.language || 'en-US');
	const [system, setSystem] = useState('');
	const [params, setParams] = useState<Params>({});
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!settings) return;
		setSystem(String(settings.system ?? ''));
		setParams(paramsForForm(settings.params as Params | undefined));
	}, [settings]);

	return (
		<SettingsForm
			title="General"
			saving={saving}
			onSubmit={async () => {
				setSaving(true);
				await update(generalPatch(system, params)).then(
					() => toast.success('Settings saved successfully!'),
					(e) => toast.error(`${e}`)
				);
				setSaving(false);
			}}
		>
			<SettingsSection title="WebUI Settings" first>
				<SettingRow label="Theme" description="Choose the color theme used by the interface.">
					{(id) => (
						<SettingSelect
							aria-labelledby={id}
							value={theme}
							onChange={(v) => {
								setTheme(v);
								applyTheme(v);
							}}
						>
							{THEMES.map((t) => (
								<option key={t.id} value={t.id}>
									{t.label}
								</option>
							))}
						</SettingSelect>
					)}
				</SettingRow>
				<SettingRow label="Language" description="Choose the language used for interface text.">
					{(id) => (
						<SettingSelect
							aria-labelledby={id}
							value={lang}
							onChange={(v) => {
								setLang(v);
								void i18next.changeLanguage(v);
								try {
									localStorage.setItem('locale', v);
								} catch {
									/* storage unavailable */
								}
							}}
						>
							{(languages.data ?? []).map((l) => (
								<option key={l.code} value={l.code}>
									{l.title}
								</option>
							))}
						</SettingSelect>
					)}
				</SettingRow>
			</SettingsSection>
			<SettingsSection title="System Prompt">
				<SettingField description="Set the default system prompt for new chats.">
					<SettingTextarea
						aria-label="System Prompt"
						rows={4}
						placeholder="Enter system prompt here"
						value={system}
						onChange={(e) => setSystem(e.target.value)}
					/>
				</SettingField>
			</SettingsSection>
			<SettingsSection title="Advanced Parameters">
				<SettingRow label="Model parameters" description="Show or hide custom generation parameters.">
					<button type="button" className="text-xs underline" onClick={() => setShowAdvanced((s) => !s)}>
						{showAdvanced ? 'Hide' : 'Show'}
					</button>
				</SettingRow>
				{showAdvanced && <AdvancedParams params={params} onChange={setParams} />}
			</SettingsSection>
		</SettingsForm>
	);
}
