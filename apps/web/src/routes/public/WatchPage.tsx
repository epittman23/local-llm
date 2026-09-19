import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { routePaths } from '@/routes/routePaths';

/** Ports apps/openwebui/src/routes/watch/+page.svelte's redirect verbatim. */
export function WatchPage() {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();

	useEffect(() => {
		const videoId = searchParams.get('v');
		navigate(videoId ? `${routePaths.home}?youtube=${encodeURIComponent(videoId)}` : routePaths.home, {
			replace: true
		});
	}, [searchParams, navigate]);

	return null;
}
