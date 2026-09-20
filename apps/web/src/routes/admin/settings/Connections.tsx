import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { SettingRow, SettingSwitch, SettingsForm, SettingsSection } from '@/components/settings/controls';
import { AddConnectionModal } from '@/components/settings/AddConnectionModal';
import type { Connection } from '@/components/settings/connectionModel';
import { Switch } from '@/components/ui/switch';
import { getModels } from '@/lib/apis';
import { getConnectionsConfig, setConnectionsConfig } from '@/lib/apis/configs';
import { getOllamaConfig, updateOllamaConfig } from '@/lib/apis/ollama';
import { getOpenAIConfig, getOpenAIModels, updateOpenAIConfig } from '@/lib/apis/openai';
import { useAdminConfigSaved } from '@/lib/settings/useAdminSaved';
import { useAuthStore } from '@/lib/stores/authStore';
import { type ConfigMap, alignKeys, normalizeConfigs, removeConnection, stripTrailingSlashes } from './connectionsList';

type OpenAIState = { enabled: boolean; urls: string[]; keys: string[]; configs: ConfigMap };
type OllamaState = { enabled: boolean; urls: string[]; configs: ConfigMap };
type DirectState = { ENABLE_DIRECT_CONNECTIONS?: boolean; ENABLE_BASE_MODELS_CACHE?: boolean };

const iconButton = 'text-muted-foreground hover:text-foreground rounded p-1 transition';

/**
 * One connection: a read-only URL, a cog that opens the editor, an enable switch.
 * (The URL is shown, not edited, in the row -- the modal is where it changes.)
 * A disabled connection is dimmed.
 */
function ConnectionRow({
	url,
	requestHint,
	config,
	pipeline = false,
	ollama = false,
	keyValue,
	onSubmit,
	onDelete
}: {
	url: string;
	requestHint: string;
	config: Record<string, any>;
	pipeline?: boolean;
	ollama?: boolean;
	keyValue: string;
	onSubmit: (connection: Connection) => void;
	onDelete: () => void;
}) {
	const [editing, setEditing] = useState(false);
	const enabled = config?.enable ?? true;
	return (
		<>
			<AddConnectionModal open={editing} onOpenChange={setEditing} edit ollama={ollama} connection={{ url, key: keyValue, config }} onSubmit={onSubmit} onDelete={onDelete} />
			<div className="flex items-center gap-1.5">
				<Tip content={requestHint} side="top">
					<div className={`relative flex min-w-0 flex-1 items-center ${enabled ? '' : 'opacity-50'}`}>
						<input
							className="bg-muted/40 h-7 w-full rounded-lg border px-2 text-xs outline-hidden"
							placeholder={ollama ? 'Enter URL (e.g. http://localhost:11434)' : 'API Base URL'}
							aria-label={ollama ? 'Ollama URL' : 'API Base URL'}
							value={url}
							readOnly
						/>
						{pipeline && (
							<span className="text-muted-foreground absolute end-2 text-[0.625rem]" title="Pipelines">
								pipeline
							</span>
						)}
					</div>
				</Tip>
				<Tip content="Configure">
					<button type="button" aria-label={`Configure ${url}`} className={iconButton} onClick={() => setEditing(true)}>
						<Settings className="size-4" />
					</button>
				</Tip>
				<Tip content={enabled ? 'Enabled' : 'Disabled'}>
					<span>
						<Switch
							size="sm"
							aria-label={`${enabled ? 'Disable' : 'Enable'} ${url}`}
							checked={enabled}
							onCheckedChange={(checked) => onSubmit({ url, key: keyValue, config: { ...config, enable: checked } })}
						/>
					</span>
				</Tip>
			</div>
		</>
	);
}

/**
 * Ports admin/Settings/Connections.svelte: the OpenAI-compatible and Ollama
 * upstreams (this is where an OpenRouter or llama.cpp base URL and key live), plus
 * the two "user connections" switches.
 *
 * Every change saves at once -- toggling an API on or off, adding, editing or
 * deleting a connection -- as in the original; the Save button re-saves both APIs.
 * The connection list is edited through pure helpers (connectionsList.ts): URLs
 * lose a trailing slash, keys are kept the same length as the URLs, and deleting
 * one re-indexes the config map, which is keyed by list position.
 *
 * Not here yet: the Ollama row's "Manage" (pull / delete models) button, which
 * opens ManageOllama and is ported with the Models tab.
 */
