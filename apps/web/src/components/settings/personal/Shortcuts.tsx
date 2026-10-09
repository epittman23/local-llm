import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { updateUserSettings } from '@/lib/apis/users';
import {
	DEFAULT_KEYBINDINGS,
	type KeybindingsMap,
	Shortcut,
	type ShortcutDefinition,
	eventToChord,
	formatChord,
	isConfigurableShortcut,
	shortcuts
} from '@/lib/shortcuts';
import { useUserSettings } from '@/lib/settings/userSettings';
import { useAuthStore } from '@/lib/stores/authStore';
import { KEYBINDINGS_KEY, SUPPORTED_SHORTCUTS, useKeybindings } from '@/lib/useShortcuts';
import { cn } from '@/lib/utils';
import { SettingRow, SettingSwitch, SettingsForm, SettingsSection } from '../controls';

/** A fixed shortcut's keys as the Svelte list shows them ('mod' is Ctrl, or ⌘ on a Mac). */
const fixedChord = (keys: string[]) =>
	formatChord(keys.map((k) => (k === 'mod' ? 'Cmd' : k === 'shift' ? 'Shift' : k === 'alt' ? 'Alt' : k)).join('+'));

/**
 * Ports Settings/Shortcuts.svelte: keyboard shortcuts on or off, and every
 * shortcut by category; a configurable one can be rebound by clicking it and
 * pressing the new keys (Escape cancels, Backspace clears), with a warning
 * when the keys are already taken. Lists only the shortcuts this app acts on.
 */
export default function Shortcuts() {
	const token = useAuthStore((s) => s.token) ?? '';
	const queryClient = useQueryClient();
	const { settings, update } = useUserSettings();
	const bindings = useKeybindings();
	const [recording, setRecording] = useState<Shortcut | null>(null);
	const enabled = (settings as { keyboardShortcuts?: boolean } | null)?.keyboardShortcuts ?? true;

	const save = async (next: KeybindingsMap) => {
		queryClient.setQueryData(KEYBINDINGS_KEY, next);
		await updateUserSettings(token, { keybindings: next }).catch((e) => toast.error(`${e}`));
	};

	const byCategory = Object.entries(shortcuts)
		.filter(
			([id, def]) =>
				SUPPORTED_SHORTCUTS.has(id as Shortcut) &&
				(!def!.setting || (settings as Record<string, unknown> | null)?.[def!.setting.id] === def!.setting.value)
		)
		.reduce<Record<string, [Shortcut, ShortcutDefinition][]>>((acc, [id, def]) => {
			(acc[def!.category] ??= []).push([id as Shortcut, def!]);
			return acc;
		}, {});

	const conflictOf = (id: Shortcut, chord: string) =>
		(Object.entries(bindings) as [Shortcut, string][]).find(([other, c]) => other !== id && c === chord)?.[0] ?? null;

	return (
		<SettingsForm title="Keyboard" footer={false}>
			<SettingsSection first>
				<SettingRow label="Keyboard Shortcuts" description="Use keyboard shortcuts across the app.">
					{(id) => (
						<SettingSwitch labelledBy={id} checked={enabled} onChange={(v) => void update({ keyboardShortcuts: v })} />
					)}
				</SettingRow>
			</SettingsSection>
			{Object.entries(byCategory).map(([category, list]) => (
				<SettingsSection key={category} title={category}>
					{list.map(([id, def]) => {
						const configurable = isConfigurableShortcut(id);
						const chord = configurable ? bindings[id] : '';
						const conflict = configurable && chord ? conflictOf(id, chord) : null;
						return (
							<div key={id} className="flex items-center justify-between gap-3 text-xs">
								<span className="text-muted-foreground whitespace-pre-line" title={def.tooltip}>
									{def.name}
								</span>
								{configurable ? (
									<button
										type="button"
										aria-label={`Change shortcut for ${def.name}`}
										className={cn(
											'bg-muted/50 min-w-16 rounded-md border px-2 py-0.5 font-mono',
											recording === id && 'border-blue-500',
											conflict && 'border-destructive text-destructive'
										)}
										title={conflict ? `Also bound to ${shortcuts[conflict]?.name}` : undefined}
										onClick={() => setRecording(id)}
										onBlur={() => setRecording((r) => (r === id ? null : r))}
										onKeyDown={(e) => {
											if (recording !== id) return;
											e.preventDefault();
											e.stopPropagation();
											if (e.key === 'Escape') return setRecording(null);
											if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
												setRecording(null);
												return void save({ ...bindings, [id]: '' });
											}
											const next = eventToChord(e.nativeEvent);
											if (!next) return;
											setRecording(null);
											void save({ ...bindings, [id]: next });
										}}
									>
										{recording === id ? 'Press keys...' : chord ? formatChord(chord) : 'Not set'}
									</button>
								) : (
									<span className="bg-muted/30 rounded-md px-2 py-0.5 font-mono">{fixedChord(def.keys)}</span>
								)}
							</div>
						);
					})}
				</SettingsSection>
			))}
			<div className="mt-4">
				<Button type="button" size="sm" variant="outline" onClick={() => void save({ ...DEFAULT_KEYBINDINGS })}>
					Reset to defaults
				</Button>
			</div>
		</SettingsForm>
	);
}
