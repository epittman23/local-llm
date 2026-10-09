import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Spinner } from '@/components/common/Spinner';
import { SettingSelect } from '@/components/settings/controls';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { getOllamaConfig } from '@/lib/apis/ollama';
import { getOpenAIConfig } from '@/lib/apis/openai';
import { useAuthStore } from '@/lib/stores/authStore';
import { ManageOllama } from './ManageOllama';
import { ManageProviderModels } from './ManageProviderModels';
import {
	type ProviderConnection,
	hasOllamaManagement,
	managementConnections,
	providerLabel,
	providerSupportsDelete
} from './providerModels';

type Engine = 'ollama' | 'provider' | '' | null;

/** Ollama's instances, as a picker over `ManageOllama`. */
function OllamaSection({ urls }: { urls: string[] }) {
	const [idx, setIdx] = useState('0');
	return (
		<>
			<div className="mb-2 text-sm font-normal">Ollama</div>
			<div className="mb-2.5 flex-1">
				<SettingSelect className="w-full" value={idx} onChange={setIdx} aria-label="Ollama instance">
					{urls.map((url, i) => (
						<option key={url + i} value={String(i)}>
							{url}
						</option>
					))}
				</SettingSelect>
			</div>
			<ManageOllama key={idx} urlIdx={Number(idx)} />
		</>
	);
}

/** llama.cpp and LM Studio connections, as a picker over `ManageProviderModels`. */
function ProviderSection({ connections }: { connections: ProviderConnection[] }) {
	const [idx, setIdx] = useState(String(connections[0]?.idx ?? 0));
	const selected = connections.find((c) => String(c.idx) === idx) ?? connections[0];
	return (
		<>
			<div className="mb-2 text-sm font-normal">Model providers</div>
			<div className="mb-2.5 flex-1">
				<SettingSelect
					className="w-full"
					value={selected ? String(selected.idx) : idx}
					onChange={setIdx}
					aria-label="Provider instance"
				>
					{connections.map((c) => (
						<option key={c.idx} value={String(c.idx)}>
							{providerLabel(c.provider)} - {c.url}
						</option>
					))}
				</SettingSelect>
			</div>
			{selected && (
				<ManageProviderModels
					key={selected.idx}
					urlIdx={selected.idx}
					provider={selected.provider}
					label={providerLabel(selected.provider)}
					supportsDelete={providerSupportsDelete(selected.provider)}
				/>
			)}
		</>
	);
}

/** Ports admin/Settings/Models/ManageModelsModal.svelte: manage the models on Ollama, and on llama.cpp / LM Studio connections. */
export function ManageModelsModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const token = useAuthStore((s) => s.token) ?? '';
	const [engine, setEngine] = useState<Engine>(null);
	const [ollamaUrls, setOllamaUrls] = useState<string[]>([]);
	const [connections, setConnections] = useState<ProviderConnection[]>([]);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		(async () => {
			setEngine(null);
			try {
				const [ollama, openai] = await Promise.all([getOllamaConfig(token), getOpenAIConfig(token)]);
				if (cancelled) return;
				const providers = managementConnections(openai);
				setOllamaUrls(hasOllamaManagement(ollama) ? (ollama.OLLAMA_BASE_URLS as string[]) : []);
				setConnections(providers);
				setEngine(hasOllamaManagement(ollama) ? 'ollama' : providers.length > 0 ? 'provider' : '');
			} catch (error) {
				if (cancelled) return;
				toast.error(`${error}`);
				setEngine('');
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [open, token]);

	const both = ollamaUrls.length > 0 && connections.length > 0;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Manage Models</DialogTitle>
					<DialogDescription className="sr-only">
						Download, delete and load models on your inference engines.
					</DialogDescription>
				</DialogHeader>
				<div className="flex w-full flex-col">
					{engine === null ? (
						<div className="py-5">
							<Spinner />
						</div>
					) : engine === '' ? (
						<div className="text-muted-foreground py-5 text-xs">No inference engine with management support found</div>
					) : (
						<div className="px-1.5 py-1">
							{both && (
								<div className="mb-2">
									<SettingSelect
										className="w-full"
										value={engine}
										onChange={(v) => setEngine(v as Engine)}
										aria-label="Engine"
									>
										<option value="ollama">Ollama</option>
										<option value="provider">Model providers</option>
									</SettingSelect>
								</div>
							)}
							{engine === 'ollama' ? (
								<OllamaSection urls={ollamaUrls} />
							) : (
								<ProviderSection connections={connections} />
							)}
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
