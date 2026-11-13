import { WEBUI_API_BASE_URL } from '@/lib/constants';
import { errorBody, errorDetail, requestError } from '@/lib/apis/errors';

export const getGravatarUrl = async (token: string, email: string) => {
	let error = null;

	const res = await fetch(`${WEBUI_API_BASE_URL}/utils/gravatar?email=${email}`, {
		method: 'GET',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
		}
	})
		.then(async (res) => {
			if (!res.ok) throw await errorBody(res);
			return res.json();
		})
		.catch((err) => {
			console.error(err);
			error = errorDetail(err);
			return null;
		});

	if (error) {
		throw error;
	}

	return res;
};

/**
 * What the Run endpoint answers (routers/utils.py): the code's output, and under the `sandbox` engine the files it
 * left in /workspace/outputs (`files`, sandbox outputs as on a reply) or `error` when the sandbox could not run it.
 */
export type CodeRunResult = {
	stdout?: string;
	stderr?: string;
	result?: string;
	error?: string;
	timed_out?: boolean;
	/** Set when stdout or stderr was cut to its first and last 10,000 characters. */
	truncated?: boolean;
	returncode?: number;
	files?: unknown[];
};

/** Run a code block: in its chat's sandbox when `chatId` is given and the engine is `sandbox` (owner decision Q2). */
export const executeCode = async (token: string, code: string, chatId?: string): Promise<CodeRunResult> => {
	let error = null;

	const res = await fetch(`${WEBUI_API_BASE_URL}/utils/code/execute`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
		},
		body: JSON.stringify({
			code: code,
			...(chatId ? { chat_id: chatId } : {})
		})
	})
		.then(async (res) => {
			if (!res.ok) throw await errorBody(res);
			return res.json();
		})
		.catch((err) => {
			console.error(err);

			error = requestError(err);
			if (err.detail) {
				error = errorDetail(err);
			}
			return null;
		});

	if (error) {
		throw error;
	}

	return res;
};

export const formatPythonCode = async (token: string, code: string) => {
	let error = null;

	const res = await fetch(`${WEBUI_API_BASE_URL}/utils/code/format`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
		},
		body: JSON.stringify({
			code: code
		})
	})
		.then(async (res) => {
			if (!res.ok) throw await errorBody(res);
			return res.json();
		})
		.catch((err) => {
			console.error(err);

			error = requestError(err);
			if (err.detail) {
				error = errorDetail(err);
			}
			return null;
		});

	if (error) {
		throw error;
	}

	return res;
};

export const downloadChatAsPDF = async (token: string, title: string, messages: object[]) => {
	let error = null;

	const blob = await fetch(`${WEBUI_API_BASE_URL}/utils/pdf`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
		},
		body: JSON.stringify({
			title: title,
			messages: messages
		})
	})
		.then(async (res) => {
			if (!res.ok) throw await errorBody(res);
			return res.blob();
		})
		.catch((err) => {
			console.error(err);
			error = requestError(err);
			return null;
		});

	if (error) throw error;

	return blob;
};

export const downloadDatabase = async (token: string) => {
	let error = null;

	const res = await fetch(`${WEBUI_API_BASE_URL}/utils/db/download`, {
		method: 'GET',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`
		}
	})
		.then(async (response) => {
			if (!response.ok) {
				throw await errorBody(response);
			}
			return response.blob();
		})
		.then((blob) => {
			const url = window.URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = 'webui.db';
			document.body.appendChild(a);
			a.click();
			window.URL.revokeObjectURL(url);
		})
		.catch((err) => {
			console.error(err);
			error = errorDetail(err);
			return null;
		});

	if (error) {
		throw error;
	}
};
