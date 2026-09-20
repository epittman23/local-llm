import { useState } from 'react';
import { toast } from 'sonner';
import { SensitiveInput } from '@/components/common/SensitiveInput';
import {
	SettingField,
	SettingInput,
	SettingNumber,
	SettingRow,
	SettingSelect,
	SettingSwitch,
	SettingTextarea,
	SettingsForm,
	SettingsSection
} from '@/components/settings/controls';
import { getCodeExecutionConfig, setCodeExecutionConfig } from '@/lib/apis/configs';
import { useAdminConfigSaved } from '@/lib/settings/useAdminSaved';
import { useConfigDraft } from '@/lib/settings/useConfigDraft';
import { useAuthStore } from '@/lib/stores/authStore';

type Config = Record<string, any>;
const ENGINES = ['pyodide', 'jupyter'];
const JUPYTER_WARNING = 'Warning: Jupyter execution enables arbitrary code execution, posing severe security risks—proceed with extreme caution.';

/**
 * The engine / Jupyter block that "Code Execution" and "Code Interpreter" each
 * carry: the Svelte tab spells it out twice, identical but for the config-key
 * prefix (`CODE_EXECUTION_` vs `CODE_INTERPRETER_`), so it is one component here.
 */
function EngineFields({
	config,
	set,
	prefix,
	engineLabel,
	engineHint,
	urlHint
}: {
	config: Config;
	set: (patch: Config) => void;
	prefix: 'CODE_EXECUTION' | 'CODE_INTERPRETER';
	engineLabel: string;
	engineHint: string;
	urlHint: string;
}) {
	const engine = config[`${prefix}_ENGINE`];
	const auth = config[`${prefix}_JUPYTER_AUTH`];
	const key = (suffix: string) => `${prefix}_${suffix}`;
	return (
		<>
			<SettingRow label={engineLabel} description={engine === 'jupyter' ? JUPYTER_WARNING : engineHint}>
				<SettingSelect value={engine ?? ''} onChange={(v) => set({ [key('ENGINE')]: v })} required aria-label={engineLabel}>
					<option disabled value="">
						Select a engine
					</option>
					{ENGINES.map((e) => (
						<option key={e} value={e}>
							{e}
							{e === 'jupyter' ? ' (Legacy)' : ''}
						</option>
					))}
				</SettingSelect>
			</SettingRow>
			{engine === 'jupyter' && (
				<>
					<SettingField label="Jupyter URL" description={urlHint}>
						<SettingInput type="text" placeholder="Enter Jupyter URL" value={config[key('JUPYTER_URL')] ?? ''} onChange={(e) => set({ [key('JUPYTER_URL')]: e.target.value })} autoComplete="off" />
					</SettingField>
					{/* LICENSE covers this Open WebUI wordmark.
					    Do not alter, remove, obscure, or replace it except as LICENSE permits:
					    https://docs.openwebui.com/license. */}
					<SettingRow label="Jupyter Auth" description="Select how Open WebUI authenticates with the Jupyter server.">
						<SettingSelect value={auth ?? ''} onChange={(v) => set({ [key('JUPYTER_AUTH')]: v })} aria-label="Jupyter Auth">
							<option value="">None</option>
							<option value="token">Token</option>
							<option value="password">Password</option>
						</SettingSelect>
					</SettingRow>
					{auth && (
						<SettingField label={auth === 'password' ? 'Jupyter Password' : 'Jupyter Token'} description="Credentials used to authenticate with the Jupyter server.">
							<SensitiveInput
								variant="settings"
								placeholder={auth === 'password' ? 'Enter Jupyter Password' : 'Enter Jupyter Token'}
								value={config[key(auth === 'password' ? 'JUPYTER_AUTH_PASSWORD' : 'JUPYTER_AUTH_TOKEN')] ?? ''}
								onChange={(v) => set({ [key(auth === 'password' ? 'JUPYTER_AUTH_PASSWORD' : 'JUPYTER_AUTH_TOKEN')]: v })}
								autoComplete="off"
							/>
						</SettingField>
					)}
					<SettingField label="Code Execution Timeout" description="Maximum runtime in seconds before execution is stopped.">
						<SettingNumber value={config[key('JUPYTER_TIMEOUT')]} onChange={(v) => set({ [key('JUPYTER_TIMEOUT')]: v })} placeholder="e.g. 60" autoComplete="off" />
					</SettingField>
				</>
			)}
		</>
	);
}

/** Ports admin/Settings/CodeExecution.svelte. */
export default function CodeExecution() {
	const token = useAuthStore((s) => s.token) ?? '';
	const saved = useAdminConfigSaved();
	const { draft: config, patch, isLoading } = useConfigDraft<Config>(['code-execution'], () => getCodeExecutionConfig(token));
	const [saving, setSaving] = useState(false);

	const save = async () => {
		setSaving(true);
		try {
			await setCodeExecutionConfig(token, config!);
			await saved();
		} catch (error) {
			toast.error(`${error}`);
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsForm title="Code Execution" loading={isLoading} onSubmit={save} saving={saving}>
			{config && (
				<>
					<SettingsSection title="Code Execution" first>
						<SettingRow label="Enable Code Execution" description="Allow models to run generated code and return execution results.">
							{(id) => <SettingSwitch checked={config.ENABLE_CODE_EXECUTION} onChange={(v) => patch({ ENABLE_CODE_EXECUTION: v })} labelledBy={id} />}
						</SettingRow>
						{config.ENABLE_CODE_EXECUTION && (
							<EngineFields
								config={config}
								set={patch}
								prefix="CODE_EXECUTION"
								engineLabel="Code Execution Engine"
								engineHint="Choose the runtime used for generated code blocks."
								urlHint="Connect code execution to a Jupyter server endpoint."
							/>
						)}
					</SettingsSection>

					<SettingsSection title="Code Interpreter">
						<SettingRow label="Enable Code Interpreter" description="Allow models to use the code interpreter tool during chats.">
							{(id) => <SettingSwitch checked={config.ENABLE_CODE_INTERPRETER} onChange={(v) => patch({ ENABLE_CODE_INTERPRETER: v })} labelledBy={id} />}
						</SettingRow>
						{config.ENABLE_CODE_INTERPRETER && (
							<>
								<EngineFields
									config={config}
									set={patch}
									prefix="CODE_INTERPRETER"
									engineLabel="Code Interpreter Engine"
									engineHint="Choose the runtime used by the code interpreter tool."
									urlHint="Connect code interpreter to a Jupyter server endpoint."
								/>
								<SettingField label="Code Interpreter Prompt Template" description="Leave empty to use the default prompt, or enter a custom prompt.">
									<SettingTextarea
										value={config.CODE_INTERPRETER_PROMPT_TEMPLATE ?? ''}
										onChange={(e) => patch({ CODE_INTERPRETER_PROMPT_TEMPLATE: e.target.value })}
										placeholder="Leave empty to use the default prompt, or enter a custom prompt"
									/>
								</SettingField>
							</>
						)}
					</SettingsSection>
				</>
			)}
		</SettingsForm>
	);
}
