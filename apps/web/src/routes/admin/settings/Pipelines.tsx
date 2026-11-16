import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Spinner } from '@/components/common/Spinner';
import { enumChoices, enumOption } from '@/components/common/Valves';
import {
	SettingField,
	SettingInput,
	SettingRow,
	SettingSelect,
	SettingSwitch,
	SettingsForm,
	SettingsSection
} from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import {
	deletePipeline,
	downloadPipeline,
	getPipelines,
	getPipelinesList,
	getPipelineValves,
	getPipelineValvesSpec,
	updatePipelineValves,
	uploadPipeline
} from '@/lib/apis';
import { toastSaved } from '@/lib/settings/useAdminSaved';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfirmLeave } from '@/lib/ui/useUnsavedChanges';
import { formToValves, type ValveSpec, type ValveValues, valvesToForm } from './pipelineValves';

type PipelineServer = { idx: number; url: string };
type Pipeline = { id: string; name: string; type?: string; valves?: boolean };

const muted = 'text-muted-foreground text-xs';

/**
 * Ports admin/Settings/Pipelines.svelte: choose a Pipelines server, upload or
 * install a pipeline onto it, pick an installed one to delete or to edit the
 * valves of (each valve is None or a custom value). Save writes the valves of the
 * selected pipeline.
 *
 * FRM-3: the valves are a draft against what the server holds, with the
 * SaveBar; the page asks before a tab switch or navigation loses them, and
 * choosing another server or pipeline asks first too.
 */
