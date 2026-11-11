import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { SensitiveInput } from '@/components/common/SensitiveInput';
import { BoundNumber, BoundSelect } from '@/components/settings/boundFields';
import {
	SettingField,
	SettingInput,
	SettingRow,
	SettingSelect,
	SettingSwitch,
	SettingTextarea,
	SettingsForm,
	SettingsSection
} from '@/components/settings/controls';
import { getCodeExecutionConfig, setCodeExecutionConfig } from '@/lib/apis/configs';
import { getSandboxStatus } from '@/lib/apis/sandbox';
import { useAdminConfigSaved } from '@/lib/settings/useAdminSaved';
import { useConfigDraft } from '@/lib/settings/useConfigDraft';
import { useAuthStore } from '@/lib/stores/authStore';

type Config = Record<string, any>;
const ENGINES = ['pyodide', 'jupyter', 'sandbox'];
const JUPYTER_WARNING =
	'Warning: Jupyter execution enables arbitrary code execution, posing severe security risks—proceed with extreme caution.';

/** The sandbox settings live under the code interpreter's keys; the code execution engine shares them. */
function SandboxFields({ config, set }: { config: Config; set: (patch: Config) => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const status = useQuery({
		queryKey: ['admin', 'sandbox-status'],
		queryFn: () => getSandboxStatus(token),
		retry: false
	});
	const text = status.isPending
		? 'Checking the sandbox...'
		: status.isError
			? 'Could not check the sandbox.'
			: status.data.ready
				? 'The sandbox is ready.'
				: `The sandbox is unavailable: ${status.data.reason ?? 'no reason given'}`;
	const name = (suffix: string) => `CODE_INTERPRETER_SANDBOX_${suffix}`;
	return (
		<>
			<p role="status" className="text-muted-foreground/70 text-[0.6875rem]">
				{text}
			</p>
			<BoundSelect
				config={{ ...config, [name('DEFAULT_IMAGE')]: config[name('DEFAULT_IMAGE')] ?? 'data' }}
				set={set}
				name={name('DEFAULT_IMAGE')}
				label="Sandbox Default Image"
				description="The image a chat's sandbox starts with: data (Python, R, LaTeX) or web (Node, Playwright)."
				options={[
					['data', 'data'],
					['web', 'web']
				]}
			/>
			<BoundNumber
				config={config}
				set={set}
				name={name('TIMEOUT')}
				label="Sandbox Command Timeout"
				description="Seconds a command may run before it is stopped, from 1 to 300. Empty uses 60."
				placeholder="e.g. 60"
				min={1}
				max={300}
			/>
			<BoundNumber
				config={config}
				set={set}
				name={name('MAX_RUNNING')}
				label="Sandbox Maximum Running"
				description="Sandboxes running at once, from 1 to 16. Each running sandbox can hold 4 GiB of memory and 2 CPUs, so 16 at once is 64 GiB. Empty uses 4."
				placeholder="e.g. 4"
				min={1}
				max={16}
			/>
			<BoundNumber
				config={config}
				set={set}
				name={name('IDLE_MINUTES')}
				label="Sandbox Idle Minutes"
				description="Minutes without a command after which a sandbox is stopped; its files stay. Empty uses 30."
				placeholder="e.g. 30"
				min={1}
			/>
			<BoundNumber
				config={config}
				set={set}
				name={name('RETENTION_DAYS')}
				label="Sandbox Retention Days"
				description="Days a stopped chat's files are kept before they are deleted. Empty uses 7."
				placeholder="e.g. 7"
				min={1}
			/>
		</>
	);
}

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
	// One set of sandbox fields: under the interpreter's engine when that is the sandbox, else under this one.
	const interpreterShowsSandbox = config.ENABLE_CODE_INTERPRETER && config.CODE_INTERPRETER_ENGINE === 'sandbox';
	const showSandbox = engine === 'sandbox' && (prefix === 'CODE_INTERPRETER' || !interpreterShowsSandbox);
	return (
		<>
			<SettingRow label={engineLabel} description={engine === 'jupyter' ? JUPYTER_WARNING : engineHint}>
				<SettingSelect
					value={engine ?? ''}
					onChange={(v) => set({ [key('ENGINE')]: v })}
					required
					aria-label={engineLabel}
				>
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
			{showSandbox && <SandboxFields config={config} set={set} />}
			{engine === 'jupyter' && (
				<>
					<SettingField label="Jupyter URL" description={urlHint}>
						<SettingInput
							type="text"
							placeholder="Enter Jupyter URL"
							value={config[key('JUPYTER_URL')] ?? ''}
							onChange={(e) => set({ [key('JUPYTER_URL')]: e.target.value })}
							autoComplete="off"
						/>
					</SettingField>
					<SettingRow label="Jupyter Auth" description="Select how Local LLM authenticates with the Jupyter server.">
						<SettingSelect
							value={auth ?? ''}
							onChange={(v) => set({ [key('JUPYTER_AUTH')]: v })}
							aria-label="Jupyter Auth"
						>
							<option value="">None</option>
							<option value="token">Token</option>
							<option value="password">Password</option>
						</SettingSelect>
					</SettingRow>
					{auth && (
						<SettingField
							label={auth === 'password' ? 'Jupyter Password' : 'Jupyter Token'}
							description="Credentials used to authenticate with the Jupyter server."
						>
							<SensitiveInput
								variant="settings"
								placeholder={auth === 'password' ? 'Enter Jupyter Password' : 'Enter Jupyter Token'}
								value={config[key(auth === 'password' ? 'JUPYTER_AUTH_PASSWORD' : 'JUPYTER_AUTH_TOKEN')] ?? ''}
								onChange={(v) =>
									set({ [key(auth === 'password' ? 'JUPYTER_AUTH_PASSWORD' : 'JUPYTER_AUTH_TOKEN')]: v })
								}
								autoComplete="off"
							/>
						</SettingField>
					)}
					<BoundNumber
						config={config}
						set={set}
						name={key('JUPYTER_TIMEOUT')}
						label="Code Execution Timeout"
						description="Longest wait in seconds for any output before a run is stopped. Empty uses 60."
						placeholder="e.g. 60"
					/>
				</>
			)}
		</>
	);
}

/** Ports admin/Settings/CodeExecution.svelte. */
export default function CodeExecution() {
	const token = useAuthStore((s) => s.token) ?? '';
	const saved = useAdminConfigSaved();
	const {
		draft: config,
		patch,
		isLoading
	} = useConfigDraft<Config>(['code-execution'], () => getCodeExecutionConfig(token));
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
						<SettingRow
							label="Enable Code Execution"
							description="Allow models to run generated code and return execution results."
						>
							{(id) => (
								<SettingSwitch
									checked={config.ENABLE_CODE_EXECUTION}
									onChange={(v) => patch({ ENABLE_CODE_EXECUTION: v })}
									labelledBy={id}
								/>
							)}
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
						<SettingRow
							label="Enable Code Interpreter"
							description="Allow models to use the code interpreter tool during chats."
						>
							{(id) => (
								<SettingSwitch
									checked={config.ENABLE_CODE_INTERPRETER}
									onChange={(v) => patch({ ENABLE_CODE_INTERPRETER: v })}
									labelledBy={id}
								/>
							)}
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
								<SettingField
									label="Code Interpreter Prompt Template"
									description="Leave empty to use the default prompt, or enter a custom prompt."
								>
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
