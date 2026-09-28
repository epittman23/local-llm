// The rules behind common/InterfaceSettings.svelte. That component is ~1,900
// lines, almost all of it the same on/off row repeated ~45 times; here each
// switch is one entry in SWITCHES and the component renders the table. The
// handful of settings that are not plain switches (cycling buttons, the UI
// scale, the font, the background image, the two "Manage" dialogs) are written
// out in the component.
//
// Used twice: the admin General tab edits DEFAULT_INTERFACE_SETTINGS with it
// (mode 'defaults'), and Phase 10's personal Interface tab edits the user's own
// settings (mode 'personal'), where an admin default the user has not
// overridden shows as "inherited".

export type InterfaceValues = Record<string, any>;

export type SettingsContext = {
	isAdmin: boolean;
	canTemporaryChat: boolean;
	autocompleteEnabled: boolean;
	values: InterfaceValues;
};

export type SwitchDef = {
	/** Dotted path into the settings object (only `title.auto` is nested). */
	key: string;
	label: string;
	description: string;
	fallback: boolean;
	/** Omitted = always shown. */
	visible?: (ctx: SettingsContext) => boolean;
	/** Rendered by the component because turning it on has a side effect (personal mode) or it has a Manage button. */
	special?: 'userLocation' | 'responseAutoCopy' | 'floatingActions' | 'imageCompression';
	/** Why the row is not offered: the feature it configures is not in this app yet. */
	unported?: string;
};

/** A setting shown as a button that cycles through its options. */
export type CycleDef = {
	kind: 'cycle';
	key: string;
	label: string;
	description: string;
	options: { value: unknown; label: string }[];
	unported?: string;
};

/** A row the component draws itself (UI scale, font, background image). */
export type CustomDef = { kind: 'custom'; id: 'textScale' | 'fontFamily' | 'backgroundImage' };

export type RowDef = (SwitchDef & { kind?: 'switch' }) | CycleDef | CustomDef;

export type Section = 'UI' | 'Chat' | 'Input' | 'Artifacts' | 'Voice' | 'File';

const cycle = (key: string, label: string, description: string, options: [unknown, string][], extra: Partial<CycleDef> = {}): CycleDef => ({ kind: 'cycle', key, label, description, options: options.map(([value, label]) => ({ value, label })), ...extra });

const sw = (key: string, label: string, description: string, fallback: boolean, extra: Partial<SwitchDef> = {}): SwitchDef => ({ key, label, description, fallback, ...extra });

/**
 * Rows for features this app does not have yet. They stay defined, so the
 * admin defaults keep their keys and porting a feature means deleting one
 * line here, but neither Settings modal offers them: a switch that changes
 * nothing is worse than no switch (docs/code-review.md M7).
 */
const UNPORTED = {
	ACCESSIBILITY: 'The accessibility styles are not ported.',
	HAPTICS: 'Nothing in the app vibrates.',
	RICH_COPY: 'Copy always copies plain text.',
	UPDATES: 'There is no update toast or changelog modal.',
	LANDING: 'The chat view has one layout.',
	PREVIEWS: 'There are no previews: chat hover preview or compact previews.',
	MULTI_TABS: 'Multi-model replies always show side by side.',
	TERMINALS: 'Personal terminal servers are not wired into chat (docs/CLAUDE.md).',
	PDF: 'Chats cannot be exported to PDF (docs/CLAUDE.md).',
	FLOATING: 'The floating quick-action toolbar is not ported.',
	RICH_INPUT: 'The composer is a plain textarea, not the rich editor (docs/CLAUDE.md).',
	ARTIFACTS: 'Artifacts open from a code block\'s Preview button only.',
	SANDBOX: 'The artifact preview has a fixed sandbox: scripts without same-origin (ArtifactPanel.tsx).',
	VOICE: 'Voice calls are not ported (docs/CLAUDE.md).',
	CHANNEL_IMAGES: 'Channel uploads are not compressed (docs/CLAUDE.md).'
} as const;

/** Whether a row is offered at all: ported, and its own condition (if any) holds. */
export const isShown = (row: RowDef, ctx: SettingsContext) => row.kind === 'custom' || (!row.unported && (row.kind === 'cycle' || !row.visible || row.visible(ctx)));

