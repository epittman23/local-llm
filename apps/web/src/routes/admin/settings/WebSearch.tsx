import { useState } from 'react';
import { toast } from 'sonner';
import { Tip } from '@/components/common/Tip';
import {
	BoundNumber,
	BoundSecret,
	BoundSelect,
	BoundText,
	BoundTextarea,
	BoundToggle
} from '@/components/settings/boundFields';
import {
	SettingField,
	SettingNumber,
	SettingRow,
	SettingSelect,
	SettingsForm,
	SettingsSection
} from '@/components/settings/controls';
import { getRAGConfig, updateRAGConfig } from '@/lib/apis/retrieval';
import { useAdminConfigSaved } from '@/lib/settings/useAdminSaved';
import { useConfigDraft } from '@/lib/settings/useConfigDraft';
import { useAuthStore } from '@/lib/stores/authStore';
import {
	type FieldSpec,
	LOADER_ENGINES,
	SEARCH_ENGINES,
	SEARCH_ENGINE_FIELDS,
	engineLabel,
	isDefaultLoader,
	loaderFields,
	prepareWebConfig,
	toWebForm
} from './webSearch';

type Rec = Record<string, any>;

const PERPLEXITY_MODELS = [
	['sonar', 'Sonar'],
	['sonar-pro', 'Sonar Pro'],
	['sonar-reasoning', 'Sonar Reasoning'],
	['sonar-reasoning-pro', 'Sonar Reasoning Pro'],
	['sonar-deep-research', 'Sonar Deep Research']
] as const;

const DDGS_BACKENDS = [
	['auto', 'Auto (Random)'],
	['bing', 'Bing'],
	['brave', 'Brave'],
	['duckduckgo', 'DuckDuckGo'],
	['google', 'Google'],
	['grokipedia', 'Grokipedia'],
	['mojeek', 'Mojeek'],
	['wikipedia', 'Wikipedia'],
	['yahoo', 'Yahoo'],
	['yandex', 'Yandex']
] as const;

/** The boxes an engine (or loader) asks for, from its `FieldSpec`s. */
function Fields({ fields, config, set }: { fields: FieldSpec[]; config: Rec; set: (changes: Rec) => void }) {
	const bound = { config, set, idPrefix: 'web' };
	return (
		<>
			{fields.map((f) => {
				const key = `${f.name}`;
				switch (f.kind) {
					case 'secret':
						return (
							<BoundSecret key={key} {...bound} name={f.name} label={f.label} placeholder={f.placeholder ?? f.label} />
						);
					case 'number':
						return (
							<BoundNumber
								key={key}
								{...bound}
								name={f.name}
								label={f.label}
								placeholder={f.placeholder}
								min={f.min}
								max={f.max}
								step={f.step}
							/>
						);
					case 'textarea':
						return (
							<SettingField key={key} label={f.label} htmlFor={`web-${f.name}`}>
								<Tip content={f.tip}>
									<textarea
										id={`web-${f.name}`}
										className="bg-muted/40 placeholder:text-muted-foreground/50 focus:border-ring w-full rounded-lg border px-2 py-1.5 text-xs outline-hidden transition-colors"
										rows={4}
										placeholder={f.placeholder}
										value={config[f.name] ?? ''}
										onChange={(e) => set({ [f.name]: e.target.value })}
									/>
								</Tip>
							</SettingField>
						);
					default:
						return (
							<BoundText
								key={key}
								{...bound}
								name={f.name}
								label={f.label}
								placeholder={f.placeholder}
								required={f.required}
							/>
						);
				}
			})}
		</>
	);
}

