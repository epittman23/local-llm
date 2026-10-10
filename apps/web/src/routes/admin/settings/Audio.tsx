import { Download } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SensitiveInput } from '@/components/common/SensitiveInput';
import { Spinner } from '@/components/common/Spinner';
import {
	SettingField,
	SettingInput,
	SettingRow,
	SettingSelect,
	SettingSwitch,
	SettingTextarea,
	SettingsForm,
	SettingsSection
} from '@/components/settings/controls';
import { getAudioConfig, getModels, getVoices, updateAudioConfig } from '@/lib/apis/audio';
import { useAdminConfigSaved } from '@/lib/settings/useAdminSaved';
import { useConfigDraft } from '@/lib/settings/useConfigDraft';
import { useAuthStore } from '@/lib/stores/authStore';
import { TTS_RESPONSE_SPLIT } from '@/lib/types';
import {
	type Voice,
	buildAudioPayload,
	engineDefaults,
	formatOpenAiParams,
	parseOpenAiParams,
	sortVoices,
	splitMimeTypes,
	splitOptions
} from './audio';

type Rec = Record<string, any>;
type Draft = { tts: Rec; stt: Rec; paramsText: string; mimeText: string };
type Section = 'tts' | 'stt';

const helpClass = 'text-muted-foreground/70 [&_a]:text-foreground mt-1 text-[0.6875rem] [&_a]:hover:underline';
const twoUp = 'grid grid-cols-1 gap-2 sm:grid-cols-2';
const externalLink = { target: '_blank', rel: 'noopener noreferrer' } as const;

const Help = ({ href, children }: { href: string; children: ReactNode }) => (
	<div className={helpClass}>
		<a href={href} {...externalLink}>
			{children}
		</a>
	</div>
);

/** The voices the browser itself offers, for the "Web API" engine; they arrive asynchronously. */
function useBrowserVoices(active: boolean) {
	const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
	useEffect(() => {
		if (!active || typeof speechSynthesis === 'undefined') return;
		const load = () => setVoices([...speechSynthesis.getVoices()].sort((a, b) => a.name.localeCompare(b.name)));
		load();
		speechSynthesis.addEventListener('voiceschanged', load);
		return () => speechSynthesis.removeEventListener('voiceschanged', load);
	}, [active]);
	return voices;
}