/** Every row, per section, in the original order. The first option of a cycle is its unset value. */
export const ROWS: Record<Section, RowDef[]> = {
	UI: [
		{ kind: 'custom', id: 'textScale' },
		{ kind: 'custom', id: 'fontFamily' },
		sw('highContrastMode', 'Accessibility Mode', 'Enable accessibility-focused visual enhancements.', false, { unported: UNPORTED.ACCESSIBILITY }),
		sw('showChatTitleInTab', 'Display Chat Title in Tab', 'Use the active chat title as the browser tab title.', true),
		sw('userLocation', 'Allow User Location', 'Share your current location with features that can use it.', false, { special: 'userLocation' }),
		sw('hapticFeedback', 'Haptic Feedback (Android)', 'Use device vibration feedback on supported Android devices.', false, { unported: UNPORTED.HAPTICS }),
		sw('copyFormatted', 'Copy Formatted Text', 'Copy rich formatted content instead of plain text.', false, { unported: UNPORTED.RICH_COPY }),
		sw('showUpdateToast', 'Toast Notifications for New Updates', 'Show update toasts to admins when new versions are available.', true, { visible: (c) => c.isAdmin, unported: UNPORTED.UPDATES }),
		sw('showChangelog', `Show "What's New" Modal on Login`, 'Open the changelog modal after sign-in when enabled.', true, { visible: (c) => c.isAdmin, unported: UNPORTED.UPDATES })
	],
	Chat: [
		sw('enableMessageQueue', 'Enable Message Queue', 'Queue outgoing messages instead of interrupting active responses.', true),
		cycle('chatDirection', 'Chat Direction', 'Choose automatic, left-to-right, or right-to-left text flow.', [['auto', 'Auto'], ['LTR', 'LTR'], ['RTL', 'RTL']]),
		cycle('landingPageMode', 'Landing Page Mode', 'Choose whether the app opens to the default home or chat view.', [['', 'Default'], ['chat', 'Chat']], { unported: UNPORTED.LANDING }),
		{ kind: 'custom', id: 'backgroundImage' },
		sw('chatBubble', 'Chat Bubble UI', 'Render messages in compact bubble containers.', true),
		sw('showUsername', 'Display the Username Instead of You in the Chat', 'Show your username label instead of You in chat bubbles.', false, { visible: (c) => !readSetting(c.values, 'chatBubble', true) }),
		sw('widescreenMode', 'Widescreen Mode', 'Use a wider chat layout on large displays.', false),
		sw('temporaryChatByDefault', 'Temporary Chat by Default', 'Start new chats as temporary unless changed.', false, { visible: (c) => c.isAdmin || c.canTemporaryChat }),
		sw('chatFadeStreamingText', 'Fade Effect for Streaming Text', 'Fade streaming text as it arrives.', true),
		sw('renderMarkdownInUserMessages', 'Render Markdown in User Messages', 'Format Markdown syntax in your own messages.', true),
		sw('renderMarkdownInAssistantMessages', 'Render Markdown in Assistant Messages', 'Format Markdown syntax in assistant responses.', true),
		sw('renderMarkdownInPreviews', 'Render Markdown in Previews', 'Format Markdown in previews and compact content surfaces.', true, { unported: UNPORTED.PREVIEWS }),
		sw('title.auto', 'Title Auto-Generation', 'Generate chat titles automatically from conversation content.', true),
		sw('autoFollowUps', 'Follow-Up Auto-Generation', 'Generate suggested follow-up prompts after responses.', true),
		sw('autoTags', 'Chat Tags Auto-Generation', 'Generate tags for chats automatically.', true),
		sw('responseAutoCopy', 'Auto-Copy Response to Clipboard', 'Copy the latest assistant response when it completes.', false, { special: 'responseAutoCopy' }),
		sw('scrollOnResponseGeneration', 'Response Auto-Scroll', 'Follow assistant responses as they are generated.', true),
		sw('scrollOnBranchChange', 'Scroll On Branch Change', 'Scroll to the active branch when switching response branches.', true),
		sw('insertSuggestionPrompt', 'Insert Suggestion Prompt to Input', 'Place selected suggestion text into the composer.', false),
		sw('keepFollowUpPrompts', 'Keep Follow-Up Prompts in Chat', 'Keep generated follow-up prompts visible in the chat.', false),
		sw('insertFollowUpPrompt', 'Insert Follow-Up Prompt to Input', 'Insert selected follow-up prompts directly into the composer.', false),
		sw('regenerateMenu', 'Regenerate Menu', 'Show the regenerate action menu for assistant responses.', true),
		sw('collapseCodeBlocks', 'Always Collapse Code Blocks', 'Collapse code blocks by default.', false),
		sw('expandDetails', 'Always Expand Details', 'Open detail blocks by default.', false),
		sw('chatHoverPreview', 'Chat Hover Previews', 'Show a floating preview of recent messages when hovering a chat in the sidebar.', true, { unported: UNPORTED.PREVIEWS }),
		sw('displayMultiModelResponsesInTabs', 'Display Multi-model Responses in Tabs', 'Group multi-model responses into tabs.', false, { unported: UNPORTED.MULTI_TABS }),
		cycle('terminalFileDisplay', 'Terminal File Display', 'Choose where terminal display_file results appear by default.', [['sidebar', 'Sidebar'], ['inline', 'Inline']], { unported: UNPORTED.TERMINALS }),
		sw('showFilesOnTerminalSelect', 'Show Files on Terminal Select', 'Open the file browser after selecting a terminal.', true, { unported: UNPORTED.TERMINALS }),
		sw('terminalPreviewAllowSameOrigin', 'Terminal Preview Allow Same Origin', 'Allow terminal previews to access same-origin browser APIs.', false, { unported: UNPORTED.TERMINALS }),
		sw('stylizedPdfExport', 'Stylized PDF Export', 'Use styled formatting when exporting chats to PDF.', true, { unported: UNPORTED.PDF }),
		sw('showFloatingActionButtons', 'Floating Quick Actions', 'Show the floating quick-action toolbar in chat.', true, { special: 'floatingActions', unported: UNPORTED.FLOATING }),
		cycle('webSearch', 'Web Search in Chat', 'Set web search availability for new chats.', [[null, 'Default'], ['always', 'Always']])
	],
	Input: [
		cycle('ctrlEnterToSend', 'Enter Key Behavior', 'Choose whether Enter sends immediately or uses Ctrl+Enter.', [[false, 'Enter to Send'], [true, 'Ctrl+Enter to Send']]),
		sw('richTextInput', 'Rich Text Input for Chat', 'Use the rich composer instead of a plain textarea.', true, { unported: UNPORTED.RICH_INPUT }),
		sw('promptAutocomplete', 'Prompt Autocompletion', 'Suggest completions while composing prompts.', false, { visible: (c) => c.autocompleteEnabled, unported: UNPORTED.RICH_INPUT }),
		sw('showFormattingToolbar', 'Show Formatting Toolbar', 'Show formatting controls in the rich text composer.', false, { visible: (c) => readSetting(c.values, 'richTextInput', true), unported: UNPORTED.RICH_INPUT }),
		sw('insertPromptAsRichText', 'Insert Prompt as Rich Text', 'Paste inserted prompts as rich text when possible.', false, { visible: (c) => readSetting(c.values, 'richTextInput', true), unported: UNPORTED.RICH_INPUT }),
		sw('largeTextAsFile', 'Paste Large Text as File', 'Convert long pasted text into a file attachment.', false)
	],
	Artifacts: [
		sw('detectArtifacts', 'Detect Artifacts Automatically', 'Detect generated artifacts and show them in the artifact workspace.', true, { unported: UNPORTED.ARTIFACTS }),
		sw('iframeSandboxAllowScripts', 'iframe Sandbox Allow Scripts', 'Allow scripts inside sandboxed iframes.', true, { unported: UNPORTED.SANDBOX }),
		sw('iframeSandboxAllowSameOrigin', 'iframe Sandbox Allow Same Origin', 'Allow artifacts to access same-origin browser APIs inside the sandbox.', false, { unported: UNPORTED.SANDBOX }),
		sw('iframeSandboxAllowForms', 'iframe Sandbox Allow Forms', 'Allow forms inside sandboxed artifact iframes.', true, { unported: UNPORTED.SANDBOX }),
		sw('iframeSandboxAllowDownloads', 'iframe Sandbox Allow Downloads', 'Allow downloads inside sandboxed iframes.', true, { unported: UNPORTED.SANDBOX })
	],
	Voice: [
		sw('voiceInterruption', 'Allow Voice Interruption in Call', 'Let speech interrupt the assistant during a voice call.', false, { unported: UNPORTED.VOICE }),
		sw('showEmojiInCall', 'Display Emoji in Call', 'Show emoji feedback in the call interface.', false, { unported: UNPORTED.VOICE })
	],
	File: [
		cycle('defaultUploadContext', 'Default Upload Mode', 'Attach files with full content or focused retrieval by default.', [['focused', 'Using Focused Retrieval'], ['full', 'Using Entire Document']]),
		sw('imageCompression', 'Image Compression', 'Compress uploaded images before sending or storage.', false, { special: 'imageCompression' }),
		sw('imageCompressionInChannels', 'Compress Images in Channels', 'Apply image compression to channel uploads too.', true, { visible: (c) => readSetting(c.values, 'imageCompression', false), unported: UNPORTED.CHANNEL_IMAGES })
	]
};

