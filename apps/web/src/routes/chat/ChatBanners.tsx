import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';
import { SafeMarkdown } from '@/components/common/SafeMarkdown';
import { Button } from '@/components/ui/button';
import { getBanners } from '@/lib/apis/configs';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import {
	bannerList,
	closedBannerIds,
	readDismissedBannerIds,
	rememberDismissedBanner,
	visibleBanners
} from './banners';

const TYPE_CLASSES: Record<string, string> = {
	info: 'bg-brand/15 text-brand',
	success: 'bg-success/15 text-success',
	warning: 'bg-warning/15 text-warning',
	error: 'bg-danger/15 text-danger'
};

/**
 * Ports d863707:apps/openwebui/src/lib/components/common/Banner.svelte and its
 * use in chat/Navbar.svelte (#243): the banners an admin sets in Settings >
 * General, above a new chat. Closing a dismissible one is remembered in this
 * browser; any other stays closed until the page is reloaded, as in the
 * original.
 */
export function ChatBanners() {
	const token = useAuthStore((s) => s.token) ?? '';
	const banners = useQuery({
		queryKey: ['banners'],
		queryFn: () => getBanners(token).then(bannerList),
		enabled: Boolean(token),
		staleTime: 60_000
	});
	const [dismissed, setDismissed] = useState(readDismissedBannerIds);
	const [closed, setClosed] = useState(() => [...closedBannerIds]);
	const all = banners.data ?? [];
	const shown = visibleBanners(all, dismissed, closed);
	if (shown.length === 0) return null;

	const close = (id: string, dismissible: boolean | undefined) => {
		if (dismissible) {
			setDismissed(rememberDismissedBanner(id, all));
		} else {
			closedBannerIds.add(id);
			setClosed([...closedBannerIds]);
		}
	};

	return (
		<ul aria-label="Announcements" className="mx-auto flex w-full max-w-3xl flex-col gap-1 px-4 pt-2">
			{shown.map((banner) => {
				const type = (banner.type || 'info').toLowerCase();
				const contentId = `banner-${banner.id}`;
				return (
					<li
						key={banner.id}
						className="flex items-start gap-2 rounded-lg border px-2 py-1 text-xs"
						data-testid="chat-banner"
					>
						<span
							className={cn('shrink-0 rounded-sm px-2 font-normal uppercase', TYPE_CLASSES[type] ?? TYPE_CLASSES.info)}
						>
							{banner.type || 'info'}
						</span>
						<div id={contentId} className="min-w-0 flex-1">
							<SafeMarkdown text={banner.content} className="max-h-60 overflow-y-auto" />
						</div>
						<Button
							type="button"
							aria-label={`Close ${type} banner`}
							aria-describedby={contentId}
							variant="ghost"
							size="icon-xs"
							className="shrink-0"
							onClick={() => close(banner.id, banner.dismissible)}
						>
							<X className="size-3.5" />
						</Button>
					</li>
				);
			})}
		</ul>
	);
}
