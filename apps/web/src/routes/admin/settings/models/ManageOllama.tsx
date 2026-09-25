import { useQueryClient } from '@tanstack/react-query';
import { Download, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ExperimentalBadge } from '@/components/common/ExperimentalBadge';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { SettingSelect } from '@/components/settings/controls';
import { createModel, deleteModel, downloadModel, getOllamaModels, pullModel, uploadModel } from '@/lib/apis/ollama';
import { useAuthStore } from '@/lib/stores/authStore';
import { cancelPull, startPull, useDownloadPool } from './ollamaDownloads';
import { DEFAULT_MODELFILE, isNotableStatus, lineReader, modelLabel, parseStreamLines, progressPercent, streamError, uploadedModelfile } from './ollamaStreams';

const inputClass = 'bg-muted/40 placeholder:text-muted-foreground/50 focus:border-ring h-7 w-full rounded-lg border px-2.5 text-left text-xs outline-hidden transition-colors disabled:opacity-50';
const textareaClass = 'bg-muted/40 placeholder:text-muted-foreground/50 focus:border-ring w-full resize-none rounded-lg border px-2.5 py-2 text-xs outline-hidden transition-colors disabled:opacity-50';
const iconButtonClass = 'bg-muted/40 hover:bg-muted inline-flex h-7 items-center justify-center rounded-lg border px-2.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const headingClass = 'mb-2 text-sm font-normal';

type OllamaModel = { id: string; name?: string; size?: number };

function Progress({ percent, digest }: { percent: number; digest?: string }) {
	return (
		<div>
			<div className="bg-muted-foreground/60 text-background rounded-full p-0.5 text-center text-xs leading-none font-normal" style={{ width: `${Math.max(15, percent)}%` }}>
				{percent}%
			</div>
			{digest && <div className="text-muted-foreground mt-1 text-[0.5rem]">{digest}</div>}
		</div>
	);
}

const IconButton = ({ label, onClick, disabled, children, type = 'button' }: { label: string; onClick?: () => void; disabled?: boolean; children: ReactNode; type?: 'button' | 'submit' }) => (
	<Tip content={label} side="top">
		<button type={type} aria-label={label} className={iconButtonClass} onClick={onClick} disabled={disabled}>
			{children}
		</button>
	</Tip>
);

/** Reads a create/upload stream, reporting progress; toasts each notable status and any error. */
async function followCreate(res: Response, onProgress: (digest: string, percent: number) => void) {
	const reader = lineReader(res);
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		try {
			for (const data of parseStreamLines(value)) {
				const failure = streamError(data);
				if (failure) throw failure;
				if (!data.status) continue;
				if (isNotableStatus(data)) toast.success(data.status);
				else if (data.digest) onProgress(data.digest, progressPercent(data));
			}
		} catch (err) {
			toast.error(`${err}`);
		}
	}
}

