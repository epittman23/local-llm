import { Navigate } from 'react-router';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { defaultWorkspacePath } from './workspaceAccess';

// Ports (app)/workspace/+page.svelte: bare /workspace sends an admin to
// Models, and anyone else to the first section they hold a permission for.
// It sits inside WorkspaceLayout, which has already waited for the session
// and config, so both are known by the time this renders.
export function WorkspaceIndexRedirect() {
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	return <Navigate to={defaultWorkspacePath(user, config)} replace />;
}
