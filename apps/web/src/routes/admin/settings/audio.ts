import { TTS_RESPONSE_SPLIT } from '@/lib/types';

type Rec = Record<string, any>;

export type OpenAiParams = { ok: true; value: Rec; text: string } | { ok: false };

/**
 * The "Additional Parameters" box: blank means none, otherwise it must be a JSON
 * *object* (the backend stores a dict, so an array or a bare string would only
 * fail later). `text` is the same value pretty-printed, to put back in the box.
 */
export function parseOpenAiParams(text: string): OpenAiParams {
	if (!text.trim()) return { ok: true, value: {}, text: '' };
	try {
		const value = JSON.parse(text);
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
		return { ok: true, value, text: JSON.stringify(value, null, 2) };
	} catch {
		return { ok: false };
	}
}

export const formatOpenAiParams = (params: unknown): string =>
	params && typeof params === 'object' && Object.keys(params).length > 0 ? JSON.stringify(params, null, 2) : '';

export const splitMimeTypes = (text: string): string[] =>
	text
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean);

/** The voice and model that make sense for a freshly chosen TTS engine. */
export function engineDefaults(engine: string): { VOICE: string; MODEL: string } {
	if (engine === 'openai') return { VOICE: 'alloy', MODEL: 'tts-1' };
	if (engine === 'mistral') return { VOICE: '', MODEL: 'voxtral-mini-tts-2603' };
	return { VOICE: '', MODEL: '' };
}

export type Voice = { id: string; name?: string };

export const sortVoices = (voices: Voice[]): Voice[] =>
	[...voices].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));

export const splitOptions = Object.values(TTS_RESPONSE_SPLIT) as string[];

const TTS_KEYS = [
	'OPENAI_API_BASE_URL',
	'OPENAI_API_KEY',
	'API_KEY',
	'ENGINE',
	'MODEL',
	'VOICE',
	'AZURE_SPEECH_REGION',
	'AZURE_SPEECH_BASE_URL',
	'AZURE_SPEECH_OUTPUT_FORMAT',
	'MISTRAL_API_KEY',
	'MISTRAL_API_BASE_URL'
] as const;

const STT_KEYS = [
	'OPENAI_API_BASE_URL',
	'OPENAI_API_KEY',
	'OPENAI_API_REQUEST_FORMAT',
	'ENGINE',
	'MODEL',
	'WHISPER_MODEL',
	'DEEPGRAM_API_KEY',
	'AZURE_API_KEY',
	'AZURE_REGION',
	'AZURE_LOCALES',
	'AZURE_BASE_URL',
	'AZURE_MAX_SPEAKERS',
	'MISTRAL_API_KEY',
	'MISTRAL_API_BASE_URL',
	'MISTRAL_USE_CHAT_COMPLETIONS'
] as const;

const pick = (source: Rec, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, source[k]]));

/**
 * The body of `POST /audio/config/update`. The backend overwrites every key of
 * the form, defaulting any it is not sent, so `ALLOWED_EXTENSIONS` (which this
 * tab does not edit) is passed back as it arrived; leaving it out would empty it.
 */
export function buildAudioPayload(tts: Rec, stt: Rec, openaiParams: Rec, mimeText: string) {
	return {
		tts: {
			...pick(tts, TTS_KEYS),
			OPENAI_PARAMS: openaiParams,
			SPLIT_ON: tts.SPLIT_ON || TTS_RESPONSE_SPLIT.PUNCTUATION
		},
		stt: {
			...pick(stt, STT_KEYS),
			OPENAI_API_REQUEST_FORMAT: stt.OPENAI_API_REQUEST_FORMAT || 'multipart',
			SUPPORTED_CONTENT_TYPES: splitMimeTypes(mimeText),
			...(stt.ALLOWED_EXTENSIONS !== undefined && { ALLOWED_EXTENSIONS: stt.ALLOWED_EXTENSIONS })
		}
	};
}
