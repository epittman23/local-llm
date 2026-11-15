import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { getVoices } from '@/lib/apis/audio';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import {
	SavedNote,
	SettingField,
	SettingInput,
	SettingRow,
	SettingSelect,
	SettingSwitch,
	SettingsForm,
	SettingsSection,
	useSavedFlash
} from '../controls';

type Voice = { id?: string; name: string; localService?: boolean };

/** The browser's voices, which arrive asynchronously. */
function useBrowserVoices(enabled: boolean): Voice[] {
	const [voices, setVoices] = useState<Voice[]>([]);
	useEffect(() => {
		if (!enabled || typeof speechSynthesis === 'undefined') return;
		const load = () =>
			setVoices(speechSynthesis.getVoices().map((v) => ({ name: v.name, localService: v.localService })));
		load();
		speechSynthesis.addEventListener('voiceschanged', load);
		return () => speechSynthesis.removeEventListener('voiceschanged', load);
	}, [enabled]);
	return voices;
}

/**
 * Ports Settings/Audio.svelte: the speech-to-text engine and language and
 * whether a transcription sends itself; the text-to-speech auto-playback
 * (saved at once), playback speed and voice -- a browser voice when the
 * server has no TTS engine, else one of the server's voices. Not ported:
 * the in-browser Kokoro.js engine.
 */
export default function Audio() {
	const token = useAuthStore((s) => s.token) ?? '';
	const tts = useConfigStore(
		(s) => (s.config as { audio?: { tts?: { engine?: string; voice?: string } } } | null)?.audio?.tts
	);
	const serverEngine = tts?.engine ?? '';
	const { settings, update } = useUserSettings();
	const browserVoices = useBrowserVoices(serverEngine === '');
	const serverVoices = useQuery({
		queryKey: ['tts-voices'],
		enabled: serverEngine !== '',
		queryFn: async () => ((await getVoices(token).catch(() => null))?.voices ?? []) as Voice[]
	});
	const s = (settings ?? {}) as Record<string, any>;
	/** The form's values as saved (what Discard changes goes back to). */
	const savedForm = useCallback(() => {
		const a = (
			(settings ?? {}) as {
				audio?: {
					stt?: { engine?: string; language?: string };
					tts?: { playbackRate?: number; voice?: string; defaultVoice?: string; nonLocalVoices?: boolean };
				};
			}
		).audio;
		return {
			stt: { engine: a?.stt?.engine ?? '', language: a?.stt?.language ?? '' },
			rate: a?.tts?.playbackRate ?? 1,
			voice: a?.tts?.defaultVoice === tts?.voice ? (a?.tts?.voice ?? tts?.voice ?? '') : (tts?.voice ?? ''),
			nonLocal: a?.tts?.nonLocalVoices ?? false
		};
	}, [settings, tts?.voice]);
	const [stt, setStt] = useState({ engine: '', language: '' });
	const [rate, setRate] = useState(1);
	const [voice, setVoice] = useState('');
	const [nonLocal, setNonLocal] = useState(false);
	const [saving, setSaving] = useState(false);
	const { isSaved, flash } = useSavedFlash();

	const reset = useCallback(() => {
		if (!settings) return;
		const saved = savedForm();
		setStt(saved.stt);
		setRate(saved.rate);
		setVoice(saved.voice);
		setNonLocal(saved.nonLocal);
	}, [settings, savedForm]);
	useEffect(reset, [reset]);
	const dirty = Boolean(settings) && JSON.stringify({ stt, rate, voice, nonLocal }) !== JSON.stringify(savedForm());

	return (
		<SettingsForm
			title="Audio"
			loading={!settings}
			saving={saving}
			dirty={dirty}
			onDiscard={reset}
			onSubmit={async () => {
				setSaving(true);
				await update({
					audio: {
						...(s.audio ?? {}),
						stt: { engine: stt.engine || undefined, language: stt.language || undefined },
						tts: {
							...(s.audio?.tts ?? {}),
							playbackRate: rate,
							voice: voice || undefined,
							defaultVoice: tts?.voice ?? '',
							nonLocalVoices: serverEngine === '' ? nonLocal : undefined
						}
					}
				}).then(
					() => toast.success('Settings saved'),
					(e) => toast.error(`${e}`)
				);
				setSaving(false);
			}}
		>
			{/* Voice input is not ported (docs/decisions.md), so its engine and auto-send switches are not
			    offered (docs/history/code-review.md M7); the language is, since audio uploads use it. */}
			<SettingsSection title="Speech to text" first>
				<SettingField label="Language" htmlFor="stt-language">
					<SettingInput
						id="stt-language"
						aria-label="Speech-to-Text Language"
						placeholder="e.g. en"
						value={stt.language}
						onChange={(e) => setStt({ ...stt, language: e.target.value })}
					/>
				</SettingField>
			</SettingsSection>
			<SettingsSection title="Read aloud">
				<SettingRow
					label="Auto-Playback Response"
					description="Play assistant responses aloud automatically. Saved as soon as you switch it."
				>
					{(id) => (
						<span className="flex items-center gap-3">
							{isSaved('responseAutoPlayback') && <SavedNote />}
							<SettingSwitch
								labelledBy={id}
								checked={Boolean(s.responseAutoPlayback)}
								onChange={(v) =>
									void update({ responseAutoPlayback: v }).then(
										() => flash(['responseAutoPlayback']),
										(e) => toast.error(`${e?.message ?? e}`)
									)
								}
							/>
						</span>
					)}
				</SettingRow>
				<SettingRow label="Speech Playback Speed" description="Adjust how quickly spoken responses are played.">
					{(id) => (
						<SettingSelect aria-labelledby={id} value={String(rate)} onChange={(v) => setRate(Number(v))}>
							{[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
								<option key={r} value={String(r)}>
									{r}x
								</option>
							))}
						</SettingSelect>
					)}
				</SettingRow>
			</SettingsSection>
			<SettingsSection title="Voice">
				{serverEngine === '' ? (
					<>
						<SettingField label="Set Voice" description="Choose the browser voice used for speech output.">
							<SettingSelect aria-label="Voice" className="w-full" value={voice} onChange={setVoice}>
								<option value="">Default</option>
								{browserVoices
									.filter((v) => nonLocal || v.localService === true)
									.map((v) => (
										<option key={v.name} value={v.name}>
											{v.name}
										</option>
									))}
							</SettingSelect>
						</SettingField>
						<SettingRow
							label="Allow non-local voices"
							description="Include voices that are not provided by a local speech service."
						>
							{(id) => <SettingSwitch labelledBy={id} checked={nonLocal} onChange={setNonLocal} />}
						</SettingRow>
					</>
				) : (
					<SettingField label="Set Voice" description="Choose the configured text-to-speech service voice.">
						<SettingInput
							list="voice-list"
							aria-label="Voice"
							placeholder="Select a voice"
							value={voice}
							onChange={(e) => setVoice(e.target.value)}
						/>
						<datalist id="voice-list">
							{(serverVoices.data ?? []).map((v) => (
								<option key={v.id ?? v.name} value={v.id ?? v.name}>
									{v.name}
								</option>
							))}
						</datalist>
					</SettingField>
				)}
			</SettingsSection>
		</SettingsForm>
	);
}
