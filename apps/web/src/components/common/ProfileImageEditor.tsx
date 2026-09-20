import { Pencil } from 'lucide-react';
import { useRef } from 'react';
import { toast } from 'sonner';
import { getGravatarUrl } from '@/lib/apis/utils';
import { WEBUI_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { canvasPixelTest, generateInitialsImage } from '@/lib/utils/auth-helpers';
import { ACCEPTED_IMAGE_TYPES, resizeToDataUrl } from '@/lib/utils/image';
import { cn } from '@/lib/utils';

/**
 * Ports chat/Settings/Account/UserProfileImage.svelte: click the avatar to
 * upload, or Remove / Initials / Gravatar for the three generated options.
 * `variant="account"` is the inline row the Account settings tab uses (Phase
 * 10); the default is the stacked one the admin Edit User modal uses.
 */
export function ProfileImageEditor({
	value,
	onChange,
	user,
	imageClassName = 'size-14 md:size-18',
	variant = 'default',
	displayName = ''
}: {
	value: string;
	onChange: (url: string) => void;
	user: { name?: string; email?: string } | null;
	imageClassName?: string;
	variant?: 'default' | 'account';
	displayName?: string;
}) {
	const token = useAuthStore((s) => s.token) ?? '';
	const input = useRef<HTMLInputElement>(null);
	const src = value !== '' ? value : generateInitialsImage(user?.name ?? '');

	const pick = async (files: FileList | null) => {
		const file = files?.[0];
		if (!file || !ACCEPTED_IMAGE_TYPES.includes(file.type)) return;
		try {
			onChange(await resizeToDataUrl(file));
		} catch (error) {
			toast.error(`${error}`);
		}
		if (input.current) input.current.value = '';
	};
	const initials = () => {
		if (canvasPixelTest()) onChange(generateInitialsImage(user?.name ?? ''));
		else
			toast.info(
				'Fingerprint spoofing detected: Unable to use initials as avatar. Defaulting to default profile image.',
				{ duration: 10_000 }
			);
	};
	const gravatar = async () => {
		try {
			onChange(await getGravatarUrl(token, user?.email ?? ''));
		} catch (error) {
			toast.error(`${error}`);
		}
	};
	const remove = () => onChange(`${WEBUI_BASE_URL}/user.png`);

	const hidden = (
		<input ref={input} type="file" hidden accept="image/*" aria-label="Upload profile image" onChange={(e) => pick(e.target.files)} />
	);

	if (variant === 'account') {
		const link = 'text-muted-foreground hover:text-foreground text-[0.6875rem] transition-colors';
		return (
			<div className="mb-2 flex items-center gap-4">
				{hidden}
				<button
					type="button"
					className="ring-border relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full ring-1"
					aria-label="Upload Photo"
					onClick={() => input.current?.click()}
				>
					<img src={src} alt="profile" className="h-full w-full object-cover" />
				</button>
				<div className="flex flex-col gap-1">
					<span className="text-muted-foreground text-xs">{displayName || user?.name}</span>
					<div className="flex flex-wrap items-center gap-2">
						<button type="button" className={link} onClick={() => input.current?.click()}>
							Upload Photo
						</button>
						<span className="text-muted-foreground/50 text-[0.6875rem]">·</span>
						<button type="button" className={link} onClick={remove}>
							Remove
						</button>
						<span className="text-muted-foreground/50 text-[0.6875rem]">·</span>
						<button type="button" className={link} onClick={initials}>
							Initials
						</button>
						<span className="text-muted-foreground/50 text-[0.6875rem]">·</span>
						<button type="button" className={link} onClick={gravatar}>
							Gravatar
						</button>
					</div>
				</div>
			</div>
		);
	}

	const action =
		'text-muted-foreground rounded-lg py-0.5 text-center text-xs opacity-0 transition-all group-focus-within:opacity-100 group-hover:opacity-100';
	return (
		<div className="group flex flex-col self-start">
			{hidden}
			<div className="flex self-center">
				<button type="button" className="relative rounded-full" aria-label="Change profile image" onClick={() => input.current?.click()}>
					<img src={src} alt="profile" className={cn('rounded-full object-cover', imageClassName)} />
					<div className="absolute right-0 bottom-0 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100">
						<div className="rounded-full border bg-white p-1 text-black shadow">
							<Pencil className="size-3" />
						</div>
					</div>
				</button>
			</div>
			<div className="mt-2 flex w-full flex-col justify-center">
				<button type="button" className={action} onClick={remove}>
					Remove
				</button>
				<button type="button" className={action} onClick={initials}>
					Initials
				</button>
				<button type="button" className={action} onClick={gravatar}>
					Gravatar
				</button>
			</div>
		</div>
	);
}
