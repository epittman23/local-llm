import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { SettingSelect, SettingSwitch, SettingTextarea } from '@/components/settings/controls';
import type { Banner } from '@/lib/types';
import { BANNER_TYPES, moveBanner } from './banners';

/**
 * Ports Interface/Banners.svelte: the editable list of announcement banners.
 * Controlled -- the tab owns the list and saves it with everything else.
 */
export function Banners({ banners, onChange }: { banners: Banner[]; onChange: (next: Banner[]) => void }) {
	const update = (index: number, patch: Partial<Banner>) => onChange(banners.map((b, i) => (i === index ? { ...b, ...patch } : b)));

	return (
		<ul className={banners.length > 0 ? 'mt-2 flex flex-col gap-3' : ''} aria-label="Banners">
			{banners.map((banner, index) => (
				<li key={banner.id} className="flex items-start justify-between gap-1" data-testid="banner-item">
					<div className="flex flex-col">
						<button type="button" aria-label="Move banner up" disabled={index === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-30" onClick={() => onChange(moveBanner(banners, index, -1))}>
							<ChevronUp className="size-4" />
						</button>
						<button type="button" aria-label="Move banner down" disabled={index === banners.length - 1} className="text-muted-foreground hover:text-foreground disabled:opacity-30" onClick={() => onChange(moveBanner(banners, index, 1))}>
							<ChevronDown className="size-4" />
						</button>
					</div>

					<div className="flex flex-1 flex-row items-start gap-2">
						<SettingSelect value={banner.type} onChange={(type) => update(index, { type })} required aria-label="Banner type" className="capitalize">
							<option value="" disabled hidden>
								Type
							</option>
							{BANNER_TYPES.map((t) => (
								<option key={t} value={t}>
									{t[0].toUpperCase() + t.slice(1)}
								</option>
							))}
						</SettingSelect>

						<SettingTextarea className="mr-2 resize-none" rows={2} placeholder="Content" aria-label="Banner content" value={banner.content} onChange={(e) => update(index, { content: e.target.value })} />

						<div className="flex h-fit items-center pt-1">
							<SettingSwitch checked={banner.dismissible ?? false} onChange={(dismissible) => update(index, { dismissible })} label="Remember dismissal" />
						</div>
					</div>

					<button type="button" aria-label="Remove banner" className="text-muted-foreground hover:text-foreground px-2" onClick={() => onChange(banners.filter((_, i) => i !== index))}>
						<X className="size-4" />
					</button>
				</li>
			))}
		</ul>
	);
}
