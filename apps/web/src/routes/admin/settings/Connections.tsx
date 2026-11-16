import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, RefreshCw } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { toastFailure } from '@/components/common/failureToast';
import { LoadFailed } from '@/components/common/LoadFailed';
import { Spinner } from '@/components/common/Spinner';
import { AddConnectionModal } from '@/components/settings/AddConnectionModal';
import type { Connection } from '@/components/settings/connectionModel';
import { SettingRow, SettingSwitch, SettingsForm, SettingsSection } from '@/components/settings/controls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { getModels } from '@/lib/apis';
import { getConnectionsConfig, setConnectionsConfig } from '@/lib/apis/configs';
import { getOllamaConfig, updateOllamaConfig } from '@/lib/apis/ollama';
import { getOpenAIConfig, getOpenAIModels, updateOpenAIConfig } from '@/lib/apis/openai';
import { useAdminConfigSaved } from '@/lib/settings/useAdminSaved';
import { useAuthStore } from '@/lib/stores/authStore';
import { alignKeys, type ConfigMap, normalizeConfigs, removeConnection, stripTrailingSlashes } from './connectionsList';

type OpenAIState = { enabled: boolean; urls: string[]; keys: string[]; configs: ConfigMap };
type OllamaState = { enabled: boolean; urls: string[]; configs: ConfigMap };
type DirectState = { ENABLE_DIRECT_CONNECTIONS?: boolean; ENABLE_BASE_MODELS_CACHE?: boolean };

/**
 * One connection: its URL and what local-llm sends to, its state as badges
 * (Off, Pipelines; never a faded row, DAT-3, COL-2), Edit, which opens the
 * dialog, and the enable switch, outside any tooltip (#912).
 */
function ConnectionRow({
	url,
	requestUrl,
	config,
	pipeline = false,
	ollama = false,
	keyValue,
	onSubmit,
	onToggle,
	onDelete
}: {
	url: string;
	requestUrl: string;
	config: Record<string, any>;
	pipeline?: boolean;
	ollama?: boolean;
	keyValue: string;
	onSubmit: (connection: Connection) => Promise<boolean>;
	onToggle: (enable: boolean) => void;
	onDelete: () => Promise<boolean>;
}) {
	const [editing, setEditing] = useState(false);
	const enabled = config?.enable ?? true;
	return (
		<li className="flex min-w-0 items-center gap-2">
			<AddConnectionModal
				open={editing}
				onOpenChange={setEditing}
				edit
				ollama={ollama}
				connection={{ url, key: keyValue, config }}
				onSubmit={async (c) => {
					if (!(await onSubmit(c))) throw new Error('not saved');
				}}
				onDelete={async () => {
					await onDelete();
				}}
			/>
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
					<span className="min-w-0 truncate font-mono text-body">{url}</span>
					{!enabled && (
						<Badge variant="secondary">
							<span className="sr-only">, </span>Off
						</Badge>
					)}
					{pipeline && <Badge variant="secondary">Pipelines</Badge>}
				</span>
				<span className="text-foreground-muted min-w-0 truncate text-dense">
					local-llm sends requests to {requestUrl}
				</span>
			</div>
			<Button variant="ghost" size="icon-sm" type="button" aria-label={`Edit ${url}`} onClick={() => setEditing(true)}>
				<Pencil aria-hidden />
			</Button>
			<Switch aria-label={`Enable ${url}`} checked={enabled} onCheckedChange={onToggle} />
		</li>
	);
}

/**
 * Ports admin/Settings/Connections.svelte: the OpenAI-compatible and Ollama
 * upstreams (this is where an OpenRouter or llama.cpp base URL and key live), plus
 * the two "user connections" switches.
 *
 * Every change saves at once (FRM-3, `savesAtOnce`) -- toggling an API on or
 * off, adding, editing or deleting a connection -- and says what it saved in
 * one toast, or why it couldn't, putting the old values back. While a save is
 * in flight the tab's controls wait ("Saving…"): each save sends a whole list
 * keyed by position, so an overlapping one could leave on screen a list the
 * server does not hold. The connection
 * list is edited through pure helpers (connectionsList.ts): URLs lose a
 * trailing slash, keys are kept the same length as the URLs, and deleting one
 * re-indexes the config map, which is keyed by list position.
 */
