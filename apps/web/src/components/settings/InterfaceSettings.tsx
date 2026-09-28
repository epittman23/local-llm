import { Minus, Plus } from 'lucide-react';
import { Fragment, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SettingRow, SettingSwitch, SettingsSection, settingInputClass } from '@/components/settings/controls';
import { updateUserInfo } from '@/lib/apis/users';
import { useAuthStore } from '@/lib/stores/authStore';
import { getUserPosition } from '@/lib/utils/api-helpers';
import { cn } from '@/lib/utils';
import { normalizeAppFontFamily, setAppFontFamily, setTextScale } from '@/lib/utils/textScale';
import { type CompressionSize, FloatingActionsDialog, ImageCompressionDialog } from './InterfaceManageDialogs';
import {
	BACKGROUND_IMAGE_TYPES,
	type CycleDef,
	type FloatingAction,
	type InterfaceValues,
	ROWS,
	type Section,
	type SettingsContext,
	type SwitchDef,
	cycleState,
	isInherited,
	isShown,
	readSetting,
	settingPatch,
	stepTextScale
} from './interfaceSettingDefs';

const action = 'text-muted-foreground hover:text-foreground text-xs transition-colors';

/**
 * Ports common/InterfaceSettings.svelte: every interface preference, grouped
 * UI / Chat / Input / Artifacts / Voice / File. Controlled: it shows `values`
 * and reports each change as a patch through `onChange`; the caller decides
 * what saving means. The rows are the table in interfaceSettingDefs.ts.
 *
 * `mode="defaults"` is the admin General tab editing DEFAULT_INTERFACE_SETTINGS:
 * nothing is applied to the page or checked against the browser. `mode="personal"`
 * (Phase 10) applies the UI scale and font as they change, asks for the
 * location and clipboard before turning those on, and marks a setting that is
 * only showing the admin default (`defaults`, not in `personal`) as inherited.
 *
 * The Svelte component's hidden "default model" and its exported `save()`
 * (used by nothing in this surface) are not ported.
 */
