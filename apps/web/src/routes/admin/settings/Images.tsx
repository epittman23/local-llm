import { RefreshCw } from 'lucide-react';
import { type ReactNode, Suspense, lazy, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SensitiveInput } from '@/components/common/SensitiveInput';
import { Spinner } from '@/components/common/Spinner';
import { Tip } from '@/components/common/Tip';
import { SettingField, SettingInput, SettingNumber, SettingRow, SettingSelect, SettingSwitch, SettingTextarea, SettingsForm, SettingsSection } from '@/components/settings/controls';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { getBackendConfig } from '@/lib/apis';
import { getConfig, getImageGenerationModels, updateConfig, verifyConfigUrl } from '@/lib/apis/images';
import { toastSaved } from '@/lib/settings/useAdminSaved';
import { useConfigDraft } from '@/lib/settings/useConfigDraft';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { type NodeRow, prepareImagesConfig, prettyJson, toFormState } from './images';

const CodeEditor = lazy(() => import('@/components/common/CodeEditor'));

type Rec = Record<string, any>;
type Draft = ReturnType<typeof toFormState>;

const twoUp = 'grid grid-cols-1 gap-2 sm:grid-cols-2';
const textButton = 'text-muted-foreground hover:text-foreground text-xs transition-colors hover:underline';

/** A URL box with a button that saves, then asks the backend to reach the server. */
function VerifiedUrl({ id, label, description, placeholder, value, onChange, onVerify }: { id: string; label: string; description: string; placeholder: string; value: string; onChange: (v: string) => void; onVerify: () => void }) {
	return (
		<SettingField label={label} description={description} htmlFor={id}>
			<div className="flex w-full items-center gap-2">
				<SettingInput id={id} placeholder={placeholder} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
				<button type="button" aria-label="Verify connection" className="text-muted-foreground hover:text-foreground shrink-0 transition-colors" onClick={onVerify}>
					<RefreshCw className="size-4" />
				</button>
			</div>
		</SettingField>
	);
}