const own = (o: unknown, k: string) => typeof o === 'object' && o !== null && Object.prototype.hasOwnProperty.call(o, k);

/** Whether `path` (dotted) is set in `source` at all, even to a falsy value. */
export function hasSettingPath(source: InterfaceValues | null | undefined, path: string): boolean {
	let current: unknown = source;
	for (const part of path.split('.')) {
		if (!own(current, part)) return false;
		current = (current as Record<string, unknown>)[part];
	}
	return true;
}

/** The value at `path`, or `fallback` when it is unset (null counts as unset, as `??` does in the original). */
export function readSetting<T>(source: InterfaceValues | null | undefined, path: string, fallback: T): T {
	let current: any = source;
	for (const part of path.split('.')) current = current?.[part];
	return (current ?? fallback) as T;
}

/**
 * The patch that sets `path` to `value`. A nested path keeps its siblings:
 * `title.auto` keeps the rest of `title`, as the original's toggle did.
 */
export function settingPatch(source: InterfaceValues, path: string, value: unknown): InterfaceValues {
	const [head, ...rest] = path.split('.');
	if (rest.length === 0) return { [head]: value };
	const inner = typeof source[head] === 'object' && source[head] !== null ? source[head] : {};
	return { [head]: { ...inner, ...settingPatch(inner, rest.join('.'), value) } };
}

