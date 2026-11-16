import { useQuery } from '@tanstack/react-query';
import { ExternalLinkIcon, RotateCwIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { BoundNumber, BoundSelect } from '@/components/settings/boundFields';
import {
	SettingField,
	SettingRow,
	SettingSwitch,
	SettingsForm,
	SettingsSection,
	SettingTextarea
} from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import { StatusNotice } from '@/components/ui/status-notice';
import { getCodeExecutionConfig, setCodeExecutionConfig } from '@/lib/apis/configs';
import { errorMessage } from '@/lib/apis/errors';
import { getSandboxStatus } from '@/lib/apis/sandbox';
import { useAdminConfigSaved } from '@/lib/settings/useAdminSaved';
import { useConfigDraft } from '@/lib/settings/useConfigDraft';
import { useAuthStore } from '@/lib/stores/authStore';

type Config = Record<string, any>;
/** The only engine; the form sends it for both engine fields, replacing any legacy stored value. */
const ENGINE = 'sandbox';

const SANDBOX_GUIDE = 'https://github.com/epittman23/local-llm/blob/main/docs/guides/sandbox.md';

/**
 * The sandbox manager's reason, as sentences (FBK-4): its "; make backend
 * creates it" tails become an instruction, and a pointer into the guide names
 * the section, since the notice links the guide itself.
 */
export function sandboxReasonSentence(reason: string): string {
	let text = reason
		.trim()
		.replace(/; make backend (creates|starts) it$/, '. Start the stack with make backend, which $1 it')
		.replace(/; build it with (.+)$/, '. Build it with $1')
		.replace(/ \(docs\/guides\/sandbox\.md, "([^"]+)"\)/, ' (see "$1" in the sandbox guide)')
		.replace(/; (\w)/g, (_m, c: string) => `. ${c.toUpperCase()}`);
	text = text.charAt(0).toUpperCase() + text.slice(1);
	return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * The sandbox's state, at the top of the tab whenever code execution or the
 * interpreter is on (#1100, STA-4): ready, checking, not ready (why, what to
 * do, Check again, the guide, the server's words behind Details), or the
 * check itself failed. It used to be one more line of grey help text.
 */
function SandboxStatus() {
	const token = useAuthStore((s) => s.token) ?? '';
	const status = useQuery({
		queryKey: ['admin', 'sandbox-status'],
		queryFn: () => getSandboxStatus(token),
		retry: false
	});
	const checkAgain = (
		<Button variant="outline" size="sm" type="button" disabled={status.isFetching} onClick={() => status.refetch()}>
			<RotateCwIcon aria-hidden />
			{status.isFetching ? 'Checking…' : 'Check again'}
		</Button>
	);
	const guide = (
		<Button variant="ghost" size="sm" asChild>
			<a href={SANDBOX_GUIDE} target="_blank" rel="noopener noreferrer">
				Sandbox guide
				<ExternalLinkIcon aria-hidden />
			</a>
		</Button>
	);
	if (status.isPending) return <StatusNotice tone="pending" title="Checking the sandbox…" />;
	if (status.isError)
		return (
			<StatusNotice
				tone="danger"
				title="Couldn't check the sandbox"
				details={errorMessage(status.error) || null}
				action={checkAgain}
			>
				<p>The server did not answer the check, so whether code can run is unknown.</p>
			</StatusNotice>
		);
	if (status.data.ready) return <StatusNotice tone="success" title="The sandbox is ready" />;
	const reason = status.data.reason?.trim() || null;
	return (
		<StatusNotice
			tone="warning"
			title="The sandbox isn't ready"
			details={reason}
			action={
				<>
					{checkAgain}
					{guide}
				</>
			}
		>
			<p>{reason ? sandboxReasonSentence(reason) : 'The server gave no reason.'}</p>
			<p>Code execution and the code interpreter do nothing until it is ready.</p>
		</StatusNotice>
	);
}

/** The sandbox settings live under the code interpreter's keys; code execution shares them. */
function SandboxFields({ config, set }: { config: Config; set: (patch: Config) => void }) {
	const name = (suffix: string) => `CODE_INTERPRETER_SANDBOX_${suffix}`;
	return (
		<>
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
		dirty,
		discard,
		commit,
		isLoading
	} = useConfigDraft<Config>(['code-execution'], () => getCodeExecutionConfig(token));
	const [saving, setSaving] = useState(false);

	const save = async () => {
		if (!config) return;
		setSaving(true);
		try {
			await setCodeExecutionConfig(token, {
				...config,
				CODE_EXECUTION_ENGINE: ENGINE,
				CODE_INTERPRETER_ENGINE: ENGINE
			});
			commit(config);
			await saved();
		} catch (error) {
			toast.error(`${error}`);
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsForm
			title="Code Execution"
			loading={isLoading}
			onSubmit={save}
			saving={saving}
			dirty={dirty}
			onDiscard={discard}
		>
			{config && (
				<>
					{(config.ENABLE_CODE_EXECUTION || config.ENABLE_CODE_INTERPRETER) && (
						<div className="mb-6">
							<SandboxStatus />
						</div>
					)}
					<SettingsSection title="Code Execution" first>
						<SettingRow
							label="Enable Code Execution"
							description="Lets models run the code they write in the sandbox and read its output. It has no effect while the sandbox is not ready."
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
							description="Gives models the code interpreter tool in chats, which runs code in the sandbox. It has no effect while the sandbox is not ready."
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
