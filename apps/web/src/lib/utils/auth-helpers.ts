// The subset of apps/openwebui/src/lib/utils/index.ts's 2334-line kitchen
// sink that Phase 6's auth and shared-chat pages need -- same scoping
// decision as lib/utils/api-helpers.ts in Phase 4: port only what's used
// now, not the whole file for fields nothing here reads.

import { WEBUI_BASE_URL } from '@/lib/constants';

// Test a 1x1 pixel to potentially identify browser/plugin fingerprint
// blocking or spoofing. Inspiration:
// https://github.com/kkapsner/CanvasBlocker/blob/master/test/detectionTest.js
export const canvasPixelTest = (): boolean => {
	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d');
	canvas.height = 1;
	canvas.width = 1;
	if (!ctx) return false;
	const imageData = new ImageData(canvas.width, canvas.height);
	const pixelValues = imageData.data;

	for (let i = 0; i < imageData.data.length; i += 1) {
		pixelValues[i] = i % 4 !== 3 ? Math.floor(256 * Math.random()) : 255;
	}

	ctx.putImageData(imageData, 0, 0);
	const p = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
	return pixelValues.length === p.length && pixelValues.every((v, i) => v === p[i]);
};

export const generateInitialsImage = (name: string): string => {
	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d');
	canvas.width = 100;
	canvas.height = 100;

	if (!ctx || !canvasPixelTest()) {
		console.log(
			'generateInitialsImage: failed pixel test, fingerprint evasion is likely. Using default image.'
		);
		return `${WEBUI_BASE_URL}/user.png`;
	}

	ctx.fillStyle = '#F39C12';
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	ctx.fillStyle = '#FFFFFF';
	ctx.font = '40px Helvetica';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';

	const sanitizedName = name.trim();
	const initials =
		sanitizedName.length > 0
			? sanitizedName[0] +
				(sanitizedName.split(' ').length > 1 ? sanitizedName[sanitizedName.lastIndexOf(' ') + 1] : '')
			: '';

	ctx.fillText(initials.toUpperCase(), canvas.width / 2, canvas.height / 2);

	return canvas.toDataURL();
};

export const getUserTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

type ChatMessage = {
	id?: string;
	parentId?: string | null;
	[key: string]: unknown;
};

type History = {
	messages: Record<string, ChatMessage & { id: string; parentId: string | null; childrenIds: string[] }>;
	currentId: string | null;
};

// `uuidv4()` in the source -- crypto.randomUUID() is the same RFC 4122 v4
// UUID without adding the `uuid` package for the one call site that needs
// it (the fallback path for a legacy shared chat with no `history`, only a
// flat `messages` array).
export const convertMessagesToHistory = (messages: ChatMessage[]): History => {
	const history: History = { messages: {}, currentId: null };

	let parentMessageId: string | null = null;
	let messageId: string | null = null;

	for (const message of messages) {
		messageId = message?.id ?? crypto.randomUUID();
		const parentId = message?.parentId ?? parentMessageId;

		history.messages[messageId] = {
			...message,
			id: messageId,
			parentId,
			childrenIds: []
		};

		parentMessageId = messageId;
	}

	for (const message of Object.values(history.messages)) {
		if (message.parentId && history.messages[message.parentId]) {
			history.messages[message.parentId].childrenIds = [
				...history.messages[message.parentId].childrenIds,
				message.id
			];
		}
	}

	history.currentId = messageId;
	return history;
};

export const createMessagesList = (history: History, messageId: string | null): ChatMessage[] => {
	const list: ChatMessage[] = [];
	let currentId = messageId;

	while (currentId !== null && currentId !== undefined) {
		const message = history.messages[currentId];
		if (message === undefined) break;
		list.push(message);
		currentId = message.parentId;
	}

	return list.reverse();
};
