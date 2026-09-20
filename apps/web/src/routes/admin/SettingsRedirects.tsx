import { Navigate, useLocation, useParams } from 'react-router';
import { useConfigStore } from '@/lib/stores/configStore';
import { analyticsRedirectPath, settingsRedirectPath } from './adminAccess';

/**
 * `/admin/settings[/<tab>]`: in this app Settings is a modal, so the old URLs
 * (and the layout's Settings tab) redirect to the chat page with
 * `?settings=admin:<tab>`, which opens it -- exactly what the two Svelte
 * redirect pages do. The modal itself is opened by `useSettingsUrl`.
 */
export function SettingsRedirect() {
	const { tab } = useParams();
	const { search } = useLocation();
	return <Navigate to={settingsRedirectPath(tab, search)} replace />;
}

/** `/admin/analytics[/<tab>]`: the Analytics tab of the modal, or /admin when analytics is off. */
export function AnalyticsRedirect() {
	const config = useConfigStore((s) => s.config);
	return <Navigate to={analyticsRedirectPath(config)} replace />;
}
