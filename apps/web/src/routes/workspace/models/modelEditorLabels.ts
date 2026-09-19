import type { CheckItem } from './EditorPickers';

// Label/description tables for the editor's checkbox grids, copied from
// workspace/Models/{Capabilities,DefaultFeatures,BuiltinTools}.svelte.

export const capabilityItems: CheckItem[] = [
	{ id: 'vision', label: 'Vision', description: 'Model accepts image inputs' },
	{ id: 'file_upload', label: 'File Upload', description: 'Model accepts file inputs' },
	{ id: 'file_context', label: 'File Context', description: 'Inject file content into conversation context' },
	{ id: 'web_search', label: 'Web Search', description: 'Model can search the web for information' },
	{ id: 'image_generation', label: 'Image Generation', description: 'Model can generate images based on text prompts' },
	{ id: 'code_interpreter', label: 'Code Interpreter', description: 'Model can execute code and perform calculations' },
	{ id: 'terminal', label: 'Terminal', description: 'Model can access Open Terminal for command execution and file management' },
	{ id: 'usage', label: 'Usage', description: 'Sends `stream_options: { include_usage: true }` in the request.\nSupported providers will return token usage information in the response when set.' },
	{ id: 'citations', label: 'Citations', description: 'Displays citations in the response' },
	{ id: 'status_updates', label: 'Status Updates', description: 'Displays status updates (e.g., web search progress) in the response' },
	{ id: 'memory', label: 'Memory', description: 'Inject stored memories into conversation context' },
	{ id: 'builtin_tools', label: 'Builtin Tools', description: 'Automatically inject system tools in native function calling mode (e.g., timestamps, memory, chat history, notes, etc.)' }
];

export const featureItems: CheckItem[] = capabilityItems.filter((c) => ['web_search', 'image_generation', 'code_interpreter'].includes(c.id));

export const builtinToolItems: CheckItem[] = [
	{ id: 'time', label: 'Time & Calculation', description: 'Get current time and perform date/time calculations' },
	{ id: 'user_input', label: 'Ask User', description: 'Pause a response to ask the user a clarifying question' },
	{ id: 'memory', label: 'Memory', description: 'Search and manage user memories' },
	{ id: 'chats', label: 'Chat History', description: 'Search and view user chat history' },
	{ id: 'notes', label: 'Notes', description: 'Search, view, and manage user notes' },
	{ id: 'knowledge', label: 'Knowledge Base', description: 'Browse and query knowledge bases' },
	{ id: 'files', label: 'Files', description: 'List, search, and read files attached to the current chat' },
	{ id: 'channels', label: 'Channels', description: 'Search channels and channel messages' },
	{ id: 'notifications', label: 'Notifications', description: 'Send notifications to configured webhook targets' },
	{ id: 'web_search', label: 'Web Search', description: 'Search the web and fetch URLs' },
	{ id: 'image_generation', label: 'Image Generation', description: 'Generate and edit images' },
	{ id: 'code_interpreter', label: 'Code Interpreter', description: 'Execute code' },
	{ id: 'tasks', label: 'Task Management', description: 'Break down complex requests into trackable steps' },
	{ id: 'automations', label: 'Automations', description: 'Create and manage scheduled automations' },
	{ id: 'calendar', label: 'Calendar', description: 'List calendars, search, create, update, and delete calendar events' },
	{ id: 'subagents', label: 'Sub-agents', description: 'Delegate focused work to parallel sub-agents' }
];

/** The features a model can have on by default are the ones it has the capability for (Svelte's `availableFeatures`). */
export const availableFeatures = (capabilities: Record<string, unknown>) =>
	featureItems.filter((f) => capabilities[f.id]).map((f) => f.id);
