import type { CheckItem } from './EditorPickers';

// Label/description tables for the editor's checkbox grids, from
// workspace/Models/{Capabilities,DefaultFeatures,BuiltinTools}.svelte, in
// sentence case with plain descriptions (WRD-1, A11Y-4: each is shown).

export const capabilityItems: CheckItem[] = [
	{ id: 'vision', label: 'Vision', description: 'Accepts images in a message.' },
	{ id: 'file_upload', label: 'File upload', description: 'Accepts files attached to a message.' },
	{ id: 'file_context', label: 'File context', description: 'Puts the text of attached files into the conversation.' },
	{ id: 'web_search', label: 'Web search', description: 'Can search the web.' },
	{ id: 'image_generation', label: 'Image generation', description: 'Can make images from a description.' },
	{ id: 'code_interpreter', label: 'Code interpreter', description: 'Can run code to calculate and check its work.' },
	{ id: 'terminal', label: 'Terminal', description: 'Can run commands on a terminal server.' },
	{ id: 'usage', label: 'Usage', description: 'Asks the provider to report the tokens each reply used.' },
	{ id: 'citations', label: 'Citations', description: 'Shows the sources a reply drew on.' },
	{
		id: 'status_updates',
		label: 'Status updates',
		description: 'Shows progress, such as a web search, while it works.'
	},
	{ id: 'memory', label: 'Memory', description: 'Puts your saved memories into the conversation.' },
	{
		id: 'builtin_tools',
		label: 'Builtin tools',
		description:
			'Gives the model the app’s own tools (time, memory, chats, notes and more) when it calls tools natively.'
	}
];

export const featureItems: CheckItem[] = capabilityItems.filter((c) =>
	['web_search', 'image_generation', 'code_interpreter'].includes(c.id)
);

export const builtinToolItems: CheckItem[] = [
	{ id: 'time', label: 'Time and dates', description: 'Gets the current time and calculates with dates.' },
	{ id: 'user_input', label: 'Ask you', description: 'Pauses a reply to ask you a clarifying question.' },
	{ id: 'memory', label: 'Memory', description: 'Searches and manages your memories.' },
	{ id: 'chats', label: 'Chat history', description: 'Searches and reads your past chats.' },
	{ id: 'notes', label: 'Notes', description: 'Searches, reads and manages your notes.' },
	{ id: 'knowledge', label: 'Knowledge bases', description: 'Browses and searches knowledge bases.' },
	{ id: 'files', label: 'Files', description: 'Lists, searches and reads the files attached to the chat.' },
	{ id: 'channels', label: 'Channels', description: 'Searches channels and their messages.' },
	{ id: 'notifications', label: 'Notifications', description: 'Sends notifications to the configured webhooks.' },
	{ id: 'web_search', label: 'Web search', description: 'Searches the web and reads pages.' },
	{ id: 'image_generation', label: 'Image generation', description: 'Makes and edits images.' },
	{ id: 'code_interpreter', label: 'Code interpreter', description: 'Runs code.' },
	{ id: 'tasks', label: 'Task list', description: 'Breaks a large request into steps it tracks.' },
	{ id: 'automations', label: 'Automations', description: 'Creates and manages scheduled automations.' },
	{ id: 'calendar', label: 'Calendar', description: 'Lists, searches and changes calendar events.' },
	{ id: 'subagents', label: 'Sub-agents', description: 'Hands focused work to sub-agents running in parallel.' }
];

/** The features a model can have on by default are the ones it has the capability for (Svelte's `availableFeatures`). */
export const availableFeatures = (capabilities: Record<string, unknown>) =>
	featureItems.filter((f) => capabilities[f.id]).map((f) => f.id);

// Which /api/config switch each row depends on, and where an admin turns it on.
const SWITCHES: Record<string, { flag: string; name: string; where: string }> = {
	web_search: { flag: 'enable_web_search', name: 'Web search', where: 'Admin > Settings > Web Search' },
	image_generation: { flag: 'enable_image_generation', name: 'Image generation', where: 'Admin > Settings > Images' },
	code_interpreter: {
		flag: 'enable_code_interpreter',
		name: 'The code interpreter',
		where: 'Admin > Settings > Code Execution'
	},
	memory: { flag: 'enable_memories', name: 'Memory', where: 'Admin > Settings > General' },
	notes: { flag: 'enable_notes', name: 'Notes', where: 'Admin > Settings > General' },
	channels: { flag: 'enable_channels', name: 'Channels', where: 'Admin > Settings > General' },
	calendar: { flag: 'enable_calendar', name: 'The calendar', where: 'Admin > Settings > General' },
	automations: { flag: 'enable_automations', name: 'Automations', where: 'Admin > Settings > General' }
};

/**
 * S4-D3, ACT-5: a row whose feature is switched off on this install stays in
 * the list, disabled, and says where to turn it on. Stored values are kept.
 * Without the config (not loaded yet) nothing is marked off.
 */
export function markSwitchedOff(items: CheckItem[], features: Record<string, unknown> | undefined): CheckItem[] {
	if (!features) return items;
	return items.map((item) => {
		const s = SWITCHES[item.id];
		return s && !features[s.flag] ? { ...item, off: `${s.name} is off in ${s.where}.` } : item;
	});
}
