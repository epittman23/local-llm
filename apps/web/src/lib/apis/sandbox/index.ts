import { errorBody, errorDetail } from '@/lib/apis/errors';
import { WEBUI_API_BASE_URL } from '@/lib/constants';

export type SandboxStatus = { ready: boolean; reason: string | null };

/** Whether the sandbox engine can run, and if not, why (admin only). */
export const getSandboxStatus = async (token: string): Promise<SandboxStatus> => {
	let error = null;

	const res = await fetch(`${WEBUI_API_BASE_URL}/sandbox/status`, {
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