export function InterfaceSettings({
	values,
	onChange,
	mode,
	defaults = {},
	personal = {},
	isAdmin = false,
	canTemporaryChat = false,
	autocompleteEnabled = false
}: {
	values: InterfaceValues;
	onChange: (patch: InterfaceValues) => void;
	mode: 'defaults' | 'personal';
	defaults?: InterfaceValues;
	personal?: InterfaceValues;
	isAdmin?: boolean;
	canTemporaryChat?: boolean;
	autocompleteEnabled?: boolean;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const fileInput = useRef<HTMLInputElement>(null);
	const [scaleOpen, setScaleOpen] = useState(false);
	const [fontOpen, setFontOpen] = useState(false);
	const [showActions, setShowActions] = useState(false);
	const [showCompression, setShowCompression] = useState(false);
	const personalMode = mode === 'personal';
	const inherited = (key: string) => isInherited(mode, defaults, personal, key);
	const ctx: SettingsContext = { isAdmin, canTemporaryChat, autocompleteEnabled, values };
	const set = (key: string, value: unknown) => onChange(settingPatch(values, key, value));

	const toggle = async (def: SwitchDef, on: boolean) => {
		if (personalMode && on && def.special === 'userLocation') {
			const position = await getUserPosition().catch((error) => {
				toast.error(error?.message ?? `${error}`);
				return null;
			});
			if (!position) return set(def.key, false);
			await updateUserInfo(token, { location: position });
			toast.success('User location successfully retrieved.');
		}
		if (personalMode && on && def.special === 'responseAutoCopy') {
			const granted = await navigator.clipboard.readText().then(
				() => true,
				() => false
			);
			if (!granted) {
				toast.error('Clipboard write permission denied. Please check your browser settings to grant the necessary access.');
				return set(def.key, false);
			}
		}
		set(def.key, on);
	};

	// UI scale and font: "Default" until someone opens the control; in personal
	// mode an inherited admin value also reads as Default.
	const textScale = readSetting<number | null>(values, 'textScale', null);
	const scaleIsDefault = textScale === null || (inherited('textScale') && !scaleOpen);
	const defaultScale = readSetting<number>(defaults, 'textScale', 1);
	const applyScale = (scale: number) => personalMode && setTextScale(scale);
	const setScale = (scale: number) => {
		applyScale(scale);
		set('textScale', scale);
	};

	const fontFamily = normalizeAppFontFamily(readSetting(values, 'fontFamily', '')) || null;
	const fontIsDefault = !fontOpen && (fontFamily === null || inherited('fontFamily'));
	const defaultFont = normalizeAppFontFamily(defaults.fontFamily) || null;
	const [fontInput, setFontInput] = useState<string | null>(null);
	const applyFont = (font: string | null) => personalMode && setAppFontFamily(font || defaultFont);

	const backgroundImageUrl = readSetting<string | null>(values, 'backgroundImageUrl', null);
	const pickBackground = (file: File | undefined) => {
		if (!file || !BACKGROUND_IMAGE_TYPES.includes(file.type)) {
			if (file) toast.error(`Unsupported File Type '${file.type}'.`);
			return;
		}
		const reader = new FileReader();
		reader.onload = () => set('backgroundImageUrl', `${reader.result}`);
		reader.readAsDataURL(file);
	};

	const renderSwitch = (def: SwitchDef) => {
		const on = readSetting<boolean>(values, def.key, def.fallback);
		const manage =
			(def.special === 'floatingActions' && on && (() => setShowActions(true))) || (def.special === 'imageCompression' && on && (() => setShowCompression(true))) || null;
		return (
			<SettingRow key={def.key} label={def.label} description={def.description}>
				{(id) => (
					<div className="flex items-center gap-1.5">
						{manage && (
							<button type="button" className={action} aria-label={def.special === 'floatingActions' ? 'Manage Floating Quick Actions' : 'Manage Image Compression'} onClick={manage}>
								Manage
							</button>
						)}
						<span className={cn(inherited(def.key) && 'opacity-60')} title={inherited(def.key) ? 'Inherited from the admin default' : undefined}>
							<SettingSwitch checked={on} labelledBy={id} onChange={(v) => toggle(def, v)} />
						</span>
					</div>
				)}
			</SettingRow>
		);
	};

	const renderCycle = (def: CycleDef) => {
		const { option, next } = cycleState(def, values);
		return (
			<SettingRow key={def.key} label={def.label} description={def.description}>
				{(id) => (
					<button type="button" className={action} aria-labelledby={id} aria-description={option.label} onClick={() => set(def.key, next)}>
						{option.label}
					</button>
				)}
			</SettingRow>
		);
	};

	const renderCustom = (id: 'textScale' | 'fontFamily' | 'backgroundImage') => {
		if (id === 'textScale') {
			return (
				<div key={id}>
					<SettingRow label="UI Scale" description="Set a local zoom level for the app interface.">
						<button
							type="button"
							className={action}
							aria-label={`UI Scale: ${scaleIsDefault ? 'Default' : `${textScale}x`}`}
							onClick={() => {
								if (scaleIsDefault) {
									if (textScale === null) set('textScale', defaultScale);
									setScaleOpen(true);
								} else {
									setScaleOpen(false);
									applyScale(defaultScale);
									set('textScale', null);
								}
							}}
						>
							{scaleIsDefault ? 'Default' : `${textScale}x`}
						</button>
					</SettingRow>
					{!scaleIsDefault && textScale !== null && (
						<div className="flex items-center gap-2 px-1 pt-1.5">
							<button type="button" className="hover:bg-muted rounded-lg p-1" aria-label="Decrease UI Scale" onClick={() => setScale(stepTextScale(textScale, -0.1))}>
								<Minus className="size-3.5" />
							</button>
							<input
								className="flex-1"
								type="range"
								min={1}
								max={1.5}
								step={0.01}
								aria-label="UI Scale"
								value={textScale}
								onChange={(e) => {
									applyScale(Number(e.target.value));
									set('textScale', Number(e.target.value));
								}}
							/>
							<button type="button" className="hover:bg-muted rounded-lg p-1" aria-label="Increase UI Scale" onClick={() => setScale(stepTextScale(textScale, 0.1))}>
								<Plus className="size-3.5" />
							</button>
						</div>
					)}
				</div>
			);
		}
		if (id === 'fontFamily') {
			return (
				<div key={id}>
					<SettingRow label="Font Family" description="Use a local font family for the app interface.">
						<button
							type="button"
							className={action}
							aria-label={`Font Family: ${fontIsDefault ? 'Default' : 'Custom'}`}
							onClick={() => {
								if (fontIsDefault) {
									const start = fontFamily ?? defaultFont;
									setFontInput(start ?? '');
									setFontOpen(true);
									applyFont(start);
								} else {
									setFontOpen(false);
									setFontInput(null);
									applyFont(null);
									set('fontFamily', null);
								}
							}}
						>
							{fontIsDefault ? 'Default' : 'Custom'}
						</button>
					</SettingRow>
					{!fontIsDefault && (
						<input
							className={cn(settingInputClass, 'mt-1.5')}
							type="text"
							aria-label="Font Family name"
							placeholder="Aptos"
							value={fontInput ?? fontFamily ?? ''}
							onChange={(e) => {
								setFontInput(e.target.value);
								applyFont(normalizeAppFontFamily(e.target.value) || null);
							}}
							onBlur={(e) => set('fontFamily', normalizeAppFontFamily(e.target.value) || null)}
						/>
					)}
				</div>
			);
		}
		return (
			<SettingRow key={id} label="Chat Background Image" description="Upload or reset the image shown behind chat content.">
				<button type="button" className={action} aria-label={backgroundImageUrl ? 'Reset Chat Background Image' : 'Upload Chat Background Image'} onClick={() => (backgroundImageUrl ? set('backgroundImageUrl', null) : fileInput.current?.click())}>
					{backgroundImageUrl ? 'Reset' : 'Upload'}
				</button>
			</SettingRow>
		);
	};

	return (
		<>
			<FloatingActionsDialog
				open={showActions}
				onOpenChange={setShowActions}
				value={readSetting<FloatingAction[] | null>(values, 'floatingActionButtons', null)}
				onSave={(floatingActionButtons) => onChange({ floatingActionButtons })}
			/>
			<ImageCompressionDialog
				open={showCompression}
				onOpenChange={setShowCompression}
				value={readSetting<CompressionSize>(values, 'imageCompressionSize', { width: '', height: '' })}
				onSave={(imageCompressionSize) => onChange({ imageCompressionSize })}
			/>
			<input
				ref={fileInput}
				type="file"
				hidden
				accept="image/*"
				aria-label="Chat background image file"
				onChange={(e) => {
					pickBackground(e.target.files?.[0]);
					e.target.value = '';
				}}
			/>
			{(Object.keys(ROWS) as Section[])
				// A section whose rows are all for unported features is left out.
				.filter((section) => ROWS[section].some((row) => isShown(row, ctx)))
				.map((section, i) => (
					<SettingsSection key={section} title={section} first={i === 0}>
						{ROWS[section]
							.filter((row) => isShown(row, ctx))
							.map((row) => (
								<Fragment key={row.kind === 'custom' ? row.id : row.key}>{row.kind === 'custom' ? renderCustom(row.id) : row.kind === 'cycle' ? renderCycle(row) : renderSwitch(row)}</Fragment>
							))}
					</SettingsSection>
				))}
		</>
	);
}
