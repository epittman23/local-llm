import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { synthesizeOpenAISpeech } from '@/lib/apis/audio';
import { removeAllDetails } from '@/lib/markdown/content';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';

type TtsConfig = { engine?: string; voice?: string; model?: string; split_on?: string };

/** Sentences (or paragraphs, per the server's `split_on`), Markdown stripped, for speaking one at a time. */
export function speechParts(text: string, splitOn = 'punctuation'): string[] {
	const plain = removeAllDetails(text)
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/[*_#>`~|]/g, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
	const parts = splitOn === 'paragraphs' ? plain.split(/\n{2,}/) : plain.split(/(?<=[.!?。！？])\s+|\n+/);
	return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Ports ResponseMessage.svelte's Read Aloud: the browser's own voices when
 * the server has no TTS engine, else the server's speech endpoint sentence by
 * sentence, at the user's playback rate. Not ported: the in-browser Kokoro
 * engine.
 */
export function useReadAloud() {
	const token = useAuthStore((s) => s.token) ?? '';
	// Select the stored object itself (a fresh `?? {}` here would change every render and loop).
	const ttsConfig = useConfigStore((s) => (s.config as { audio?: { tts?: TtsConfig } } | null)?.audio?.tts);
	const tts: TtsConfig = ttsConfig ?? {};
	const { settings } = useUserSettings();
	const audioSettings = ((settings as Record<string, any> | null)?.audio?.tts ?? {}) as { voice?: string; playbackRate?: number; defaultVoice?: string };
	const [speakingId, setSpeakingId] = useState<string | null>(null);
	const stopRef = useRef<() => void>(() => {});

	const stop = useCallback(() => {
		stopRef.current();
		stopRef.current = () => {};
		setSpeakingId(null);
	}, []);
	useEffect(() => stop, [stop]);

	const voice = audioSettings.defaultVoice === tts.voice ? (audioSettings.voice ?? tts.voice) : tts.voice;
	const rate = audioSettings.playbackRate ?? 1;

	const speak = useCallback(
		async (id: string, text: string) => {
			stop();
			const parts = speechParts(text, tts.split_on);
			if (!parts.length) {
				toast.info('No content to speak');
				return;
			}
			setSpeakingId(id);
			if (!tts.engine) {
				const u = new SpeechSynthesisUtterance(parts.join(' '));
				u.rate = rate;
				const match = speechSynthesis.getVoices().find((v) => v.voiceURI === voice || v.name === voice);
				if (match) u.voice = match;
				u.onend = () => setSpeakingId((cur) => (cur === id ? null : cur));
				stopRef.current = () => speechSynthesis.cancel();
				speechSynthesis.speak(u);
				return;
			}
			let stopped = false;
			let audio: HTMLAudioElement | null = null;
			stopRef.current = () => {
				stopped = true;
				audio?.pause();
			};
			for (const part of parts) {
				if (stopped) return;
				const res = await synthesizeOpenAISpeech(token, voice ?? 'alloy', part, tts.model).catch((e) => {
					toast.error(`${e}`);
					return null;
				});
				if (!res || stopped) break;
				const url = URL.createObjectURL(await res.blob());
				audio = new Audio(url);
				audio.playbackRate = rate;
				await new Promise<void>((resolve) => {
					audio!.onended = () => resolve();
					audio!.onerror = () => resolve();
					audio!.play().catch(() => resolve());
				});
				URL.revokeObjectURL(url);
			}
			if (!stopped) setSpeakingId((cur) => (cur === id ? null : cur));
		},
		[stop, token, tts.engine, tts.model, tts.split_on, voice, rate]
	);

	return { speakingId, speak, stop };
}