/** The ComfyUI workflow file (upload or edit in a code dialog) and the node mapping that goes with it. */
function ComfyWorkflow({
	id,
	workflow,
	onWorkflow,
	rows,
	onRows,
	nodesDescription,
	requiredTypes
}: {
	id: string;
	workflow: string;
	onWorkflow: (text: string) => void;
	rows: NodeRow[];
	onRows: (rows: NodeRow[]) => void;
	nodesDescription: string;
	requiredTypes: string[];
}) {
	const file = useRef<HTMLInputElement>(null);
	const [editing, setEditing] = useState(false);

	const upload = async (input: HTMLInputElement) => {
		const chosen = input.files?.[0];
		if (!chosen) return;
		try {
			onWorkflow(prettyJson(await chosen.text()));
		} catch (error) {
			toast.error(`${error}`);
		}
		// So choosing the same file again still fires a change.
		input.value = '';
	};

	return (
		<>
			<input ref={file} id={`${id}-file`} hidden type="file" accept=".json" onChange={(e) => upload(e.target)} />
			<SettingRow label="ComfyUI Workflow" description="Upload a workflow.json file exported as API format from ComfyUI.">
				<div className="flex items-center justify-end gap-2">
					{workflow && (
						<button type="button" aria-label="Edit workflow.json content" className={textButton} onClick={() => setEditing(true)}>
							Edit
						</button>
					)}
					<Tip content="Click here to upload a workflow.json file.">
						<button type="button" aria-label="Click here to upload a workflow.json file." className={textButton} onClick={() => file.current?.click()}>
							Upload
						</button>
					</Tip>
				</div>
			</SettingRow>

			<Dialog open={editing} onOpenChange={setEditing}>
				<DialogContent className="flex h-[70vh] flex-col sm:max-w-3xl">
					<DialogHeader>
						<DialogTitle>ComfyUI Workflow</DialogTitle>
						<DialogDescription className="sr-only">Edit the workflow JSON.</DialogDescription>
					</DialogHeader>
					<div className="min-h-0 flex-1 overflow-hidden rounded-lg border">
						<Suspense
							fallback={
								<div className="flex h-full items-center justify-center">
									<Spinner />
								</div>
							}
						>
							<CodeEditor value={workflow} lang="json" className="text-xs" onChange={onWorkflow} onSave={() => setEditing(false)} />
						</Suspense>
					</div>
				</DialogContent>
			</Dialog>

			{workflow && (
				<SettingField label="ComfyUI Workflow Nodes" description={nodesDescription}>
					<div className="flex flex-col gap-1.5 text-xs">
						{rows.map((row, i) => (
							<div key={row.type} className="flex w-full flex-col">
								<div className="text-muted-foreground/70 line-clamp-1 w-20 capitalize">
									{row.type}
									{requiredTypes.includes(row.type) ? '*' : ''}
								</div>
								<div className="mt-0.5 flex items-center">
									<Tip content="Input Key (e.g. text, unet_name, steps)">
										<SettingInput
											className="w-24"
											aria-label={`${row.type} key`}
											placeholder="Key"
											required
											value={row.key}
											onChange={(e) => onRows(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
										/>
									</Tip>
									<div className="text-muted-foreground/70 px-2">:</div>
									<div className="w-full">
										<Tip content="Comma separated Node Ids (e.g. 1 or 1,2)">
											<SettingInput
												aria-label={`${row.type} node ids`}
												placeholder="Node Ids"
												value={row.node_ids}
												onChange={(e) => onRows(rows.map((r, j) => (j === i ? { ...r, node_ids: e.target.value } : r)))}
											/>
										</Tip>
									</div>
								</div>
							</div>
						))}
					</div>
					<div className="text-muted-foreground/70 mt-1 text-xs">*Prompt node ID(s) are required for image generation</div>
				</SettingField>
			)}
		</>
	);
}

/** Ports admin/Settings/Images.svelte. */
export default function Images() {
	const token = useAuthStore((s) => s.token) ?? '';
	const setBackendConfig = useConfigStore((s) => s.setConfig);
	const [models, setModels] = useState<{ id: string; name?: string }[]>([]);
	const { draft, setDraft, isLoading } = useConfigDraft<Draft>(['images'], async () => {
		const config = await getConfig(token);
		return config ? toFormState(config) : null;
	});
	const [saving, setSaving] = useState(false);

	const loadModels = async () => {
		const res = await getImageGenerationModels(token).catch((e) => void toast.error(`${e}`));
		if (res) setModels(res);
	};
	const loaded = useRef(false);
	useEffect(() => {
		if (draft && !loaded.current) {
			loaded.current = true;
			if (draft.config.ENABLE_IMAGE_GENERATION) void loadModels();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [draft]);

	const set = (p: Rec) => setDraft((d) => d && { ...d, config: { ...d.config, ...p } });
	const setNodes = (nodes: NodeRow[]) => setDraft((d) => d && { ...d, nodes });
	const setEditNodes = (editNodes: NodeRow[]) => setDraft((d) => d && { ...d, editNodes });

	/** Saves the form; false (after saying why) if it is not valid or the server refuses. */
	const persist = async (): Promise<boolean> => {
		if (!draft) return false;
		const prepared = prepareImagesConfig(draft.config, draft.nodes, draft.editNodes);
		if (!prepared.ok) {
			toast.error(prepared.error);
			if (prepared.disableGeneration) set({ ENABLE_IMAGE_GENERATION: false });
			return false;
		}
		try {
			const res = await updateConfig(token, prepared.payload);
			if (!res) return false;
			const fresh = await getBackendConfig().catch(() => null);
			if (fresh) setBackendConfig(fresh);
			if (res.ENABLE_IMAGE_GENERATION) void loadModels();
			return true;
		} catch (error) {
			toast.error(`${error}`);
			return false;
		}
	};

	const save = async () => {
		setSaving(true);
		try {
			if (await persist()) toastSaved();
		} finally {
			setSaving(false);
		}
	};

	// The backend verifies the URL it has stored, so what is on screen is saved first.
	const verify = async () => {
		if (!(await persist())) return;
		const res = await verifyConfigUrl(token).catch((e) => void toast.error(`${e}`));
		if (res) toast.success('Server connection verified');
	};

	const c = draft?.config;

	const text = (name: string, label: string, opts: { placeholder?: string; description?: string; required?: boolean; list?: string } = {}) => (
		<SettingField label={label} description={opts.description} htmlFor={`img-${name}`}>
			<SettingInput id={`img-${name}`} list={opts.list} required={opts.required} placeholder={opts.placeholder ?? label} value={c?.[name] ?? ''} onChange={(e) => set({ [name]: e.target.value })} />
		</SettingField>
	);
	const secret = (name: string, placeholder: string, opts: { label?: string; description?: string; required?: boolean } = {}) => (
		<SettingField label={opts.label ?? 'API Key'} description={opts.description} htmlFor={`img-${name}`}>
			<SensitiveInput id={`img-${name}`} variant="settings" placeholder={placeholder} required={opts.required ?? false} value={c?.[name] ?? ''} onChange={(v) => set({ [name]: v })} />
		</SettingField>
	);
	const params = (name: string, description: string): ReactNode => (
		<SettingField label="Additional Parameters" description={description} htmlFor={`img-${name}`}>
			<SettingTextarea id={`img-${name}`} rows={5} placeholder="Enter additional parameters in JSON format" value={c?.[name] ?? ''} onChange={(e) => set({ [name]: e.target.value })} />
		</SettingField>
	);
	const toggle = (name: string, label: string, description: string) => (
		<SettingRow label={label} description={description}>
			{(id) => <SettingSwitch checked={Boolean(c?.[name])} onChange={(v) => set({ [name]: v })} labelledBy={id} />}
		</SettingRow>
	);
	const modelList = (
		<datalist id="img-model-list">
			{models.map((m) => (
				<option key={m.id} value={m.id}>
					{m.name}
				</option>
			))}
		</datalist>
	);

	const engine = c?.IMAGE_GENERATION_ENGINE;
	const editEngine = c?.IMAGE_EDIT_ENGINE;

	return (
		<SettingsForm title="Images" loading={isLoading} onSubmit={save} saving={saving}>
			{draft && c && (
				<>
					<SettingsSection first>{toggle('ENABLE_IMAGE_GENERATION', 'Image Generation', 'Allow users to generate images from prompts.')}</SettingsSection>

					<SettingsSection title="Create Image">
						<SettingRow label="Image Generation Engine" description="Choose the provider used for image generation.">
							<SettingSelect value={engine} onChange={(v) => set({ IMAGE_GENERATION_ENGINE: v })} aria-label="Image Generation Engine">
								<option value="openai">Default (Open AI)</option>
								<option value="comfyui">ComfyUI</option>
								<option value="automatic1111">Automatic1111</option>
								<option value="gemini">Gemini</option>
							</SettingSelect>
						</SettingRow>

						{c.ENABLE_IMAGE_GENERATION && (
							<>
								<div className={twoUp}>
									{text('IMAGE_GENERATION_MODEL', 'Model', { list: 'img-model-list', placeholder: 'Select a model', required: true })}
									{text('IMAGE_SIZE', 'Image Size', { placeholder: 'Enter Image Size (e.g. 512x512)' })}
									{['comfyui', 'automatic1111', ''].includes(engine) && (
										<SettingField label="Steps" htmlFor="img-IMAGE_STEPS">
											<SettingNumber id="img-IMAGE_STEPS" required placeholder="Enter Number of Steps (e.g. 50)" value={c.IMAGE_STEPS} onChange={(v) => set({ IMAGE_STEPS: v })} />
										</SettingField>
									)}
								</div>
								{toggle('ENABLE_IMAGE_PROMPT_GENERATION', 'Image Prompt Generation', 'Generate an image prompt before sending the request.')}
							</>
						)}

						{engine === 'openai' && (
							<>
								<div className={twoUp}>
									{text('IMAGES_OPENAI_API_BASE_URL', 'API Base URL')}
									{secret('IMAGES_OPENAI_API_KEY', 'API Key')}
								</div>
								{text('IMAGES_OPENAI_API_VERSION', 'API Version')}
								{params('IMAGES_OPENAI_API_PARAMS', 'Send extra JSON parameters with each image generation request.')}
							</>
						)}

						{engine === 'automatic1111' && (
							<>
								<VerifiedUrl
									id="img-AUTOMATIC1111_BASE_URL"
									label="Base URL"
									description="Connect to a stable-diffusion-webui server running with the `--api` flag."
									placeholder="Enter URL (e.g. http://127.0.0.1:7860/)"
									value={c.AUTOMATIC1111_BASE_URL}
									onChange={(v) => set({ AUTOMATIC1111_BASE_URL: v })}
									onVerify={verify}
								/>
								{secret('AUTOMATIC1111_API_AUTH', 'Enter api auth string (e.g. username:password)', { label: 'API Auth String', description: 'Provide the --api-auth username and password when required.' })}
								{params('AUTOMATIC1111_PARAMS', 'Send extra JSON parameters with each AUTOMATIC1111 request.')}
							</>
						)}

						{engine === 'comfyui' && (
							<>
								<VerifiedUrl
									id="img-COMFYUI_BASE_URL"
									label="Base URL"
									description="Connect to the ComfyUI server used for generation."
									placeholder="Enter URL (e.g. http://127.0.0.1:7860/)"
									value={c.COMFYUI_BASE_URL}
									onChange={(v) => set({ COMFYUI_BASE_URL: v })}
									onVerify={verify}
								/>
								{secret('COMFYUI_API_KEY', 'sk-1234', { description: 'Use an API key when your ComfyUI server requires one.' })}
								<ComfyWorkflow
									id="comfyui-workflow"
									workflow={c.COMFYUI_WORKFLOW ?? ''}
									onWorkflow={(t) => set({ COMFYUI_WORKFLOW: t })}
									rows={draft.nodes}
									onRows={setNodes}
									nodesDescription="Map workflow node inputs used for image generation."
									requiredTypes={['prompt']}
								/>
							</>
						)}

						{engine === 'gemini' && (
							<>
								{text('IMAGES_GEMINI_API_BASE_URL', 'Base URL', { placeholder: 'API Base URL', description: 'Override the Gemini image generation endpoint.' })}
								{secret('IMAGES_GEMINI_API_KEY', 'API Key', { description: 'Use a Gemini API key for image generation.', required: true })}
								<SettingRow label="Gemini Endpoint Method" description="Select the Gemini endpoint method to call.">
									<SettingSelect value={c.IMAGES_GEMINI_ENDPOINT_METHOD} onChange={(v) => set({ IMAGES_GEMINI_ENDPOINT_METHOD: v })} aria-label="Gemini Endpoint Method">
										<option value="predict">predict</option>
										<option value="generateContent">generateContent</option>
									</SettingSelect>
								</SettingRow>
							</>
						)}
					</SettingsSection>

					<SettingsSection title="Edit Image">
						{toggle('ENABLE_IMAGE_EDIT', 'Image Edit', 'Allow users to edit existing images.')}
						<SettingRow label="Image Edit Engine" description="Choose the provider used for image edits.">
							<SettingSelect value={editEngine} onChange={(v) => set({ IMAGE_EDIT_ENGINE: v })} aria-label="Image Edit Engine">
								<option value="openai">Default (Open AI)</option>
								<option value="comfyui">ComfyUI</option>
								<option value="gemini">Gemini</option>
							</SettingSelect>
						</SettingRow>

						{c.ENABLE_IMAGE_GENERATION && c.ENABLE_IMAGE_EDIT && (
							<div className={twoUp}>
								{text('IMAGE_EDIT_MODEL', 'Model', { list: 'img-model-list', placeholder: 'Select a model' })}
								{text('IMAGE_EDIT_SIZE', 'Image Size', { placeholder: 'Enter Image Size (e.g. 512x512)' })}
							</div>
						)}
						{modelList}

						{editEngine === 'openai' && (
							<>
								<div className={twoUp}>
									{text('IMAGES_EDIT_OPENAI_API_BASE_URL', 'API Base URL')}
									{secret('IMAGES_EDIT_OPENAI_API_KEY', 'API Key')}
								</div>
								{text('IMAGES_EDIT_OPENAI_API_VERSION', 'API Version')}
							</>
						)}

						{editEngine === 'comfyui' && (
							<>
								<VerifiedUrl
									id="img-IMAGES_EDIT_COMFYUI_BASE_URL"
									label="Base URL"
									description="Connect to the ComfyUI server used for image edits."
									placeholder="Enter URL (e.g. http://127.0.0.1:7860/)"
									value={c.IMAGES_EDIT_COMFYUI_BASE_URL}
									onChange={(v) => set({ IMAGES_EDIT_COMFYUI_BASE_URL: v })}
									onVerify={verify}
								/>
								{secret('IMAGES_EDIT_COMFYUI_API_KEY', 'sk-1234', { description: 'Use an API key when your ComfyUI server requires one.' })}
								<ComfyWorkflow
									id="comfyui-edit-workflow"
									workflow={c.IMAGES_EDIT_COMFYUI_WORKFLOW ?? ''}
									onWorkflow={(t) => set({ IMAGES_EDIT_COMFYUI_WORKFLOW: t })}
									rows={draft.editNodes}
									onRows={setEditNodes}
									nodesDescription="Map workflow node inputs used for image edits."
									requiredTypes={['prompt', 'image']}
								/>
							</>
						)}

						{editEngine === 'gemini' && (
							<div className={twoUp}>
								{text('IMAGES_EDIT_GEMINI_API_BASE_URL', 'Base URL', { placeholder: 'API Base URL' })}
								{secret('IMAGES_EDIT_GEMINI_API_KEY', 'API Key', { required: true })}
							</div>
						)}
					</SettingsSection>
				</>
			)}
		</SettingsForm>
	);
}
