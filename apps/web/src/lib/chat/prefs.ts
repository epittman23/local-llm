/**
 * The personal settings that change how chat looks and behaves, read once
 * with the same defaults the Settings modal shows (interfaceSettingDefs.ts),
 * so every chat component agrees on them. Each was saved but never read
 * before docs/code-review.md M7.
 */
export type ChatPrefs = {
	/** User messages in bubbles; off shows them like replies, with a name. */
	chatBubble: boolean;
	/** Without bubbles, label the user's messages with their name instead of "You". */
	showUsername: boolean;
	/** The message column and input use the full width. */
	widescreen: boolean;
	/** Text direction of the conversation. */
	direction: 'auto' | 'ltr' | 'rtl';
	markdownInUserMessages: boolean;
	markdownInAssistantMessages: boolean;
	/** Follow-up suggestions stay under every reply, not only the last. */
	keepFollowUps: boolean;
	/** A suggestion or follow-up goes into the input instead of being sent. */
	insertSuggestion: boolean;
	insertFollowUp: boolean;
	/** The regenerate button has its options menu. */
	regenerateMenu: boolean;
	/** Follow a reply as it streams; scroll to the end on switching versions. */
	scrollOnResponse: boolean;
	scrollOnBranch: boolean;
	/** The chat's title in the browser tab. */
	titleInTab: boolean;
	/** Read a reply aloud when it finishes. */
	autoPlayback: boolean;
	/** New chats start temporary. */
	temporaryByDefault: boolean;
	/** New chats start with web search on. */
	webSearchAlways: boolean;
	/** Pasting more than PASTED_TEXT_LIMIT characters attaches a text file instead. */
	largeTextAsFile: boolean;
	/** The chat's background image (a data URL), if the user chose one. */
	backgroundImageUrl: string | null;
};

/** Characters of pasted text past which "Paste Large Text as File" makes a file (the Svelte app's PASTED_TEXT_CHARACTER_LIMIT). */
export const PASTED_TEXT_LIMIT = 1000;

export function chatPrefs(settings: Record<string, unknown> | null | undefined): ChatPrefs {
	// null counts as unset, as `??` does in the Svelte app and readSetting in interfaceSettingDefs.ts.
	const read = <T>(key: string, fallback: T) => (settings?.[key] ?? fallback) as T;
	const direction = read<string>('chatDirection', 'auto');
	return {
		chatBubble: read('chatBubble', true),
		showUsername: read('showUsername', false),
		widescreen: read('widescreenMode', false),
		direction: direction === 'LTR' ? 'ltr' : direction === 'RTL' ? 'rtl' : 'auto',
		markdownInUserMessages: read('renderMarkdownInUserMessages', true),
		markdownInAssistantMessages: read('renderMarkdownInAssistantMessages', true),
		keepFollowUps: read('keepFollowUpPrompts', false),
		insertSuggestion: read('insertSuggestionPrompt', false),
		insertFollowUp: read('insertFollowUpPrompt', false),
		regenerateMenu: read('regenerateMenu', true),
		scrollOnResponse: read('scrollOnResponseGeneration', true),
		scrollOnBranch: read('scrollOnBranchChange', true),
		titleInTab: read('showChatTitleInTab', true),
		autoPlayback: read('responseAutoPlayback', false),
		temporaryByDefault: read('temporaryChatByDefault', false),
		webSearchAlways: read<unknown>('webSearch', null) === 'always',
		largeTextAsFile: read('largeTextAsFile', false),
		backgroundImageUrl: read<string | null>('backgroundImageUrl', null) || null
	};
}

/** A CSS `url(...)` for a data or http URL, quoted so it cannot end the declaration. */
export const cssUrl = (url: string) =>
	`url("${url.replace(/["\\\n\r]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}")`;