export default function Pipelines() {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const uploadInput = useRef<HTMLInputElement>(null);
	const [urlIdx, setUrlIdx] = useState('');
	const [selectedIdx, setSelectedIdx] = useState(0);
	const [file, setFile] = useState<File | null>(null);
	const [downloadUrl, setDownloadUrl] = useState('');
	const [uploading, setUploading] = useState(false);
	const [downloading, setDownloading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [spec, setSpec] = useState<ValveSpec | null>(null);
	const [valves, setValves] = useState<ValveValues | null>(null);
	// The selected pipeline's valves as the server holds them, in the form's shape.
	const [savedValves, setSavedValves] = useState<ValveValues | null>(null);
	const dirty = valves !== null && savedValves !== null && JSON.stringify(valves) !== JSON.stringify(savedValves);
	const guard = useConfirmLeave(dirty, {
		message: "This pipeline's valves have changes that are not saved. They are lost if you choose another."
	});

	const servers = useQuery({
		queryKey: ['admin-settings', 'pipelines-list'],
		queryFn: async () => ((await getPipelinesList(token)) ?? []) as PipelineServer[],
		gcTime: 0
	});
	useEffect(() => {
		if (servers.data?.length && urlIdx === '') setUrlIdx(servers.data[0].idx.toString());
	}, [servers.data, urlIdx]);

	const pipelinesQuery = useQuery({
		queryKey: ['admin-settings', 'pipelines', urlIdx],
		queryFn: async () => ((await getPipelines(token, urlIdx)) ?? []) as Pipeline[],
		enabled: (servers.data?.length ?? 0) > 0 && urlIdx !== '',
		gcTime: 0
	});
	const pipelines = pipelinesQuery.data ?? null;
	const current = pipelines?.[selectedIdx];

	useEffect(() => setSelectedIdx(0), [urlIdx]);

	// Load the selected pipeline's valves and their spec.
	useEffect(() => {
		setSpec(null);
		setValves(null);
		setSavedValves(null);
		if (!current?.valves) return;
		let cancelled = false;
		(async () => {
			try {
				const [loadedSpec, loaded] = [
					await getPipelineValvesSpec(token, current.id, urlIdx),
					await getPipelineValves(token, current.id, urlIdx)
				];
				if (cancelled) return;
				const form = valvesToForm(loaded ?? {}, loadedSpec);
				setSpec(loadedSpec);
				setValves(form);
				setSavedValves(form);
			} catch (error) {
				if (!cancelled) toast.error(`${error}`);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [current?.id, current?.valves, urlIdx, token]);

	const refresh = async () => {
		await pipelinesQuery.refetch();
		queryClient.invalidateQueries({ queryKey: ['models'] });
		queryClient.invalidateQueries({ queryKey: ['models-all'] });
	};

	const save = async () => {
		if (!current?.valves || !spec || !valves) {
			toast.error('No valves to update');
			return;
		}
		setSaving(true);
		const sent = valves;
		const res = await updatePipelineValves(token, current.id, formToValves(sent, spec), urlIdx).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		setSaving(false);
		if (res) {
			setSavedValves(sent);
			toast.success('Valves updated successfully');
			await refresh();
			toastSaved();
		}
	};

	const upload = async () => {
		if (!file) {
			toast.error('No file selected');
			return;
		}
		setUploading(true);
		const res = await uploadPipeline(token, file, urlIdx).catch((error) => {
			console.error(error);
			toast.error('Something went wrong :/');
			return null;
		});
		if (res) {
			toast.success('Pipeline downloaded successfully');
			await refresh();
		}
		setFile(null);
		if (uploadInput.current) uploadInput.current.value = '';
		setUploading(false);
	};

	const install = async () => {
		setDownloading(true);
		const res = await downloadPipeline(token, downloadUrl, urlIdx).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (res) {
			toast.success('Pipeline downloaded successfully');
			await refresh();
		}
		setDownloading(false);
	};

	const remove = async () => {
		if (!current) return;
		const res = await deletePipeline(token, current.id, urlIdx).catch((error) => {
			toast.error(`${error}`);
			return null;
		});
		if (res) {
			toast.success('Pipeline deleted successfully');
			await refresh();
		}
	};

	const setValve = (key: string, value: unknown) => setValves((v) => ({ ...(v ?? {}), [key]: value }));
	const hasServers = (servers.data?.length ?? 0) > 0;

	return (
		<SettingsForm
			title="Pipelines"
			loading={servers.isPending}
			footer={hasServers}
			onSubmit={save}
			saving={saving}
			dirty={hasServers ? dirty : undefined}
			onDiscard={() => setValves(savedValves)}
		>
			{guard.dialog}
			<ConfirmDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title={`Delete “${current?.name ?? 'this pipeline'}”?`}
				confirmLabel="Delete pipeline"
				destructive
				onConfirm={() => {
					setConfirmDelete(false);
					void remove();
				}}
			>
				It is removed from its Pipelines server, with its valves. This can't be undone.
			</ConfirmDialog>
			{!hasServers ? (
				<SettingsSection title="Source" first>
					<div className={muted}>Pipelines Not Detected</div>
				</SettingsSection>
			) : (
				<>
					<input
						ref={uploadInput}
						id="pipelines-upload-input"
						type="file"
						accept=".py"
						hidden
						aria-label="Pipeline file"
						onChange={(e) => setFile(e.target.files?.[0] ?? null)}
					/>
					<SettingsSection title="Source" first>
						<SettingField label="Pipeline URL" description="Select the Pipelines server to manage.">
							<SettingSelect
								value={urlIdx}
								onChange={(v) => guard.confirmLeave(() => setUrlIdx(v))}
								className="w-full"
								aria-label="Pipeline URL"
							>
								{servers.data!.map((s) => (
									<option key={s.idx} value={s.idx.toString()}>
										{s.url}
									</option>
								))}
							</SettingSelect>
						</SettingField>
						<SettingField
							label="Upload Pipeline"
							description="Upload a local Python pipeline file to the selected server."
						>
							<div className="flex items-center gap-2">
								<Button
									variant="outline"
									size="sm"
									className="min-w-0 flex-1 justify-start shrink"
									type="button"
									onClick={() => uploadInput.current?.click()}
								>
									{file ? '1 pipeline(s) selected' : 'Select a .py file'}
								</Button>
								<Button variant="outline" size="sm" type="button" onClick={upload} disabled={uploading}>
									{uploading ? 'Uploading' : 'Upload'}
								</Button>
							</div>
						</SettingField>
						<SettingField
							label="GitHub URL"
							description="Pipelines are a plugin system with arbitrary code execution. Don't fetch random pipelines from sources you don't trust."
						>
							<div className="flex items-center gap-2">
								<SettingInput
									placeholder="Enter GitHub Raw URL"
									value={downloadUrl}
									onChange={(e) => setDownloadUrl(e.target.value)}
								/>
								<Button variant="outline" size="sm" type="button" onClick={install} disabled={downloading}>
									{downloading ? 'Installing' : 'Install'}
								</Button>
							</div>
						</SettingField>
					</SettingsSection>

					{pipelines === null ? (
						<div className="flex justify-center py-4">
							<Spinner className="size-4" />
						</div>
					) : pipelines.length === 0 ? (
						<SettingsSection title="Pipelines">
							<div className={muted}>Pipelines Not Detected</div>
						</SettingsSection>
					) : (
						<>
							<SettingsSection title="Pipelines">
								<SettingField label="Pipeline" description="Select an installed pipeline to configure or remove.">
									<div className="flex items-center gap-2">
										<SettingSelect
											value={selectedIdx}
											onChange={(v) => guard.confirmLeave(() => setSelectedIdx(Number(v)))}
											className="w-full"
											aria-label="Pipeline"
										>
											{pipelines.map((p, idx) => (
												<option key={p.id} value={idx}>
													{p.name} ({p.type ?? 'pipe'})
												</option>
											))}
										</SettingSelect>
										<Button variant="destructive" size="sm" type="button" onClick={() => setConfirmDelete(true)}>
											Delete
										</Button>
									</div>
								</SettingField>
							</SettingsSection>

							<SettingsSection title="Valves">
								{current?.valves ? (
									valves && spec ? (
										Object.keys(spec.properties).map((key) => {
											const prop = spec.properties[key];
											const value = valves[key] ?? null;
											return (
												<div key={key} className="flex flex-col gap-1.5">
													<SettingRow label={prop.title ?? key} description={prop.description ?? ''}>
														<Button
															variant="outline"
															size="sm"
															type="button"
															onClick={() => setValve(key, value === null ? '' : null)}
														>
															{value === null ? 'None' : 'Custom'}
														</Button>
													</SettingRow>
													{value !== null && (
														<div>
															{prop.enum ? (
																<SettingSelect
																	value={String(value)}
																	// The option itself, not its text: a Literal[1, 2, 3] valve refuses "2" (#201).
																	onChange={(v) => setValve(key, enumOption(prop.enum ?? [], v))}
																	className="w-full"
																	aria-label={prop.title ?? key}
																>
																	{enumChoices(prop.enum).map((option) => (
																		<option key={String(option)} value={String(option)}>
																			{String(option)}
																		</option>
																	))}
																</SettingSelect>
															) : prop.type === 'boolean' ? (
																<SettingRow
																	label={value ? 'Enabled' : 'Disabled'}
																	labelClassName="text-foreground-muted"
																>
																	{(id) => (
																		<SettingSwitch
																			checked={Boolean(value)}
																			onChange={(v) => setValve(key, v)}
																			labelledBy={id}
																		/>
																	)}
																</SettingRow>
															) : (
																<SettingInput
																	type="text"
																	placeholder={prop.title ?? key}
																	aria-label={prop.title ?? key}
																	value={String(value)}
																	onChange={(e) => setValve(key, e.target.value)}
																	autoComplete="off"
																	// An empty list is a value; an empty text is not.
																	required={prop.type !== 'array'}
																/>
															)}
														</div>
													)}
												</div>
											);
										})
									) : (
										<div className="flex justify-center py-2">
											<Spinner className="size-4" />
										</div>
									)
								) : (
									<div className={muted}>No valves</div>
								)}
							</SettingsSection>
						</>
					)}
				</>
			)}
		</SettingsForm>
	);
}
