import { useQuery } from '@tanstack/react-query';
import saveAs from 'file-saver';
import { Download, MinusCircle, MoreHorizontal, Pencil, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { toast } from 'sonner';
import { AdvancedParams } from '@/components/common/AdvancedParams';
import { Spinner } from '@/components/common/Spinner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { getModels } from '@/lib/apis';
import { imageEdits, imageGenerations } from '@/lib/apis/images';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore, useDocumentTitle } from '@/lib/stores/configStore';
import { cn } from '@/lib/utils';
import { FeatureGate } from '@/routes/common/FeatureGate';
import {
	appendAssistant,
	chatRequest,
	chatToExport,
	chatToText,
	initialModel,
	type PlaygroundMessage
} from './playgroundModel';
import { useStreamRunner } from './useStreamRunner';

type ModelInfo = { id: string; name: string };

const tab = ({ isActive }: { isActive: boolean }) =>
	cn('min-w-fit px-1 text-sm transition select-none', isActive ? '' : 'text-foreground-muted hover:text-foreground');

/** Ports routes/(app)/playground/+layout.svelte: admin only, with Chat / Completions / Images tabs. */
export function PlaygroundLayout() {
	useDocumentTitle('Playground');
	return (
		<FeatureGate feature="playground">
			<div className="flex h-full min-h-0 w-full flex-col">
				<nav className="flex items-center gap-1 px-2.5 pt-2 pb-1" aria-label="Playground">
					<NavLink to="/playground" end className={tab}>
						Chat
					</NavLink>
					<NavLink to="/playground/completions" className={tab}>
						Completions
					</NavLink>
					<NavLink to="/playground/images" className={tab}>
						Images
					</NavLink>
				</nav>
				<div className="min-h-0 flex-1 overflow-y-auto">
					<Outlet />
				</div>
			</div>
		</FeatureGate>
	);
}

/** The models to pick from, and the one to start on (the user's first chosen model, else the admin default). */
function usePlaygroundModel() {
	const token = useAuthStore((s) => s.token) ?? '';
	const defaults = useConfigStore((s) => s.config?.default_models as string | undefined);
	const settings = useUserSettings();
	const models = useQuery({
		queryKey: ['models-all'],
		queryFn: async () => ((await getModels(token)) ?? []) as ModelInfo[]
	});
	const [modelId, setModelId] = useState('');
	const start = initialModel(settings.settings?.models, defaults);
	useEffect(() => {
		if (!modelId && start) setModelId(start);
	}, [modelId, start]);
	return { models: models.data ?? [], modelId, setModelId };
}

function ModelSelect({
	models,
	value,
	onChange
}: {
	models: ModelInfo[];
	value: string;
	onChange: (id: string) => void;
}) {
	return (
		<select
			aria-label="Model"
			className="w-full bg-transparent py-1 text-sm [&>option]:bg-popover"
			value={value}
			onChange={(e) => onChange(e.target.value)}
		>
			{!models.some((m) => m.id === value) && <option value={value}>{value || 'Select a model'}</option>}
			{models.map((m) => (
				<option key={m.id} value={m.id}>
					{m.name}
				</option>
			))}
		</select>
	);
}