export default function Connections() {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const saved = useAdminConfigSaved();
	const [openai, setOpenAI] = useState<OpenAIState | null>(null);
	const [ollama, setOllama] = useState<OllamaState | null>(null);
	const [direct, setDirect] = useState<DirectState | null>(null);
	const [pipelineUrls, setPipelineUrls] = useState<Record<string, boolean>>({});
	const [showAddOpenAI, setShowAddOpenAI] = useState(false);
	const [showAddOllama, setShowAddOllama] = useState(false);
	const [refreshing, setRefreshing] = useState(false);

	const loaded = useQuery({
		queryKey: ['admin-settings', 'connections'],
		queryFn: async () => {
			const [o, l, c] = await Promise.all([getOllamaConfig(token), getOpenAIConfig(token), getConnectionsConfig(token)]);
			return { ollama: o, openai: l, direct: c };
		},
		gcTime: 0,
		staleTime: Infinity,
		refetchOnWindowFocus: false
	});

	// Seed local state once from the server (edits after that are local).
	useEffect(() => {
		const d = loaded.data;
		if (!d || openai) return;
		const openaiUrls: string[] = d.openai?.OPENAI_API_BASE_URLS ?? [];
		const ollamaUrls: string[] = d.ollama?.OLLAMA_BASE_URLS ?? [];
		setOpenAI({
			enabled: Boolean(d.openai?.ENABLE_OPENAI_API),
			urls: openaiUrls,
			keys: d.openai?.OPENAI_API_KEYS ?? [],
			configs: d.openai?.ENABLE_OPENAI_API ? normalizeConfigs(openaiUrls, d.openai?.OPENAI_API_CONFIGS) : (d.openai?.OPENAI_API_CONFIGS ?? {})
		});
		setOllama({
			enabled: Boolean(d.ollama?.ENABLE_OLLAMA_API),
			urls: ollamaUrls,
			configs: d.ollama?.ENABLE_OLLAMA_API ? normalizeConfigs(ollamaUrls, d.ollama?.OLLAMA_API_CONFIGS) : (d.ollama?.OLLAMA_API_CONFIGS ?? {})
		});
		setDirect(d.direct ?? {});
	}, [loaded.data, openai]);
	useEffect(() => {
		if (loaded.isError) toast.error(`${loaded.error}`);
	}, [loaded.isError, loaded.error]);

	// Which enabled OpenAI connections front a Pipelines server (shows a marker).
	useEffect(() => {
		if (!openai?.enabled) return;
		let cancelled = false;
		openai.urls.forEach(async (url, idx) => {
			if (!(openai.configs[idx]?.enable ?? true)) return;
			try {
				const res = await getOpenAIModels(token, idx);
				if (!cancelled && res?.pipelines) setPipelineUrls((p) => ({ ...p, [url]: true }));
			} catch {
				/* an unreachable upstream just gets no marker */
			}
		});
		return () => {
			cancelled = true;
		};
		// Once, when the list first arrives.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [Boolean(openai)]);

	const refreshModels = () => {
		queryClient.invalidateQueries({ queryKey: ['models'] });
		queryClient.invalidateQueries({ queryKey: ['models-all'] });
	};

	const saveOpenAI = async (next: OpenAIState) => {
		const urls = stripTrailingSlashes(next.urls);
		const state = { ...next, urls, keys: alignKeys(urls, next.keys) };
		setOpenAI(state);
		const res = await updateOpenAIConfig(token, {
			ENABLE_OPENAI_API: state.enabled,
			OPENAI_API_BASE_URLS: state.urls,
			OPENAI_API_KEYS: state.keys,
			OPENAI_API_CONFIGS: state.configs
		}).catch((error) => toast.error(`${error}`));
		if (res) {
			toast.success('OpenAI API settings updated');
			refreshModels();
		}
	};

	const saveOllama = async (next: OllamaState) => {
		const state = { ...next, urls: stripTrailingSlashes(next.urls) };
		setOllama(state);
		const res = await updateOllamaConfig(token, {
			ENABLE_OLLAMA_API: state.enabled,
			OLLAMA_BASE_URLS: state.urls,
			OLLAMA_API_CONFIGS: state.configs
		}).catch((error) => toast.error(`${error}`));
		if (res) {
			toast.success('Ollama API settings updated');
			refreshModels();
		}
	};

	const saveDirect = async (next: DirectState) => {
		setDirect(next);
		const res = await setConnectionsConfig(token, next).catch((error) => toast.error(`${error}`));
		if (res) {
			toast.success('Connections settings updated');
			refreshModels();
			await saved();
		}
	};

	const refreshModelList = async () => {
		setRefreshing(true);
		try {
			await getModels(token, null, false, true);
			refreshModels();
			toast.success('Model list refreshed');
		} catch (error) {
			toast.error(`${error}`);
		} finally {
			setRefreshing(false);
		}
	};

	const submitAll = async () => {
		await Promise.all([openai && saveOpenAI(openai), ollama && saveOllama(ollama)]);
		await saved();
	};

	const ready = openai && ollama && direct;
	const heading = 'text-xs font-normal';

	return (
		<SettingsForm title="Connections" loading={!ready && !loaded.isError} onSubmit={submitAll}>
			{ready && (
				<>
					<AddConnectionModal
						open={showAddOpenAI}
						onOpenChange={setShowAddOpenAI}
						onSubmit={(c) => saveOpenAI({ ...openai, urls: [...openai.urls, c.url], keys: [...openai.keys, c.key], configs: { ...openai.configs, [openai.urls.length]: c.config } })}
					/>
					<AddConnectionModal
						open={showAddOllama}
						onOpenChange={setShowAddOllama}
						ollama
						onSubmit={(c) => saveOllama({ ...ollama, urls: [...ollama.urls, c.url], configs: { ...ollama.configs, [ollama.urls.length]: { ...c.config, key: c.key } } })}
					/>

					<SettingsSection first>
						<SettingRow label="OpenAI API">
							{(id) => <SettingSwitch checked={openai.enabled} onChange={(enabled) => saveOpenAI({ ...openai, enabled })} labelledBy={id} />}
						</SettingRow>
						{openai.enabled && (
							<div className="flex flex-col gap-1.5">
								<div className="flex items-center justify-between">
									<div className={heading}>Manage OpenAI API Connections</div>
									<Tip content="Add Connection">
										<button type="button" aria-label="Add OpenAI Connection" className={iconButton} onClick={() => setShowAddOpenAI(true)}>
											<Plus className="size-4" />
										</button>
									</Tip>
								</div>
								<div className="flex flex-col gap-1.5">
									{openai.urls.map((url, idx) => (
										<ConnectionRow
											key={`${idx}:${url}`}
											url={url}
											keyValue={openai.keys[idx] ?? ''}
											config={openai.configs[idx] ?? {}}
											pipeline={Boolean(pipelineUrls[url])}
											requestHint={`WebUI will make requests to "${url}/chat/completions"`}
											onSubmit={(c) =>
												saveOpenAI({
													...openai,
													urls: openai.urls.map((u, i) => (i === idx ? c.url : u)),
													keys: openai.keys.map((k, i) => (i === idx ? c.key : k)),
													configs: { ...openai.configs, [idx]: c.config }
												})
											}
											onDelete={() => {
												const r = removeConnection(openai.urls, openai.keys, openai.configs, idx);
												saveOpenAI({ ...openai, urls: r.urls, keys: r.keys ?? [], configs: r.configs });
											}}
										/>
									))}
								</div>
							</div>
						)}

						<SettingRow label="Ollama API">
							{(id) => <SettingSwitch checked={ollama.enabled} onChange={(enabled) => saveOllama({ ...ollama, enabled })} labelledBy={id} />}
						</SettingRow>
						{ollama.enabled && (
							<div className="flex flex-col gap-1.5">
								<div className="flex items-center justify-between">
									<div className={heading}>Manage Ollama API Connections</div>
									<Tip content="Add Connection">
										<button type="button" aria-label="Add Ollama Connection" className={iconButton} onClick={() => setShowAddOllama(true)}>
											<Plus className="size-4" />
										</button>
									</Tip>
								</div>
								<div className="flex flex-col gap-1.5">
									{ollama.urls.map((url, idx) => (
										<ConnectionRow
											key={`${idx}:${url}`}
											ollama
											url={url}
											keyValue={ollama.configs[idx]?.key ?? ''}
											config={ollama.configs[idx] ?? {}}
											requestHint={`WebUI will make requests to "${url}/api/chat"`}
											onSubmit={(c) =>
												saveOllama({
													...ollama,
													urls: ollama.urls.map((u, i) => (i === idx ? c.url : u)),
													configs: { ...ollama.configs, [idx]: { ...c.config, key: c.key } }
												})
											}
											onDelete={() => {
												const r = removeConnection(ollama.urls, null, ollama.configs, idx);
												saveOllama({ ...ollama, urls: r.urls, configs: r.configs });
											}}
										/>
									))}
								</div>
								<div className="text-muted-foreground text-xs">
									Trouble accessing Ollama?{' '}
									<a className="text-foreground underline" href="https://github.com/open-webui/open-webui#troubleshooting" target="_blank" rel="noreferrer">
										Click here for help.
									</a>
								</div>
							</div>
						)}
					</SettingsSection>

					<SettingsSection title="User Connections">
						<SettingRow label="Direct Connections" description="Direct Connections allow users to connect to their own OpenAI compatible API endpoints.">
							{(id) => <SettingSwitch checked={Boolean(direct.ENABLE_DIRECT_CONNECTIONS)} onChange={(v) => saveDirect({ ...direct, ENABLE_DIRECT_CONNECTIONS: v })} labelledBy={id} />}
						</SettingRow>
						<SettingRow
							label="Cache Base Model List"
							description="Base Model List Cache speeds up access by fetching base models only at startup or on settings save—faster, but may not show recent base model changes."
						>
							{(id) => (
								<div className="flex items-center gap-2">
									{direct.ENABLE_BASE_MODELS_CACHE && (
										<Tip content="Refresh">
											<button type="button" aria-label="Refresh" className={iconButton} disabled={refreshing} onClick={refreshModelList}>
												{refreshing ? <Spinner className="size-3.5" /> : <RefreshCw className="size-4" />}
											</button>
										</Tip>
									)}
									<SettingSwitch checked={Boolean(direct.ENABLE_BASE_MODELS_CACHE)} onChange={(v) => saveDirect({ ...direct, ENABLE_BASE_MODELS_CACHE: v })} labelledBy={id} />
								</div>
							)}
						</SettingRow>
					</SettingsSection>
				</>
			)}
		</SettingsForm>
	);
}
