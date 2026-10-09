type Rec = Record<string, any>;

export type ProviderModel = {
	id?: string;
	key?: string;
	name?: string;
	model?: string;
	display_name?: string;
	status?: string | { value?: string };
	loaded_instances?: { id?: string }[];
} & Rec;

export const modelIdOf = (m: ProviderModel): string => m.key ?? m.id ?? m.name ?? m.model ?? '';
export const displayNameOf = (m: ProviderModel): string => m.display_name ?? modelIdOf(m);

/** What to hand the provider to unload a model: its first loaded instance, else the model itself. */
export const unloadIdOf = (m: ProviderModel): string => m.loaded_instances?.[0]?.id ?? modelIdOf(m);

/** `loaded`, `unloaded`, `loading`, ...: what the provider says, with LM Studio's "not loaded" made explicit. */
export function statusOf(m: ProviderModel, provider: string): string {
	if (m.loaded_instances?.length) return 'loaded';
	if (provider === 'lmstudio') return 'unloaded';
	const status = m.status;
	if (typeof status === 'string') return status;
	return status?.value ?? 'available';
}

export function statusClass(status: string): string {
	if (status === 'loaded' || status === 'sleeping')
		return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300';
	if (status === 'loading' || status === 'downloading')
		return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300';
	return 'bg-muted text-muted-foreground';
}

/** A provider's model list, whatever shape it answers in, as a sorted list of models that have an id. */
export function normalizeCatalog(response: unknown): ProviderModel[] {
	const r = response as Rec | null;
	const entries = Array.isArray(response) ? response : (r?.models ?? r?.data ?? r?.items ?? []);
	return (Array.isArray(entries) ? entries : [])
		.map((m: ProviderModel | string) => (typeof m === 'string' ? { id: m, name: m } : m))
		.filter((m: ProviderModel) => m && modelIdOf(m) !== '')
		.sort((a: ProviderModel, b: ProviderModel) => modelIdOf(a).localeCompare(modelIdOf(b)));
}

export const providerLabel = (provider = ''): string =>
	provider === 'lmstudio' ? 'LM Studio' : provider === 'llama.cpp' ? 'llama.cpp' : provider;

/** Only llama.cpp can delete models it has cached. */
export const providerSupportsDelete = (provider = ''): boolean => provider === 'llama.cpp';

const MANAGEMENT_PROVIDERS = new Set(['llama.cpp', 'lmstudio']);

export type ProviderConnection = { idx: number; url: string; provider: string; config: Rec };

/**
 * The OpenAI-style connections that can manage their models (llama.cpp and LM
 * Studio). A connection's settings may be keyed by its index, its index as text,
 * or its URL, depending on how they were saved.
 */
export function managementConnections(openaiConfig: Rec | null | undefined): ProviderConnection[] {
	if (!openaiConfig?.ENABLE_OPENAI_API) return [];
	const configs = openaiConfig.OPENAI_API_CONFIGS ?? {};
	return (openaiConfig.OPENAI_API_BASE_URLS ?? [])
		.map((url: string, idx: number) => {
			const config = configs[idx] ?? configs[String(idx)] ?? configs[url] ?? {};
			return { idx, url, provider: config.provider ?? '', config };
		})
		.filter((c: ProviderConnection) => MANAGEMENT_PROVIDERS.has(c.provider));
}

/** Whether Ollama has anything to manage: enabled, with at least one instance. */
export const hasOllamaManagement = (ollamaConfig: Rec | null | undefined): boolean =>
	Boolean(ollamaConfig?.ENABLE_OLLAMA_API && (ollamaConfig?.OLLAMA_BASE_URLS ?? []).length > 0);
