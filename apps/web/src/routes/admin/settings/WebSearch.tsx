import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
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
	SettingsSection,
	SettingTextarea,
	useSettingErrors
} from '@/components/settings/controls';
import { getRAGConfig, updateRAGConfig } from '@/lib/apis/retrieval';
import { useAdminConfigSaved } from '@/lib/settings/useAdminSaved';
import { useConfigDraft } from '@/lib/settings/useConfigDraft';
import { useAuthStore } from '@/lib/stores/authStore';
import { ragSaveOutcome } from './documents';
import {
	bundledSearxngPrefill,
	engineLabel,
	type FieldSpec,
	isDefaultLoader,
	LOADER_ENGINES,
	loaderFields,
	loaderLabel,
	prepareWebConfig,
	SEARCH_ENGINE_FIELDS,
	SEARCH_ENGINE_ORDER,
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
							<SettingField key={key} label={f.label} description={f.tip} htmlFor={`web-${f.name}`}>
								<SettingTextarea
									id={`web-${f.name}`}
									className="font-mono"
									rows={4}
									placeholder={f.placeholder}
									value={config[f.name] ?? ''}
									onChange={(e) => set({ [f.name]: e.target.value })}
								/>
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
	const { draft, setDraft, dirty, discard, commit, isLoading } = useConfigDraft<{ web: Rec }>(
		['web-search'],
		async () => {
			const res = await getRAGConfig(token);
			return res ? { web: toWebForm(res.web ?? {}) } : null;
		}
	);
	const [saving, setSaving] = useState(false);
	const prepared = draft ? prepareWebConfig(draft.web) : null;
	const { errors, check, reset } = useSettingErrors(
		prepared && !prepared.ok ? { [`web-${prepared.field}`]: prepared.error } : {}
	);

	const set = (changes: Rec) => setDraft((d) => d && { web: { ...d.web, ...changes } });

	// S5-D6: with no engine stored, preselect the bundled SearXNG once, on load. The draft is then
	// unsaved on purpose: Save stores it, Discard changes goes back to no engine.
	const prefilled = useRef(false);
	const [preselected, setPreselected] = useState(false);
	useEffect(() => {
		if (prefilled.current || !draft) return;
		prefilled.current = true;
		const prefill = bundledSearxngPrefill(draft.web);
		if (prefill) {
			setDraft((d) => d && { web: { ...d.web, ...prefill } });
			setPreselected(true);
		}
	}, [draft, setDraft]);

	const save = async () => {
		if (!draft || !prepared || !check() || !prepared.ok) return;
		setSaving(true);
		try {
			const res = await updateRAGConfig(token, prepared.payload);
			commit(draft);
			// This tab sends no hybrid-search flag, but the save reloads the
			// reranker, so it can still turn hybrid search off (#232).
			for (const warning of ragSaveOutcome({}, res).warnings) toast.warning(warning, { duration: 15000 });
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
		<SettingsForm
			title="Web Search"
			loading={isLoading}
			onSubmit={save}
			saving={saving}
			dirty={dirty}
			errors={errors}
			onDiscard={() => {
				discard();
				reset();
			}}
		>
			{web && (
				<>
					<SettingsSection title="Search" first>
						<BoundToggle
							{...bound}
							name="ENABLE_WEB_SEARCH"
							label="Web Search"
							description="Let chats search the web."
						/>
						<BoundToggle
							{...bound}
							name="ENABLE_WEB_SEARCH_CONFIRMATION"
							label="Web Search Confirmation"
							description="Ask before a chat searches the web."
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

						<SettingRow
							label="Web Search Engine"
							description={
								preselected && engine === 'searxng' && dirty
									? 'SearXNG, bundled with the stack, is preselected. Save to use it.'
									: 'Choose the provider used for web search queries.'
							}
						>
							<SettingSelect
								value={engine}
								onChange={(v) => set({ WEB_SEARCH_ENGINE: v })}
								required
								aria-label="Web Search Engine"
							>
								<option disabled value="">
									Select an engine
								</option>
								{SEARCH_ENGINE_ORDER.map((e) => (
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
								<SettingField
									label="Search Limits"
									description="How many results each search returns, and how many searches run at once (0 for no limit; 1 for APIs with strict rate limits, such as Brave's free tier)."
								>
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
											<label
												className="text-muted-foreground mb-1 block w-fit text-xs"
												htmlFor="web-WEB_SEARCH_CONCURRENT_REQUESTS"
											>
												Concurrent Requests
											</label>
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
							description="Send each result page to the model whole, without splitting or embedding it. Fine for a few short pages; many or long ones may not fit the model's context."
						/>
						<BoundToggle
							{...bound}
							name="BYPASS_WEB_SEARCH_WEB_LOADER"
							label="Bypass Web Loader"
							description="Use only the snippets the search engine returns, without opening each page. Faster, but replies see less of each page."
						/>
						<BoundToggle
							{...bound}
							name="WEB_SEARCH_TRUST_ENV"
							label="Trust Proxy Environment"
							description="Open result pages through the proxy in the server's HTTP_PROXY and HTTPS_PROXY variables. Turn on only if this machine needs a proxy to reach the web."
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
										{loaderLabel(e)}
									</option>
								))}
							</SettingSelect>
						</SettingRow>

						{isDefaultLoader(loader) && (
							<>
								<BoundText
									{...bound}
									name="WEB_LOADER_TIMEOUT"
									label="Timeout (s)"
									description="Seconds to wait for each page. Leave empty for no limit."
									placeholder="No limit"
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
							label="YouTube Language"
							description="Preferred transcript language codes, separated by commas."
							placeholder="Enter language codes"
						/>
						<BoundText
							{...bound}
							name="YOUTUBE_LOADER_PROXY_URL"
							label="YouTube Proxy URL"
							description="Proxy used to fetch YouTube transcripts."
							placeholder="Enter proxy URL (e.g. https://user:password@host:port)"
						/>
					</SettingsSection>
				</>
			)}
		</SettingsForm>
	);
}