/** Ports components/playground/Chat.svelte: a hand-built conversation (either role), system instructions, parameters, run and stream. */
export function PlaygroundChat() {
	const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
	const { models, modelId, setModelId } = usePlaygroundModel();
	const { running, run, stop } = useStreamRunner();
	const [system, setSystem] = useState('');
	const [showSystem, setShowSystem] = useState(false);
	const [messages, setMessages] = useState<PlaygroundMessage[]>([]);
	const [role, setRole] = useState<'user' | 'assistant'>('user');
	const [draft, setDraft] = useState('');
	const [params, setParams] = useState<Record<string, any>>({});
	const [showControls, setShowControls] = useState(false);
	const bottom = useRef<HTMLDivElement>(null);
	useEffect(() => {
		// A block body on purpose: Chromium's scrollIntoView now returns a Promise,
		// which an expression-bodied effect would hand React as its "cleanup".
		bottom.current?.scrollIntoView?.({ block: 'end' });
	}, [messages]);

	const withDraft = () => (draft ? [...messages, { role, content: draft }] : messages);
	const add = () => {
		if (!draft) return;
		setMessages(withDraft());
		setDraft('');
		setRole(role === 'user' ? 'assistant' : 'user');
	};
	const submit = async () => {
		if (!modelId) return void toast.error('Please select a model.');
		const next = withDraft();
		setMessages(next);
		setDraft('');
		await run(chatRequest(modelId, system, next, params), (text) => setMessages((prev) => appendAssistant(prev, text)));
	};
	const exportJson = () => {
		saveAs(
			new Blob([JSON.stringify(chatToExport(system, messages, modelId), null, 2)], { type: 'application/json' }),
			`playground-chat-${Date.now()}.json`
		);
		toast.success('Chat exported successfully');
	};
	const exportText = () => {
		saveAs(new Blob([chatToText(system, messages)], { type: 'text/plain' }), `playground-chat-${Date.now()}.txt`);
		toast.success('Chat exported successfully');
	};

	return (
		<div className="flex h-full flex-col px-2.5">
			<Dialog open={showControls} onOpenChange={setShowControls}>
				<DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-md">
					<DialogHeader>
						<DialogTitle className="text-sm font-medium">Controls</DialogTitle>
						<DialogDescription className="sr-only">Request parameters.</DialogDescription>
					</DialogHeader>
					<AdvancedParams params={params} onChange={setParams} admin={isAdmin} custom />
				</DialogContent>
			</Dialog>

			<div className="flex items-center gap-1.5">
				<div data-composite-field className="flex-1 rounded-lg border px-1.5 py-1 text-sm">
					<Button
						type="button"
						variant="ghost"
						className="h-auto w-full justify-between gap-2 px-0 py-0 font-normal"
						aria-expanded={showSystem}
						onClick={() => setShowSystem((v) => !v)}
					>
						<span className="ml-1.5 shrink-0">System Instructions</span>
						{!showSystem && system.trim() && (
							<span className="text-muted-foreground line-clamp-1 flex-1 text-left">{system}</span>
						)}
						<Pencil className="size-3.5 shrink-0" />
					</Button>
					{showSystem && (
						<textarea
							className="placeholder:text-foreground-muted mt-1 w-full resize-y bg-transparent px-1.5 text-sm"
							aria-label="System Instructions"
							rows={4}
							placeholder="You're a helpful assistant."
							value={system}
							onChange={(e) => setSystem(e.target.value)}
						/>
					)}
				</div>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button type="button" variant="ghost" size="icon-sm" aria-label="More options">
							<MoreHorizontal className="size-3.5" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem disabled={messages.length === 0} onSelect={exportJson}>
							<Download /> Export chat (.json)
						</DropdownMenuItem>
						<DropdownMenuItem disabled={messages.length === 0} onSelect={exportText}>
							<Download /> Plain text (.txt)
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto py-3">
				<ul className="space-y-3">
					{messages.map((m, idx) => (
						// Messages are edited in place and deleted by position; they have no ids.
						<li key={idx} className="group flex gap-2">
							<div className="text-muted-foreground min-w-[6rem] px-2 py-1 pt-2 text-sm uppercase">{m.role}</div>
							<textarea
								className="field-sizing-content w-full resize-none overflow-hidden rounded-lg bg-transparent p-2 text-sm"
								aria-label={`${m.role} message ${idx + 1}`}
								placeholder={`Enter ${m.role === 'user' ? 'a user' : 'an assistant'} message here`}
								rows={1}
								value={m.content}
								onChange={(e) =>
									setMessages(messages.map((x, i) => (i === idx ? { ...x, content: e.target.value } : x)))
								}
							/>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={`Delete message ${idx + 1}`}
								className="opacity-60 group-hover:opacity-100"
								onClick={() => setMessages(messages.filter((_, i) => i !== idx))}
							>
								<MinusCircle className="size-5" />
							</Button>
						</li>
					))}
				</ul>
				<div ref={bottom} />
			</div>

			<div className="pb-3">
				<div data-composite-field className="rounded-2xl border px-3 py-2">
					<textarea
						className="placeholder:text-foreground-muted field-sizing-content max-h-36 w-full resize-none bg-transparent text-sm"
						aria-label="New message"
						rows={2}
						placeholder={`Enter ${role === 'user' ? 'a user' : 'an assistant'} message here`}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
					/>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<Button
							type="button"
							variant="secondary"
							size="sm"
							aria-pressed={role === 'assistant'}
							aria-label={role === 'user' ? 'Switch to Assistant role' : 'Switch to User role'}
							onClick={() => setRole(role === 'user' ? 'assistant' : 'user')}
						>
							{role === 'user' ? 'User' : 'Assistant'}
						</Button>
						<div className="flex w-full items-center gap-2 sm:w-auto">
							<div className="flex-1">
								<ModelSelect models={models} value={modelId} onChange={setModelId} />
							</div>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label="Controls"
								onClick={() => setShowControls(true)}
							>
								<SlidersHorizontal className="size-3.5" />
							</Button>
							{running ? (
								<Button type="button" variant="outline" size="sm" onClick={stop}>
									Cancel
								</Button>
							) : (
								<>
									<Button type="button" variant="outline" size="sm" disabled={!draft} onClick={add}>
										Add
									</Button>
									<Button type="button" size="sm" onClick={submit}>
										Run
									</Button>
								</>
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

/** Ports components/playground/Completions.svelte: one text box the model continues. */
export function PlaygroundCompletions() {
	const { models, modelId, setModelId } = usePlaygroundModel();
	const { running, run, stop } = useStreamRunner();
	const [text, setText] = useState('');
	const area = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (area.current) area.current.scrollTop = area.current.scrollHeight;
	}, [text]);
	const submit = async () => {
		if (!modelId) return void toast.error('Please select a model.');
		await run({ model: modelId, stream: true, messages: [{ role: 'assistant', content: text }] }, (t) =>
			setText((prev) => prev + t)
		);
	};
	return (
		<div className="flex h-full flex-col px-2.5">
			<textarea
				ref={area}
				className="placeholder:text-foreground-muted min-h-0 w-full flex-1 resize-none bg-transparent p-3 text-sm"
				aria-label="Completion text"
				placeholder="You're a helpful assistant."
				value={text}
				onChange={(e) => setText(e.target.value)}
			/>
			<div className="flex items-center justify-between gap-2 pb-3">
				<div className="flex-1">
					<ModelSelect models={models} value={modelId} onChange={setModelId} />
				</div>
				{running ? (
					<Button type="button" variant="outline" size="sm" onClick={stop}>
						Cancel
					</Button>
				) : (
					<Button type="button" size="sm" onClick={submit}>
						Run
					</Button>
				)}
			</div>
		</div>
	);
}

const readAsDataUrl = (file: File) =>
	new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});