/**
 * True when a personal setting is showing the admin default: the default sets
 * it and the user never has. Never in 'defaults' mode (that *is* the default).
 */
export const isInherited = (mode: 'defaults' | 'personal', defaults: InterfaceValues, personal: InterfaceValues, path: string) => mode === 'personal' && hasSettingPath(defaults, path) && !hasSettingPath(personal, path);

/** The current option of a cycle (unset = its first), and the value one press moves to. */
export function cycleState(def: CycleDef, values: InterfaceValues) {
	const current = readSetting<unknown>(values, def.key, def.options[0].value);
	const idx = Math.max(0, def.options.findIndex((o) => o.value === current));
	return { option: def.options[idx], next: def.options[(idx + 1) % def.options.length].value };
}

/** One 0.1 step of the UI scale, kept within 1-1.5 and to two decimals. */
export const stepTextScale = (scale: number | null, delta: number) => Math.min(1.5, Math.max(1, Number.parseFloat(((scale ?? 1) + delta).toFixed(2))));

/** The two quick actions offered when someone starts customizing them. */
export const DEFAULT_FLOATING_ACTIONS = [
	{ id: 'ask', label: 'Ask', input: true, prompt: '{{SELECTED_CONTENT}}\n\n\n{{INPUT_CONTENT}}' },
	{ id: 'explain', label: 'Explain', input: false, prompt: '{{SELECTED_CONTENT}}\n\n\nExplain' }
];

export type FloatingAction = { id: string; label: string; input: boolean; prompt: string };

/** A new action with the first free `new-button[-n]` id. */
export function newFloatingAction(existing: FloatingAction[]): FloatingAction {
	let id = 'new-button';
	for (let i = 1; existing.some((b) => b.id === id); i++) id = `new-button-${i}`;
	return { id, label: 'New Button', input: true, prompt: '{{CONTENT}}\n\n\n{{INPUT_CONTENT}}' };
}

/** Background images the picker accepts (the original's list). */
export const BACKGROUND_IMAGE_TYPES = ['image/gif', 'image/webp', 'image/jpeg', 'image/png'];