export default function Connections() {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const saved = useAdminConfigSaved();
	const [openai, setOpenAI] = useState<OpenAIState | null>(null);
	const [ollama, setOllama] = useState<OllamaState | null>(null);
	const [direct, setDirect] = useState<DirectState | null>(null);
	const [pipelineUrls, setPipelineUrls] = useState<Record<string, boolean>>({});
	// A save in flight: the tab's controls wait for it, so two saves never overlap (each sends a whole list).
	const [saving, setSaving] = useState(false);
	const [showAddOpenAI, setShowAddOpenAI] = useState(false);
	const [showAddOllama, setShowAddOllama] = useState(false);
	const [refreshing, setRefreshing] = useState(false);

	const loaded = useQuery({
		queryKey: ['admin-settings', 'connections'],
		queryFn: async () => {
			const [o, l, c] = await Promise.all([
				getOllamaConfig(token),
				getOpenAIConfig(token),
				getConnectionsConfig(token)
			]);
			return { ollama: o, openai: l, direct: c };
		},
		retry: false,
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
			configs: d.openai?.ENABLE_OPENAI_API
				? normalizeConfigs(openaiUrls, d.openai?.OPENAI_API_CONFIGS)
				: (d.openai?.OPENAI_API_CONFIGS ?? {})
		});
		setOllama({
			enabled: Boolean(d.ollama?.ENABLE_OLLAMA_API),
			urls: ollamaUrls,
			configs: d.ollama?.ENABLE_OLLAMA_API
				? normalizeConfigs(ollamaUrls, d.ollama?.OLLAMA_API_CONFIGS)
				: (d.ollama?.OLLAMA_API_CONFIGS ?? {})
		});
		setDirect(d.direct ?? {});
	}, [loaded.data, openai]);

	// Which enabled OpenAI connections front a Pipelines server (shows a badge).
	useEffect(() => {
		if (!openai?.enabled) return;
		let cancelled = false;
		openai.urls.forEach(async (url, idx) => {
			if (!(openai.configs[idx]?.enable ?? true)) return;
			try {
				const res = await getOpenAIModels(token, idx);
				if (!cancelled && res?.pipelines) setPipelineUrls((p) => ({ ...p, [url]: true }));
			} catch {
				/* an unreachable upstream just gets no badge */
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

	/**
	 * Saves the OpenAI-compatible upstreams, showing them at once and putting the
	 * old ones back if the server refuses; whether it took them.
	 */
	const saveOpenAI = async (next: OpenAIState, done: string): Promise<boolean> => {
		const urls = stripTrailingSlashes(next.urls);
		const state = { ...next, urls, keys: alignKeys(urls, next.keys) };
		const prev = openai;
		setOpenAI(state);
		setSaving(true);
		try {
			const res = await updateOpenAIConfig(token, {
				ENABLE_OPENAI_API: state.enabled,
				OPENAI_API_BASE_URLS: state.urls,
				OPENAI_API_KEYS: state.keys,
				OPENAI_API_CONFIGS: state.configs
			});
			if (!res) throw new Error('The server returned nothing.');
		} catch (error) {
			if (prev) setOpenAI(prev);
			toastFailure("Couldn't save the OpenAI-compatible connections.", error);
			return false;
		} finally {
			setSaving(false);
		}
		toast.success(done);
		refreshModels();
		return true;
	};

	/** Saves the Ollama upstreams the same way; whether the server took them. */
	const saveOllama = async (next: OllamaState, done: string): Promise<boolean> => {
		const state = { ...next, urls: stripTrailingSlashes(next.urls) };
		const prev = ollama;
		setOllama(state);
		setSaving(true);
		try {
			const res = await updateOllamaConfig(token, {
				ENABLE_OLLAMA_API: state.enabled,
				OLLAMA_BASE_URLS: state.urls,
				OLLAMA_API_CONFIGS: state.configs
			});
			if (!res) throw new Error('The server returned nothing.');
		} catch (error) {
			if (prev) setOllama(prev);
			toastFailure("Couldn't save the Ollama connections.", error);
			return false;
		} finally {
			setSaving(false);
		}
		toast.success(done);
		refreshModels();
		return true;
	};

	const saveDirect = async (next: DirectState) => {
		const prev = direct;
		setDirect(next);
		setSaving(true);
		try {
			const res = await setConnectionsConfig(token, next);
			if (!res) throw new Error('The server returned nothing.');
		} catch (error) {
			setDirect(prev);
			toastFailure("Couldn't save the change.", error);
			return;
		} finally {
			setSaving(false);
		}
		refreshModels();
		await saved();
	};

	const refreshModelList = async () => {
		setRefreshing(true);
		try {
			await getModels(token, null, false, true);
			refreshModels();
			toast.success('Model list refreshed');
		} catch (error) {
			toastFailure("Couldn't refresh the model list.", error);
		} finally {
			setRefreshing(false);
		}
	};

	const onOff = (on: boolean) => (on ? 'on' : 'off');
	const quoted = (url: string) => `“${url}”`;

	if (loaded.isError) {
		return (
			<SettingsForm title="Connections" savesAtOnce>
				<LoadFailed
					what="the connections"
					error={loaded.error}
					retrying={loaded.isFetching}
					onRetry={() => void loaded.refetch()}
				/>
			</SettingsForm>
		);
	}

	const ready = openai && ollama && direct;

	return (
		<SettingsForm title="Connections" loading={!ready} savesAtOnce saving={saving}>
			{ready && (
				<>
					<AddConnectionModal
						open={showAddOpenAI}
						onOpenChange={setShowAddOpenAI}
						onSubmit={async (c) => {
							const ok = await saveOpenAI(
								{
									...openai,
									urls: [...openai.urls, c.url],
									keys: [...openai.keys, c.key],
									configs: { ...openai.configs, [openai.urls.length]: c.config }
								},
								`${quoted(c.url)} added`
							);
							if (!ok) throw new Error('not saved');
						}}
					/>
					<AddConnectionModal
						open={showAddOllama}
						onOpenChange={setShowAddOllama}
						ollama
						onSubmit={async (c) => {
							const ok = await saveOllama(
								{
									...ollama,
									urls: [...ollama.urls, c.url],
									configs: { ...ollama.configs, [ollama.urls.length]: { ...c.config, key: c.key } }
								},
								`${quoted(c.url)} added`
							);
							if (!ok) throw new Error('not saved');
						}}
					/>

					<SettingsSection first>
						<SettingRow label="OpenAI-compatible connections" description="OpenRouter, or llama-server on :8090.">
							{(id) => (
								<SettingSwitch
									checked={openai.enabled}
									onChange={(enabled) =>
										saveOpenAI({ ...openai, enabled }, `OpenAI-compatible connections are ${onOff(enabled)}`)
									}
									labelledBy={id}
								/>
							)}
						</SettingRow>
						{openai.enabled && (
							<ConnectionList
								label="OpenAI-compatible connections"
								empty="None yet. Add OpenRouter, or llama-server on :8090."
								onAdd={() => setShowAddOpenAI(true)}
							>
								{openai.urls.map((url, idx) => (
									<ConnectionRow
										key={`${idx}:${url}`}
										url={url}
										keyValue={openai.keys[idx] ?? ''}
										config={openai.configs[idx] ?? {}}
										pipeline={Boolean(pipelineUrls[url])}
										requestUrl={`${url}/chat/completions`}
										onSubmit={(c) =>
											saveOpenAI(
												{
													...openai,
													urls: openai.urls.map((u, i) => (i === idx ? c.url : u)),
													keys: openai.keys.map((k, i) => (i === idx ? c.key : k)),
													configs: { ...openai.configs, [idx]: c.config }
												},
												`${quoted(c.url)} saved`
											)
										}
										onToggle={(enable) =>
											void saveOpenAI(
												{ ...openai, configs: { ...openai.configs, [idx]: { ...openai.configs[idx], enable } } },
												`${quoted(url)} is ${onOff(enable)}`
											)
										}
										onDelete={() => {
											const r = removeConnection(openai.urls, openai.keys, openai.configs, idx);
											return saveOpenAI(
												{ ...openai, urls: r.urls, keys: r.keys ?? [], configs: r.configs },
												`${quoted(url)} deleted`
											);
										}}
									/>
								))}
							</ConnectionList>
						)}

						<SettingRow label="Ollama" description="Models from an Ollama server.">
							{(id) => (
								<SettingSwitch
									checked={ollama.enabled}
									onChange={(enabled) => saveOllama({ ...ollama, enabled }, `Ollama connections are ${onOff(enabled)}`)}
									labelledBy={id}
								/>
							)}
						</SettingRow>
						{ollama.enabled && (
							<ConnectionList
								label="Ollama connections"
								empty="None yet. Add the URL of an Ollama server."
								onAdd={() => setShowAddOllama(true)}
							>
								{ollama.urls.map((url, idx) => (
									<ConnectionRow
										key={`${idx}:${url}`}
										ollama
										url={url}
										keyValue={ollama.configs[idx]?.key ?? ''}
										config={ollama.configs[idx] ?? {}}
										requestUrl={`${url}/api/chat`}
										onSubmit={(c) =>
											saveOllama(
												{
													...ollama,
													urls: ollama.urls.map((u, i) => (i === idx ? c.url : u)),
													configs: { ...ollama.configs, [idx]: { ...c.config, key: c.key } }
												},
												`${quoted(c.url)} saved`
											)
										}
										onToggle={(enable) =>
											void saveOllama(
												{ ...ollama, configs: { ...ollama.configs, [idx]: { ...ollama.configs[idx], enable } } },
												`${quoted(url)} is ${onOff(enable)}`
											)
										}
										onDelete={() => {
											const r = removeConnection(ollama.urls, null, ollama.configs, idx);
											return saveOllama({ ...ollama, urls: r.urls, configs: r.configs }, `${quoted(url)} deleted`);
										}}
									/>
								))}
							</ConnectionList>
						)}
					</SettingsSection>

					<SettingsSection title="User connections">
						<SettingRow
							label="Direct connections"
							description="Each user may add their own OpenAI-compatible servers, which their browser talks to directly."
						>
							{(id) => (
								<SettingSwitch
									checked={Boolean(direct.ENABLE_DIRECT_CONNECTIONS)}
									onChange={(v) => saveDirect({ ...direct, ENABLE_DIRECT_CONNECTIONS: v })}
									labelledBy={id}
								/>
							)}
						</SettingRow>
						<SettingRow
							label="Cache the base model list"
							description="The list of models is read at startup and on each save, so it opens faster but can miss a model added since."
						>
							{(id) => (
								<SettingSwitch
									checked={Boolean(direct.ENABLE_BASE_MODELS_CACHE)}
									onChange={(v) => saveDirect({ ...direct, ENABLE_BASE_MODELS_CACHE: v })}
									labelledBy={id}
								/>
							)}
						</SettingRow>
						{direct.ENABLE_BASE_MODELS_CACHE && (
							<Button
								variant="outline"
								size="sm"
								type="button"
								className="self-start"
								disabled={refreshing}
								aria-busy={refreshing || undefined}
								onClick={refreshModelList}
							>
								{refreshing ? <Spinner className="size-3.5" /> : <RefreshCw aria-hidden />}
								{refreshing ? 'Refreshing…' : 'Refresh the model list'}
							</Button>
						)}
					</SettingsSection>
				</>
			)}
		</SettingsForm>
	);
}

/** A list of connections under its API's switch, with Add connection, or what to add when it is empty. */
function ConnectionList({
	label,
	empty,
	onAdd,
	children
}: {
	label: string;
	empty: string;
	onAdd: () => void;
	children: ReactNode[];
}) {
	return (
		<div className="flex flex-col gap-2">
			{children.length > 0 ? (
				<ul aria-label={label} className="flex flex-col gap-2">
					{children}
				</ul>
			) : (
				<p className="text-foreground-muted text-dense">{empty}</p>
			)}
			<Button variant="outline" size="sm" type="button" className="self-start" onClick={onAdd}>
				<Plus aria-hidden />
				Add connection
			</Button>
		</div>
	);
}
