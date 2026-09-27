import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { Spinner } from '@/components/common/Spinner';
import { type Feature, canUseFeature } from '@/lib/access/features';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';

/** Renders `children` only for someone allowed to use `feature`; waits for the config, then sends anyone else home. */
export function FeatureGate({ feature, children }: { feature: Feature; children: ReactNode }) {
	const user = useAuthStore((s) => s.user);
	const config = useConfigStore((s) => s.config);
	if (!user || !config) {
		return (
			<div className="flex flex-1 items-center justify-center p-8">
				<Spinner className="size-5" />
			</div>
		);
	}
	return canUseFeature(feature, user, config) ? <>{children}</> : <Navigate to="/" replace />;
}
