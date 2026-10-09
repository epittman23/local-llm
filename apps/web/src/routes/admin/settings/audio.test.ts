import { describe, expect, it } from 'vitest';
import {
	buildAudioPayload,
	engineDefaults,
	formatOpenAiParams,
	parseOpenAiParams,
	sortVoices,
	splitMimeTypes
} from './audio';

describe('parseOpenAiParams', () => {
	it('treats blank as no parameters', () => {
		expect(parseOpenAiParams('')).toEqual({ ok: true, value: {}, text: '' });
		expect(parseOpenAiParams('  \n')).toEqual({ ok: true, value: {}, text: '' });
	});
	it('accepts a JSON object and returns it pretty-printed', () => {
		expect(parseOpenAiParams('{"speed":1.2}')).toEqual({
			ok: true,
			value: { speed: 1.2 },
			text: '{\n  "speed": 1.2\n}'
		});
	});
	it('refuses malformed JSON and anything that is not an object', () => {
		for (const bad of ['{speed:', '[1,2]', '"x"', '3', 'null']) expect(parseOpenAiParams(bad)).toEqual({ ok: false });
	});
});

describe('formatOpenAiParams', () => {
	it('shows nothing for missing or empty params, else pretty JSON', () => {
		expect(formatOpenAiParams(undefined)).toBe('');
		expect(formatOpenAiParams(null)).toBe('');
		expect(formatOpenAiParams({})).toBe('');
		expect(formatOpenAiParams({ a: 1 })).toBe('{\n  "a": 1\n}');
	});
});

describe('splitMimeTypes', () => {
	it('trims and drops empty entries, so a blank box is an empty list', () => {
		expect(splitMimeTypes('')).toEqual([]);
		expect(splitMimeTypes(' audio/wav, ,video/* ,')).toEqual(['audio/wav', 'video/*']);
	});
});

describe('engineDefaults', () => {
	it('picks the conventional voice and model per engine', () => {
		expect(engineDefaults('openai')).toEqual({ VOICE: 'alloy', MODEL: 'tts-1' });
		expect(engineDefaults('mistral')).toEqual({ VOICE: '', MODEL: 'voxtral-mini-tts-2603' });
		expect(engineDefaults('elevenlabs')).toEqual({ VOICE: '', MODEL: '' });
		expect(engineDefaults('')).toEqual({ VOICE: '', MODEL: '' });
	});
});

describe('sortVoices', () => {
	it('orders by name, falling back to id, without mutating the input', () => {
		const input = [{ id: 'b' }, { id: 'z', name: 'Alpha' }, { id: 'c', name: 'Charlie' }];
		expect(sortVoices(input).map((v) => v.id)).toEqual(['z', 'b', 'c']);
		expect(input[0].id).toBe('b');
	});
});

describe('buildAudioPayload', () => {
	const tts = {
		ENGINE: 'openai',
		MODEL: 'tts-1',
		VOICE: 'alloy',
		SPLIT_ON: '',
		OPENAI_API_KEY: 'k',
		EXTRA_UNKNOWN: 'x'
	};
	const stt = {
		ENGINE: '',
		WHISPER_MODEL: 'base',
		OPENAI_API_REQUEST_FORMAT: '',
		ALLOWED_EXTENSIONS: ['wav'],
		EXTRA_UNKNOWN: 'x'
	};

	it('sends only the edited keys, with defaults for a blank split and request format', () => {
		const p = buildAudioPayload(tts, stt, { speed: 1 }, 'audio/wav, video/*');
		expect(p.tts).toMatchObject({
			ENGINE: 'openai',
			MODEL: 'tts-1',
			OPENAI_PARAMS: { speed: 1 },
			SPLIT_ON: 'punctuation'
		});
		expect(p.stt).toMatchObject({
			WHISPER_MODEL: 'base',
			OPENAI_API_REQUEST_FORMAT: 'multipart',
			SUPPORTED_CONTENT_TYPES: ['audio/wav', 'video/*']
		});
		expect(p.tts).not.toHaveProperty('EXTRA_UNKNOWN');
		expect(p.stt).not.toHaveProperty('EXTRA_UNKNOWN');
	});
	it('passes ALLOWED_EXTENSIONS back untouched, and omits it when the server never sent it', () => {
		expect(buildAudioPayload(tts, stt, {}, '').stt).toMatchObject({ ALLOWED_EXTENSIONS: ['wav'] });
		expect(buildAudioPayload(tts, { ENGINE: '' }, {}, '').stt).not.toHaveProperty('ALLOWED_EXTENSIONS');
	});
});