/** Ports admin/Settings/Models/Manage/ManageOllama.svelte: pull, delete, create and upload models on one Ollama instance. */
export function ManageOllama({ urlIdx }: { urlIdx: number }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const pool = useDownloadPool((s) => s.pool);
	const refreshModels = () => queryClient.invalidateQueries({ queryKey: ['models-all'] });

	const [models, setModels] = useState<OllamaModel[] | null | undefined>(undefined);

	const [tag, setTag] = useState('');
	const [pulling, setPulling] = useState(false);
	const [updateModelId, setUpdateModelId] = useState<string | null>(null);
	const [updateProgress, setUpdateProgress] = useState<number | null>(null);
	const controllers = useRef<Record<string, AbortController | null>>({});
	const updateCancelled = useRef(false);

	const [deleteTag, setDeleteTag] = useState('');
	const [confirmDelete, setConfirmDelete] = useState(false);

	const [createName, setCreateName] = useState('');
	const [createBody, setCreateBody] = useState('');
	const [creating, setCreating] = useState(false);
	const [createDigest, setCreateDigest] = useState('');
	const [createProgress, setCreateProgress] = useState<number | null>(null);

	const [showExperimental, setShowExperimental] = useState(false);
	const [uploadMode, setUploadMode] = useState<'file' | 'url'>('file');
	const [uploadFile, setUploadFile] = useState<File | null>(null);
	const [uploadUrl, setUploadUrl] = useState('');
	const [modelfile, setModelfile] = useState(DEFAULT_MODELFILE);
	const [uploading, setUploading] = useState(false);
	const [uploadMessage, setUploadMessage] = useState('');
	const [uploadProgress, setUploadProgress] = useState<number | null>(null);
	const [uploadDigest, setUploadDigest] = useState('');
	const fileInput = useRef<HTMLInputElement>(null);

	const load = useCallback(async () => {
		setModels(undefined);
		try {
			setModels((await getOllamaModels(token, urlIdx)) as OllamaModel[]);
		} catch (error) {
			toast.error(`${error}`);
			setModels(null);
		}
	}, [token, urlIdx]);
	useEffect(() => {
		void load();
	}, [load]);

	// --- pull -------------------------------------------------------------------------

	const pull = async () => {
		setPulling(true);
		try {
			await startPull(token, tag, urlIdx, refreshModels);
		} finally {
			setTag('');
			setPulling(false);
		}
	};

	const updateAll = async () => {
		updateCancelled.current = false;
		toast.info('Checking for model updates...');
		for (const model of models ?? []) {
			if (updateCancelled.current) break;
			setUpdateModelId(model.id);
			let pulled: [Response | null, AbortController | null] = [null, null];
			try {
				pulled = (await pullModel(token, model.id, urlIdx)) as [Response | null, AbortController | null];
			} catch (error) {
				if ((error as Error)?.name !== 'AbortError') toast.error(`${error}`);
			}
			const [res, controller] = pulled;
			controllers.current[model.id] = controller;
			if (res) {
				const reader = lineReader(res);
				try {
					for (;;) {
						const { value, done } = await reader.read();
						if (done) break;
						for (const data of parseStreamLines(value)) {
							const failure = streamError(data);
							if (failure) throw failure;
							if (data.status && data.digest) setUpdateProgress(progressPercent(data));
						}
					}
				} catch (err) {
					if ((err as Error)?.name !== 'AbortError') console.error(err);
				}
			}
			delete controllers.current[model.id];
		}
		toast[updateCancelled.current ? 'info' : 'success'](updateCancelled.current ? 'Model update cancelled' : 'All models are up to date');
		setUpdateModelId(null);
		setUpdateProgress(null);
	};

	const cancelUpdate = (id: string) => {
		const controller = controllers.current[id];
		if (controller) {
			controller.abort();
			updateCancelled.current = true;
		}
	};

	// --- delete -----------------------------------------------------------------------

	const remove = async () => {
		try {
			if (await deleteModel(token, deleteTag, String(urlIdx))) toast.success(`Deleted ${deleteTag}`);
		} catch (error) {
			toast.error(`${error}`);
		}
		setDeleteTag('');
		await refreshModels();
		await load();
	};

	// --- create -----------------------------------------------------------------------

	const create = async () => {
		let body: object;
		try {
			body = JSON.parse(createBody);
		} catch (error) {
			toast.error(`${error}`);
			return;
		}
		setCreating(true);
		try {
			const res = (await createModel(token, { model: createName, ...body }, String(urlIdx))) as Response | null;
			if (res?.ok) await followCreate(res, (digest, percent) => (setCreateDigest(digest), setCreateProgress(percent)));
			else if (res) toast.error((await res.json().catch(() => null))?.detail ?? `${res.status}`);
		} catch (error) {
			toast.error(`${error}`);
		}
		await refreshModels();
		setCreating(false);
		setCreateName('');
		setCreateBody('');
		setCreateDigest('');
		setCreateProgress(null);
	};

	// --- upload -----------------------------------------------------------------------

	const upload = async () => {
		setUploading(true);
		let name = '';
		let blob = '';
		let uploaded = false;
		try {
			let res: Response | null = null;
			if (uploadMode === 'file') {
				if (uploadFile) {
					setUploadMessage('Uploading...');
					res = (await uploadModel(token, uploadFile, String(urlIdx))) as Response | null;
				}
			} else {
				setUploadProgress(0);
				res = (await downloadModel(token, uploadUrl, String(urlIdx))) as Response | null;
			}

			if (res?.ok) {
				const reader = lineReader(res);
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					try {
						for (const data of parseStreamLines(value)) {
							if (data.progress) {
								setUploadMessage('');
								setUploadProgress(data.progress);
							}
							const failure = streamError(data);
							if (failure) throw failure;
							if (data.done) {
								blob = data.blob;
								name = data.name;
								setUploadDigest(data.blob);
								uploaded = true;
							}
						}
					} catch (err) {
						console.error(err);
					}
				}
			} else if (res) {
				const error = await res.json().catch(() => null);
				toast.error(error?.detail ?? `${res.status}`);
			}

			if (uploaded) {
				// The stored blob becomes a model. (The Svelte tab calls its createModel with
				// a name and a Modelfile string, which that function takes as payload and
				// instance -- the request it makes cannot succeed.)
				const created = (await createModel(token, { model: `${name}:latest`, modelfile: uploadedModelfile(blob, modelfile) }, String(urlIdx))) as Response | null;
				if (created?.ok) await followCreate(created, () => undefined);
				else toast.error(((await created?.json().catch(() => null)) as { detail?: string } | null)?.detail ?? 'Failed to create the model');
			}
		} catch (error) {
			toast.error(`${error}`);
		}
		setUploadUrl('');
		setUploadFile(null);
		if (fileInput.current) fileInput.current.value = '';
		setUploading(false);
		setUploadProgress(null);
		setUploadMessage('');
		await refreshModels();
	};

	// --- render -----------------------------------------------------------------------

	if (models === null) return <div className="flex h-full w-full items-center justify-center py-3 text-xs">Failed to fetch models</div>;
	if (models === undefined) {
		return (
			<div className="flex h-full w-full items-center justify-center py-3">
				<Spinner className="size-5" />
			</div>
		);
	}

	const readyToUpload = (uploadMode === 'file' && uploadFile !== null) || (uploadMode === 'url' && uploadUrl !== '');
	const downloads = Object.entries(pool).filter(([, d]) => d.pullProgress !== undefined);

	return (
		<div className="flex w-full flex-col space-y-2">
			<div>
				<div className={`${headingClass} flex items-center gap-1.5`}>
					<div>Pull a model from Ollama.com</div>
					<Tip content="Update All Models" side="top">
						<button type="button" aria-label="Update All Models" className="rounded-lg transition" onClick={() => void updateAll()}>
							<RefreshCw className="size-4" />
						</button>
					</Tip>
				</div>
				<div className="flex w-full items-center">
					<div className="mr-2 flex-1">
						<input className={inputClass} aria-label="Model tag to pull" placeholder="Enter model tag (e.g. mistral:7b)" value={tag} onChange={(e) => setTag(e.target.value)} />
					</div>
					<IconButton label="Pull Model" onClick={() => void pull()} disabled={pulling || tag.trim() === ''}>
						{pulling ? <Spinner className="size-4" /> : <Download className="size-4" />}
					</IconButton>
				</div>
				<div className="text-muted-foreground mt-2 mb-1 text-xs">
					To access the available model names for downloading,{' '}
					<a className="text-foreground/80 font-normal underline" href="https://ollama.com/library" target="_blank" rel="noopener noreferrer">
						click here.
					</a>
				</div>

				{updateModelId && (
					<div className="flex items-center justify-between text-xs">
						<div>
							Updating &quot;{updateModelId}&quot; {updateProgress ? `(${updateProgress}%)` : ''}
						</div>
						<Tip content="Cancel">
							<button type="button" aria-label="Cancel update" onClick={() => cancelUpdate(updateModelId)}>
								<X className="size-4" />
							</button>
						</Tip>
					</div>
				)}

				{downloads.map(([name, d]) => (
					<div key={name} className="flex flex-col">
						<div className="mb-1 font-normal">{name}</div>
						<div className="flex justify-between space-x-4 pr-2">
							<div className="flex-1">
								<Progress percent={d.pullProgress ?? 0} digest={d.digest} />
							</div>
							<Tip content="Cancel">
								<button type="button" aria-label={`Cancel ${name} download`} onClick={() => void cancelPull(token, name)}>
									<X className="size-4" />
								</button>
							</Tip>
						</div>
					</div>
				))}
			</div>

			<div>
				<div className={headingClass}>Delete a model</div>
				<div className="flex w-full items-center">
					<div className="mr-2 flex-1">
						<SettingSelect className="w-full" value={deleteTag} onChange={setDeleteTag} aria-label="Model to delete">
							<option value="" disabled>
								Select a model
							</option>
							{models.map((m) => (
								<option key={m.id} value={m.id}>
									{modelLabel(m)}
								</option>
							))}
						</SettingSelect>
					</div>
					<IconButton label="Delete Model" onClick={() => setConfirmDelete(true)} disabled={deleteTag === ''}>
						<Trash2 className="size-4" />
					</IconButton>
				</div>
			</div>

			<div>
				<div className={headingClass}>Create a model</div>
				<div className="flex w-full">
					<div className="mr-2 flex flex-1 flex-col gap-2">
						<input className={inputClass} aria-label="New model tag" placeholder="Enter model tag (e.g. my-modelfile)" value={createName} onChange={(e) => setCreateName(e.target.value)} disabled={creating} />
						<textarea className={textareaClass} rows={6} aria-label="New model definition" placeholder={`e.g. {"model": "my-modelfile", "from": "ollama:7b"})`} value={createBody} onChange={(e) => setCreateBody(e.target.value)} disabled={creating} />
					</div>
					<div className="flex self-start">
						<IconButton label="Create Model" onClick={() => void create()} disabled={creating || createName.trim() === '' || createBody.trim() === ''}>
							{creating ? <Spinner className="size-4" /> : <Plus className="size-4" />}
						</IconButton>
					</div>
				</div>
				{createDigest !== '' && (
					<div className="mt-1 flex flex-col">
						<div className="mb-1 font-normal">{createName}</div>
						<Progress percent={createProgress ?? 0} digest={createDigest} />
					</div>
				)}
			</div>

			<div className="pt-1">
				<div className="flex items-center justify-between text-xs">
					<div className="text-sm font-normal">
						<ExperimentalBadge />
					</div>
					<button type="button" aria-expanded={showExperimental} className="text-muted-foreground text-xs font-normal" onClick={() => setShowExperimental((s) => !s)}>
						{showExperimental ? 'Hide' : 'Show'}
					</button>
				</div>
			</div>

			{showExperimental && (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						e.stopPropagation();
						void upload();
					}}
				>
					<div className="mb-2 flex w-full justify-between">
						<div className="text-sm font-normal">Upload a GGUF model</div>
						<button type="button" className="flex rounded-sm p-1 px-3 text-xs transition" onClick={() => setUploadMode((m) => (m === 'file' ? 'url' : 'file'))}>
							{uploadMode === 'file' ? 'File Mode' : 'URL Mode'}
						</button>
					</div>

					<div className="mb-1.5 flex w-full items-center">
						<div className="flex w-full flex-col">
							{uploadMode === 'file' ? (
								<div className={`flex-1 ${uploadFile ? 'mr-2' : ''}`}>
									<input ref={fileInput} type="file" accept=".gguf,.safetensors" aria-label="GGUF file" hidden onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)} />
									<button type="button" className={inputClass} onClick={() => fileInput.current?.click()}>
										{uploadFile ? uploadFile.name : 'Click here to select'}
									</button>
								</div>
							) : (
								<div className={`flex-1 ${uploadUrl !== '' ? 'mr-2' : ''}`}>
									<input className={inputClass} type="url" required aria-label="Hugging Face URL" placeholder="Type Hugging Face Resolve (Download) URL" value={uploadUrl} onChange={(e) => setUploadUrl(e.target.value)} />
								</div>
							)}
						</div>
						{readyToUpload && (
							<IconButton label="Upload Model" type="submit" disabled={uploading}>
								{uploading ? <Spinner className="size-4" /> : <Upload className="size-4" />}
							</IconButton>
						)}
					</div>

					{readyToUpload && (
						<div>
							<div className="my-2.5 text-sm font-normal">Modelfile Content</div>
							<textarea className={textareaClass} rows={6} aria-label="Modelfile content" value={modelfile} onChange={(e) => setModelfile(e.target.value)} />
						</div>
					)}
					<div className="text-muted-foreground mt-1 text-xs">
						To access the GGUF models available for downloading,{' '}
						<a className="text-foreground/80 font-normal underline" href="https://huggingface.co/models?search=gguf" target="_blank" rel="noopener noreferrer">
							click here.
						</a>
					</div>

					{(uploadMessage || uploadProgress !== null) && (
						<div className="mt-2">
							<div className="mb-2 text-xs">Upload Progress</div>
							{uploadMessage ? (
								<div className="bg-muted-foreground/60 text-background rounded-full p-0.5 text-center text-xs leading-none" style={{ width: '100%' }}>
									{uploadMessage}
								</div>
							) : (
								<Progress percent={uploadProgress ?? 0} digest={uploadDigest} />
							)}
						</div>
					)}
				</form>
			)}

			<ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} title="Delete Model" onConfirm={remove}>
				This will delete {deleteTag} and cannot be undone.
			</ConfirmDialog>
		</div>
	);
}