/** Ports admin/Settings/WebSearch.svelte. */
export default function WebSearch() {
	const token = useAuthStore((s) => s.token) ?? '';
	const saved = useAdminConfigSaved();
	const { draft, setDraft, isLoading } = useConfigDraft<{ web: Rec }>(['web-search'], async () => {
		const res = await getRAGConfig(token);
		return res ? { web: toWebForm(res.web ?? {}) } : null;
	});
	const [saving, setSaving] = useState(false);

	const set = (changes: Rec) => setDraft((d) => d && { web: { ...d.web, ...changes } });

	const save = async () => {
		if (!draft) return;
		const prepared = prepareWebConfig(draft.web);
		if (!prepared.ok) {
			toast.error(prepared.error);
			return;
		}
		setSaving(true);
		try {
			await updateRAGConfig(token, prepared.payload);
			await saved();
		} catch (error) {
			toast.error(`${error}`);
		} finally {
			setSaving(false);
		}
	};

	const web = draft?.web;
	const bound = { config: web ?? {}, set, idPrefix: 'web' };
	const engine: string = web?.WEB_SEARCH_ENGINE ?? '';
	const loader: string = web?.WEB_LOADER_ENGINE ?? '';

	return (
		<SettingsForm title="Web Search" loading={isLoading} onSubmit={save} saving={saving}>
			{web && (
				<>
					<SettingsSection title="Search" first>
						<BoundToggle
							{...bound}
							name="ENABLE_WEB_SEARCH"
							label="Web Search"
							description="Allow users to search the web from chats."
						/>
						<BoundToggle
							{...bound}
							name="ENABLE_WEB_SEARCH_CONFIRMATION"
							label="Web Search Confirmation"
							description="Require users to confirm before using Web Search."
						/>
						{web.ENABLE_WEB_SEARCH_CONFIRMATION && (
							<BoundTextarea
								{...bound}
								name="WEB_SEARCH_CONFIRMATION_CONTENT"
								label="Web Search Confirmation Content"
								description="Message shown before web search runs."
								placeholder="Your query will be sent to the configured web search provider."
							/>
						)}

						<SettingRow label="Web Search Engine" description="Choose the provider used for web search queries.">
							<SettingSelect
								value={engine}
								onChange={(v) => set({ WEB_SEARCH_ENGINE: v })}
								required
								aria-label="Web Search Engine"
							>
								<option disabled value="">
									Select a engine
								</option>
								{SEARCH_ENGINES.map((e) => (
									<option key={e} value={e}>
										{engineLabel(e)}
									</option>
								))}
							</SettingSelect>
						</SettingRow>

						{engine !== '' && (
							<>
								<Fields fields={SEARCH_ENGINE_FIELDS[engine] ?? []} config={web} set={set} />

								{engine === 'perplexity' && (
									<>
										<BoundText
											{...bound}
											name="PERPLEXITY_MODEL"
											label="Perplexity Model"
											list="perplexity-model-list"
										/>
										<datalist id="perplexity-model-list">
											{PERPLEXITY_MODELS.map(([value, label]) => (
												<option key={value} value={value}>
													{label}
												</option>
											))}
										</datalist>
										<BoundSelect
											{...bound}
											name="PERPLEXITY_SEARCH_CONTEXT_USAGE"
											label="Perplexity Search Context Usage"
											options={[
												['low', 'Low'],
												['medium', 'Medium'],
												['high', 'High']
											]}
										/>
									</>
								)}

								{engine === 'duckduckgo' && (
									<BoundSelect {...bound} name="DDGS_BACKEND" label="DDGS Backend" options={DDGS_BACKENDS} />
								)}
							</>
						)}

						{web.ENABLE_WEB_SEARCH && (
							<>
								<SettingField label="Search Limits" description="Control result volume and parallel search requests.">
									<div role="group" aria-label="Search Limits" className="flex gap-2">
										<div className="w-full">
											<label className="text-muted-foreground mb-1 block text-xs" htmlFor="web-WEB_SEARCH_RESULT_COUNT">
												Search Result Count
											</label>
											<SettingNumber
												id="web-WEB_SEARCH_RESULT_COUNT"
												required
												placeholder="Search Result Count"
												value={web.WEB_SEARCH_RESULT_COUNT}
												onChange={(v) => set({ WEB_SEARCH_RESULT_COUNT: v === '' ? null : v })}
											/>
										</div>
										<div className="w-full">
											<Tip content="Limit concurrent search queries. 0 = unlimited (default). Set to 1 for sequential execution (recommended for APIs with strict rate limits like Brave free tier).">
												<label
													className="text-muted-foreground mb-1 block w-fit text-xs"
													htmlFor="web-WEB_SEARCH_CONCURRENT_REQUESTS"
												>
													Concurrent Requests
												</label>
											</Tip>
											<SettingNumber
												id="web-WEB_SEARCH_CONCURRENT_REQUESTS"
												min={0}
												placeholder="Concurrent Requests"
												value={web.WEB_SEARCH_CONCURRENT_REQUESTS}
												onChange={(v) => set({ WEB_SEARCH_CONCURRENT_REQUESTS: v === '' ? null : v })}
											/>
										</div>
									</div>
								</SettingField>

								<BoundNumber
									{...bound}
									name="WEB_FETCH_MAX_CONTENT_LENGTH"
									label="Fetch URL Content Length Limit"
									description="Maximum characters to return from fetched URLs. Leave empty for no limit."
									placeholder="No limit"
									min={0}
								/>
								<BoundText
									{...bound}
									name="WEB_SEARCH_DOMAIN_FILTER_LIST"
									label="Domain Filter List"
									description="Restrict or exclude domains using a comma-separated list."
									placeholder="Enter domains separated by commas (e.g., example.com,site.org,!excludedsite.com)"
								/>
							</>
						)}

						<BoundToggle
							{...bound}
							name="BYPASS_WEB_SEARCH_EMBEDDING_AND_RETRIEVAL"
							label="Bypass Embedding and Retrieval"
							description={
								web.BYPASS_WEB_SEARCH_EMBEDDING_AND_RETRIEVAL
									? 'Inject the entire content as context for comprehensive processing.'
									: 'Use segmented retrieval for focused and relevant content extraction.'
							}
						/>
						<BoundToggle
							{...bound}
							name="BYPASS_WEB_SEARCH_WEB_LOADER"
							label="Bypass Web Loader"
							description="Use search results without fetching page contents."
						/>
						<BoundToggle
							{...bound}
							name="WEB_SEARCH_TRUST_ENV"
							label="Trust Proxy Environment"
							description={
								web.WEB_SEARCH_TRUST_ENV
									? 'Use proxy environment variables to fetch page contents.'
									: 'Fetch page contents without proxy environment variables.'
							}
						/>
					</SettingsSection>

					<SettingsSection title="Loader">
						<SettingRow label="Web Loader Engine" description="Choose how web result pages are fetched and read.">
							<SettingSelect
								value={loader}
								onChange={(v) => set({ WEB_LOADER_ENGINE: v })}
								aria-label="Web Loader Engine"
							>
								<option value="">Default</option>
								{LOADER_ENGINES.map((e) => (
									<option key={e} value={e}>
										{e}
									</option>
								))}
							</SettingSelect>
						</SettingRow>

						{isDefaultLoader(loader) && (
							<>
								<BoundText
									{...bound}
									name="WEB_LOADER_TIMEOUT"
									label="Timeout"
									description="Maximum time to wait while loading web content."
									placeholder="Timeout"
								/>
								<BoundToggle
									{...bound}
									name="ENABLE_WEB_LOADER_SSL_VERIFICATION"
									label="Verify SSL Certificate"
									description="Validate SSL certificates when fetching web content."
								/>
							</>
						)}
						<Fields fields={loaderFields(loader, engine)} config={web} set={set} />

						<BoundNumber
							{...bound}
							name="WEB_LOADER_CONCURRENT_REQUESTS"
							label="Concurrent Requests"
							description="Limit parallel web loader requests."
							placeholder="Concurrent Requests"
							required
						/>
						<BoundText
							{...bound}
							name="YOUTUBE_LOADER_LANGUAGE"
							label="Youtube Language"
							description="Preferred transcript language codes, separated by commas."
							placeholder="Enter language codes"
						/>
						<BoundText
							{...bound}
							name="YOUTUBE_LOADER_PROXY_URL"
							label="Youtube Proxy URL"
							description="Proxy URL used for Youtube loader requests."
							placeholder="Enter proxy URL (e.g. https://user:password@host:port)"
						/>
					</SettingsSection>
				</>
			)}
		</SettingsForm>
	);
}