/**
 * Ports components/playground/Images.svelte: generate from a prompt, or edit
 * the images added below it. Results collect newest first; clicking one
 * downloads it.
 */
export function PlaygroundImages() {
	const token = useAuthStore((s) => s.token) ?? '';
	const fileInput = useRef<HTMLInputElement>(null);
	const [prompt, setPrompt] = useState('');
	const [sources, setSources] = useState<string[]>([]);
	const [results, setResults] = useState<{ url: string }[]>([]);
	const [loading, setLoading] = useState(false);

	const addFiles = async (files: FileList | File[] | null | undefined) => {
		const images = Array.from(files ?? []).filter((f) => f.type.startsWith('image/'));
		const urls = await Promise.all(images.map(readAsDataUrl));
		setSources((prev) => [...prev, ...urls]);
	};
	const submit = async () => {
		if (!prompt.trim()) return void toast.error('Please enter a prompt');
		setLoading(true);
		try {
			const res = sources.length
				? await imageEdits(token, sources.length === 1 ? sources[0] : sources, prompt)
				: await imageGenerations(token, prompt);
			if (Array.isArray(res)) setResults((prev) => [...res, ...prev]);
		} catch (err) {
			toast.error(`${err}`);
		} finally {
			setLoading(false);
		}
	};
	const download = async (url: string, idx: number) => {
		try {
			saveAs(await (await fetch(url)).blob(), `image-${Date.now()}-${idx}.png`);
		} catch {
			toast.error('Failed to download image');
		}
	};

	return (
		<div className="flex h-full flex-col px-2.5">
			<div className="min-h-0 flex-1 overflow-y-auto p-1">
				{results.length ? (
					<div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
						{results.map((img, idx) => (
							<Button
								key={`${img.url}-${idx}`}
								type="button"
								variant="ghost"
								aria-label={`Download image ${idx + 1}`}
								className="group relative h-auto overflow-hidden rounded-xl p-0"
								onClick={() => download(img.url, idx)}
							>
								<img src={img.url} alt="" className="aspect-square w-full object-cover" />
								<span className="absolute inset-0 flex items-center justify-center bg-surface-2/70 text-foreground opacity-0 transition group-hover:opacity-100">
									<Download className="size-5" />
								</span>
							</Button>
						))}
					</div>
				) : (
					<div className="text-muted-foreground flex h-full items-center justify-center text-sm">
						Generated images will appear here
					</div>
				)}
			</div>
			<div className="pb-3">
				<div data-composite-field className="rounded-2xl border px-3 py-2">
					{sources.length > 0 && (
						<div className="mb-2 flex flex-wrap gap-2">
							{sources.map((src, idx) => (
								<div key={`${src.length}-${idx}`} className="relative">
									<img src={src} alt="" className="size-10 rounded-xl object-cover" />
									<Button
										type="button"
										variant="outline"
										size="icon-xs"
										aria-label={`Remove image ${idx + 1}`}
										className="absolute -top-2 -right-2 rounded-full"
										onClick={() => setSources(sources.filter((_, i) => i !== idx))}
									>
										<X className="size-2.5" />
									</Button>
								</div>
							))}
						</div>
					)}
					<textarea
						className="placeholder:text-foreground-muted field-sizing-content max-h-36 w-full resize-none bg-transparent text-sm"
						aria-label="Image prompt"
						rows={2}
						placeholder={sources.length ? 'Describe the edit...' : 'Describe the image...'}
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !loading) {
								e.preventDefault();
								submit();
							}
						}}
					/>
					<div className="mt-2 flex items-center justify-between gap-2">
						<input
							ref={fileInput}
							type="file"
							accept="image/*"
							multiple
							hidden
							aria-label="Add image files"
							onChange={(e) => {
								addFiles(e.target.files);
								e.target.value = '';
							}}
						/>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							onClick={() => fileInput.current?.click()}
							onDragOver={(e) => e.preventDefault()}
							onDrop={(e) => {
								e.preventDefault();
								addFiles(e.dataTransfer.files);
							}}
						>
							Add Image
						</Button>
						<Button type="button" size="sm" disabled={loading || !prompt.trim()} onClick={submit}>
							{loading ? (
								<>
									<Spinner className="size-4" /> Running...
								</>
							) : (
								'Run'
							)}
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
