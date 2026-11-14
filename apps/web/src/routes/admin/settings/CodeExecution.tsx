import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { BoundNumber, BoundSelect } from '@/components/settings/boundFields';
import {
	SettingField,
	SettingRow,
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
/** The only engine; the form sends it for both engine fields, replacing any legacy stored value. */
const ENGINE = 'sandbox';

/** The sandbox settings live under the code interpreter's keys; code execution shares them. */
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
				description="Days a stopped chat's files may go unused before its user is asked whether to delete them; nothing is deleted without an answer. Empty uses 7."
				placeholder="e.g. 7"
				min={1}
			/>
			<BoundNumber
				config={config}
				set={set}
				name={name('MAX_WORKSPACES')}
				label="Sandbox Workspaces per User"
				description="Saved chats' workspaces one user may keep, at least 1. At the limit, a chat that needs a new one gets none until its user removes one. Empty uses 20."
				placeholder="e.g. 20"
				min={1}
			/>
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
			await setCodeExecutionConfig(token, {
				...config!,
				CODE_EXECUTION_ENGINE: ENGINE,
				CODE_INTERPRETER_ENGINE: ENGINE
			});
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
						{/* One set of sandbox fields: under the interpreter when that is on, else here. */}
						{config.ENABLE_CODE_EXECUTION && !config.ENABLE_CODE_INTERPRETER && (
							<SandboxFields config={config} set={patch} />
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
								<SandboxFields config={config} set={patch} />
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
