import { useQuery } from '@tanstack/react-query';
import { ExternalLink, X } from 'lucide-react';
import { useState } from 'react';
import { SafeMarkdown } from '@/components/common/SafeMarkdown';
import { getBanners } from '@/lib/apis/configs';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import { bannerLink, bannerList, readDismissedBannerIds, rememberDismissedBanner, visibleBanners } from './banners';

const TYPE_CLASSES: Record<string, string> = {
	info: 'bg-blue-500/20 text-blue-700 dark:text-blue-200',
	success: 'bg-green-500/20 text-green-700 dark:text-green-200',
	warning: 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-200',
	error: 'bg-red-500/20 text-red-700 dark:text-red-200'
};

/**
 * Ports d863707:apps/openwebui/src/lib/components/common/Banner.svelte and its
 * use in chat/Navbar.svelte (#243): the banners an admin sets in Settings >
 * General, above a new chat. Closing a dismissible one is remembered in this
 * browser; any other closes until the page is reloaded, as in the original.
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
	const [closed, setClosed] = useState<string[]>([]);
	const all = banners.data ?? [];
	const shown = visibleBanners(all, dismissed, closed);
	if (shown.length === 0) return null;

	return (
		<section aria-label="Announcements" className="mx-auto flex w-full max-w-3xl flex-col gap-1 px-4 pt-2">
			{shown.map((banner) => {
				const type = (banner.type || 'info').toLowerCase();
				const link = bannerLink(banner.url);
				return (
					<div
						key={banner.id}
						role="status"
						className="flex items-start gap-2 rounded-lg border px-2 py-1 text-xs"
						data-testid="chat-banner"
					>
						<span
							className={cn('shrink-0 rounded-sm px-2 font-normal uppercase', TYPE_CLASSES[type] ?? TYPE_CLASSES.info)}
						>
							{banner.type || 'info'}
						</span>
						<SafeMarkdown text={banner.content} className="max-h-60 min-w-0 flex-1 overflow-y-auto" />
						{link && (
							<a
								href={link}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex shrink-0 items-center gap-1 underline"
							>
								Details
								<ExternalLink className="size-3" aria-hidden />
							</a>
						)}
						<button
							type="button"
							aria-label="Close Banner"
							className="text-muted-foreground hover:text-foreground shrink-0"
							onClick={() =>
								banner.dismissible
									? setDismissed(rememberDismissedBanner(banner.id, all))
									: setClosed((ids) => [...ids, banner.id])
							}
						>
							<X className="size-3.5" />
						</button>
					</div>
				);
			})}
		</section>
	);
}