/** Ports admin/Settings/Audio.svelte. */
export default function Audio() {
	const token = useAuthStore((s) => s.token) ?? '';
	const saved = useAdminConfigSaved();
	const { draft, setDraft, isLoading } = useConfigDraft<Draft>(['audio'], async () => {
		const res = await getAudioConfig(token);
		if (!res) return null;
		return {
			tts: { ...res.tts, SPLIT_ON: res.tts.SPLIT_ON || TTS_RESPONSE_SPLIT.PUNCTUATION },
			stt: { ...res.stt, OPENAI_API_REQUEST_FORMAT: res.stt.OPENAI_API_REQUEST_FORMAT || 'multipart' },
			paramsText: formatOpenAiParams(res.tts.OPENAI_PARAMS),
			mimeText: (res.stt.SUPPORTED_CONTENT_TYPES ?? []).join(',')
		};
	});
	const [saving, setSaving] = useState(false);
	const [whisperLoading, setWhisperLoading] = useState(false);
	const [providerVoices, setProviderVoices] = useState<Voice[]>([]);
	const [models, setModels] = useState<{ id: string }[]>([]);
	const listRequest = useRef(0);

	const setTts = (p: Rec) => setDraft((d) => d && { ...d, tts: { ...d.tts, ...p } });
	const setStt = (p: Rec) => setDraft((d) => d && { ...d, stt: { ...d.stt, ...p } });

	/** The engine's own voice and model lists, which only the backend can answer (empty for the browser engine). */
	const loadProviderLists = async (engine: string) => {
		const request = ++listRequest.current;
		if (engine === '') {
			setProviderVoices([]);
			setModels([]);
			return;
		}
		const [voices, modelList] = await Promise.all([
			getVoices(token).catch((e) => void toast.error(`${e}`)),
			getModels(token).catch((e) => void toast.error(`${e}`))
		]);
		// A newer engine choice has been made while these were loading.
		if (request !== listRequest.current) return;
		if (voices) setProviderVoices(sortVoices(voices.voices ?? []));
		if (modelList) setModels(modelList.models ?? []);
	};

	const loaded = useRef(false);
	useEffect(() => {
		if (draft && !loaded.current) {
			loaded.current = true;
			void loadProviderLists(draft.tts.ENGINE);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [draft]);

	const browserVoices = useBrowserVoices(draft?.tts.ENGINE === '');

	/** Saves `next`; false (after saying why) when the parameters are not valid JSON or the server refuses. */
	const persist = async (next: Draft) => {
		const params = parseOpenAiParams(next.paramsText);
		if (!params.ok) {
			toast.error('Invalid JSON format for Parameters');
			return false;
		}
		try {
			const res = await updateAudioConfig(token, buildAudioPayload(next.tts, next.stt, params.value, next.mimeText));
			if (!res) return false;
			setDraft((d) => d && { ...d, paramsText: params.text });
			await saved();
			return true;
		} catch (error) {
			toast.error(`${error}`);
			return false;
		}
	};

	const save = async () => {
		if (!draft) return;
		setSaving(true);
		try {
			await persist(draft);
		} finally {
			setSaving(false);
		}
	};

	const updateWhisperModel = async () => {
		if (!draft) return;
		setWhisperLoading(true);
		try {
			await persist(draft);
		} finally {
			setWhisperLoading(false);
		}
	};

	/**
	 * Choosing a TTS engine saves at once: the backend can only list an engine's
	 * voices and models after it has been told to use it. The voice and model then
	 * reset to that engine's conventional pair, which stay unsaved until Save.
	 */
	const changeTtsEngine = async (engine: string) => {
		if (!draft) return;
		const next = { ...draft, tts: { ...draft.tts, ENGINE: engine } };
		setDraft(next);
		await persist(next);
		await loadProviderLists(engine);
		setTts(engineDefaults(engine));
	};

	const tts = draft?.tts;
	const stt = draft?.stt;

	const text = (
		section: Section,
		name: string,
		label: string,
		opts: { placeholder?: string; required?: boolean; list?: string } = {}
	) => {
		const config = section === 'tts' ? tts : stt;
		const set = section === 'tts' ? setTts : setStt;
		const id = `${section}-${name}`;
		return (
			<SettingField label={label} htmlFor={id}>
				<SettingInput
					id={id}
					list={opts.list}
					required={opts.required}
					placeholder={opts.placeholder ?? label}
					value={config?.[name] ?? ''}
					onChange={(e) => set({ [name]: e.target.value })}
				/>
			</SettingField>
		);
	};
	const secret = (section: Section, name: string, required = false) => {
		const config = section === 'tts' ? tts : stt;
		const set = section === 'tts' ? setTts : setStt;
		const id = `${section}-${name}`;
		return (
			<SettingField label="API Key" htmlFor={id}>
				<SensitiveInput
					id={id}
					variant="settings"
					placeholder="API Key"
					required={required}
					value={config?.[name] ?? ''}
					onChange={(v) => set({ [name]: v })}
				/>
			</SettingField>
		);
	};

	return (
		<SettingsForm title="Audio" loading={isLoading} onSubmit={save} saving={saving}>
			{draft && tts && stt && (
				<>
					<SettingsSection title="Speech-to-Text" first>
						<SettingRow
							label="Speech-to-Text Engine"
							description="Choose the transcription provider used for audio input."
						>
							<SettingSelect
								value={stt.ENGINE}
								onChange={(v) => setStt({ ENGINE: v })}
								aria-label="Speech-to-Text Engine"
							>
								<option value="">Whisper (Local)</option>
								<option value="openai">OpenAI</option>
								<option value="web">Web API</option>
								<option value="deepgram">Deepgram</option>
								<option value="azure">Azure AI Speech</option>
								<option value="mistral">MistralAI</option>
							</SettingSelect>
						</SettingRow>

						{stt.ENGINE !== 'web' && (
							<SettingField
								label="Supported MIME Types"
								description="Comma-separated audio or video MIME types accepted for upload."
								htmlFor="stt-mime"
							>
								<SettingInput
									id="stt-mime"
									placeholder="e.g., audio/wav,audio/mpeg,video/* (leave blank for defaults)"
									value={draft.mimeText}
									onChange={(e) => setDraft((d) => d && { ...d, mimeText: e.target.value })}
								/>
							</SettingField>
						)}

						{stt.ENGINE === 'openai' && (
							<>
								<div className={twoUp}>
									{text('stt', 'OPENAI_API_BASE_URL', 'API Base URL', { required: true })}
									{secret('stt', 'OPENAI_API_KEY')}
								</div>
								<SettingRow
									label="Request Format"
									description="Select how audio is sent to the OpenAI-compatible endpoint."
								>
									<SettingSelect
										value={stt.OPENAI_API_REQUEST_FORMAT}
										onChange={(v) => setStt({ OPENAI_API_REQUEST_FORMAT: v })}
										aria-label="Request Format"
									>
										<option value="multipart">Multipart Upload</option>
										<option value="json">JSON Base64</option>
									</SettingSelect>
								</SettingRow>
								{text('stt', 'MODEL', 'STT Model', { list: 'stt-openai-model-list', placeholder: 'Select a model' })}
								<datalist id="stt-openai-model-list">
									<option value="whisper-1" />
								</datalist>
							</>
						)}

						{stt.ENGINE === 'deepgram' && (
							<>
								{secret('stt', 'DEEPGRAM_API_KEY')}
								<SettingField
									label="STT Model"
									description="Leave model field empty to use the default model."
									htmlFor="stt-MODEL"
								>
									<SettingInput
										id="stt-MODEL"
										placeholder="Select a model (optional)"
										value={stt.MODEL ?? ''}
										onChange={(e) => setStt({ MODEL: e.target.value })}
									/>
									<Help href="https://developers.deepgram.com/docs/models">Click here to see available models.</Help>
								</SettingField>
							</>
						)}

						{stt.ENGINE === 'azure' && (
							<>
								{secret('stt', 'AZURE_API_KEY', true)}
								<div className={twoUp}>
									{text('stt', 'AZURE_REGION', 'Azure Region', {
										placeholder: 'e.g., westus (leave blank for eastus)'
									})}
									{text('stt', 'AZURE_LOCALES', 'Language Locales', {
										placeholder: 'e.g., en-US,ja-JP (leave blank for auto-detect)'
									})}
									{text('stt', 'AZURE_BASE_URL', 'Endpoint URL', {
										placeholder: '(leave blank for to use commercial endpoint)'
									})}
									{text('stt', 'AZURE_MAX_SPEAKERS', 'Max Speakers', {
										placeholder: 'e.g., 3, 4, 5 (leave blank for default)'
									})}
								</div>
							</>
						)}

						{stt.ENGINE === 'mistral' && (
							<>
								<div className={twoUp}>
									{text('stt', 'MISTRAL_API_BASE_URL', 'API Base URL', { required: true })}
									{secret('stt', 'MISTRAL_API_KEY')}
								</div>
								<SettingField
									label="STT Model"
									description="Leave empty to use the default model (voxtral-mini-latest)."
									htmlFor="stt-MODEL"
								>
									<SettingInput
										id="stt-MODEL"
										placeholder="voxtral-mini-latest"
										value={stt.MODEL ?? ''}
										onChange={(e) => setStt({ MODEL: e.target.value })}
									/>
									<Help href="https://docs.mistral.ai/capabilities/audio_transcription">
										Learn more about Voxtral transcription.
									</Help>
								</SettingField>
								<SettingRow
									label="Use Chat Completions API"
									description="Use /v1/chat/completions endpoint instead of /v1/audio/transcriptions for potentially better accuracy."
								>
									{(id) => (
										<SettingSwitch
											checked={Boolean(stt.MISTRAL_USE_CHAT_COMPLETIONS)}
											onChange={(v) => setStt({ MISTRAL_USE_CHAT_COMPLETIONS: v })}
											labelledBy={id}
										/>
									)}
								</SettingRow>
							</>
						)}

						{stt.ENGINE === '' && (
							<SettingField
								label="STT Model"
								description="Local LLM uses faster-whisper internally."
								htmlFor="stt-WHISPER_MODEL"
							>
								<div className="flex w-full gap-2">
									<SettingInput
										id="stt-WHISPER_MODEL"
										placeholder="Set whisper model"
										value={stt.WHISPER_MODEL ?? ''}
										onChange={(e) => setStt({ WHISPER_MODEL: e.target.value })}
									/>
									<button
										type="button"
										aria-label="Update model"
										disabled={whisperLoading}
										className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-50"
										onClick={updateWhisperModel}
									>
										{whisperLoading ? <Spinner /> : <Download className="size-4" />}
									</button>
								</div>
								<Help href="https://github.com/SYSTRAN/faster-whisper">
									Click here to learn more about faster-whisper and see the available models.
								</Help>
							</SettingField>
						)}
					</SettingsSection>

					<SettingsSection title="Text-to-Speech">
						<SettingRow
							label="Text-to-Speech Engine"
							description="Choose the speech provider used for assistant audio output."
						>
							<SettingSelect value={tts.ENGINE} onChange={changeTtsEngine} aria-label="Text-to-Speech Engine">
								<option value="">Web API</option>
								<option value="transformers">Transformers (Local)</option>
								<option value="openai">OpenAI</option>
								<option value="elevenlabs">ElevenLabs</option>
								<option value="azure">Azure AI Speech</option>
								<option value="mistral">MistralAI</option>
							</SettingSelect>
						</SettingRow>

						{tts.ENGINE === 'openai' && (
							<div className={twoUp}>
								{text('tts', 'OPENAI_API_BASE_URL', 'API Base URL', { required: true })}
								{secret('tts', 'OPENAI_API_KEY')}
							</div>
						)}
						{tts.ENGINE === 'elevenlabs' && secret('tts', 'API_KEY', true)}
						{tts.ENGINE === 'azure' && (
							<>
								{secret('tts', 'API_KEY', true)}
								<div className={twoUp}>
									{text('tts', 'AZURE_SPEECH_REGION', 'Azure Region', {
										placeholder: 'e.g., westus (leave blank for eastus)'
									})}
									{text('tts', 'AZURE_SPEECH_BASE_URL', 'Endpoint URL', {
										placeholder: '(leave blank for to use commercial endpoint)'
									})}
								</div>
							</>
						)}
						{tts.ENGINE === 'mistral' && (
							<div className={twoUp}>
								{text('tts', 'MISTRAL_API_BASE_URL', 'API Base URL', { required: true })}
								{secret('tts', 'MISTRAL_API_KEY')}
							</div>
						)}

						{tts.ENGINE === '' && (
							<SettingField label="TTS Voice">
								<SettingSelect
									className="w-full"
									value={tts.VOICE}
									onChange={(v) => setTts({ VOICE: v })}
									aria-label="TTS Voice"
								>
									<option value="">Default</option>
									{browserVoices.map((v) => (
										<option key={v.voiceURI} value={v.voiceURI}>
											{v.name}
										</option>
									))}
								</SettingSelect>
							</SettingField>
						)}

						{tts.ENGINE === 'transformers' && (
							<SettingField
								label="TTS Model"
								description="Local LLM uses SpeechT5 and CMU Arctic speaker embeddings."
								htmlFor="tts-MODEL"
							>
								<SettingInput
									id="tts-MODEL"
									list="tts-transformers-model-list"
									placeholder="CMU ARCTIC speaker embedding name"
									value={tts.MODEL ?? ''}
									onChange={(e) => setTts({ MODEL: e.target.value })}
								/>
								<datalist id="tts-transformers-model-list">
									<option value="tts-1" />
								</datalist>
								<div className={helpClass}>
									To learn more about SpeechT5,{' '}
									<a href="https://github.com/microsoft/SpeechT5" {...externalLink}>
										click here.
									</a>{' '}
									To see the available CMU Arctic speaker embeddings,{' '}
									<a href="https://huggingface.co/datasets/Matthijs/cmu-arctic-xvectors" {...externalLink}>
										click here.
									</a>
								</div>
							</SettingField>
						)}

						{['openai', 'elevenlabs', 'mistral', 'azure'].includes(tts.ENGINE) && (
							<div className={twoUp}>
								<SettingField label="TTS Voice" htmlFor="tts-VOICE">
									<SettingInput
										id="tts-VOICE"
										list="tts-voice-list"
										placeholder="Select a voice"
										value={tts.VOICE ?? ''}
										onChange={(e) => setTts({ VOICE: e.target.value })}
									/>
								</SettingField>
								{tts.ENGINE === 'azure' ? (
									<SettingField label="Output format" htmlFor="tts-AZURE_SPEECH_OUTPUT_FORMAT">
										<SettingInput
											id="tts-AZURE_SPEECH_OUTPUT_FORMAT"
											placeholder="Select an output format"
											value={tts.AZURE_SPEECH_OUTPUT_FORMAT ?? ''}
											onChange={(e) => setTts({ AZURE_SPEECH_OUTPUT_FORMAT: e.target.value })}
										/>
										<Help href="https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech?tabs=streaming#audio-outputs">
											Available list
										</Help>
									</SettingField>
								) : (
									text('tts', 'MODEL', 'TTS Model', { list: 'tts-model-list', placeholder: 'Select a model' })
								)}
							</div>
						)}
						{tts.ENGINE === 'openai' && (
							<SettingField
								label="Additional Parameters"
								description="Enter additional OpenAI-compatible TTS request parameters as JSON."
								htmlFor="tts-params"
							>
								<SettingTextarea
									id="tts-params"
									placeholder="Enter additional parameters in JSON format"
									value={draft.paramsText}
									onChange={(e) => setDraft((d) => d && { ...d, paramsText: e.target.value })}
								/>
							</SettingField>
						)}

						<datalist id="tts-voice-list">
							{providerVoices.map((v) => (
								<option key={v.id} value={v.id} label={v.name && v.name !== v.id ? v.name : undefined} />
							))}
						</datalist>
						<datalist id="tts-model-list">
							{models.map((m) => (
								<option key={m.id} value={m.id} />
							))}
						</datalist>

						<SettingRow
							label="Response Splitting"
							description="Control how message text is split for TTS requests. 'Punctuation' splits into sentences, 'paragraphs' splits into paragraphs, and 'none' keeps the message as a single string."
						>
							<SettingSelect
								value={tts.SPLIT_ON}
								onChange={(v) => setTts({ SPLIT_ON: v })}
								aria-label="Select how to split message text for TTS requests"
							>
								{splitOptions.map((s) => (
									<option key={s} value={s}>
										{s.charAt(0).toUpperCase() + s.slice(1)}
									</option>
								))}
							</SettingSelect>
						</SettingRow>
					</SettingsSection>
				</>
			)}
		</SettingsForm>
	);
}
