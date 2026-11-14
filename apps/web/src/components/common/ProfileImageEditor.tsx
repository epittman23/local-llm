import { Pencil } from 'lucide-react';
import { useRef } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ImageButton } from '@/components/ui/image-button';
import { getGravatarUrl } from '@/lib/apis/utils';
import { WEBUI_BASE_URL } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { cn } from '@/lib/utils';
import { canvasPixelTest, generateInitialsImage } from '@/lib/utils/auth-helpers';
import { ACCEPTED_IMAGE_TYPES, resizeToDataUrl } from '@/lib/utils/image';

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
		<input
			ref={input}
			type="file"
			hidden
			accept="image/*"
			aria-label="Upload profile image"
			onChange={(e) => pick(e.target.files)}
		/>
	);

	if (variant === 'account') {
		return (
			<div className="mb-2 flex items-center gap-4">
				{hidden}
				<Button
					variant="outline"
					size="icon"
					className="size-10 overflow-hidden rounded-full p-0"
					type="button"
					aria-label="Upload Photo"
					onClick={() => input.current?.click()}
				>
					<img src={src} alt="profile" className="h-full w-full object-cover" />
				</Button>
				<div className="flex flex-col gap-1">
					<span className="text-muted-foreground text-xs">{displayName || user?.name}</span>
					<div className="flex flex-wrap items-center gap-2">
						<Button variant="link" size="xs" type="button" onClick={() => input.current?.click()}>
							Upload Photo
						</Button>
						<span className="text-foreground-muted text-caption">·</span>
						<Button variant="link" size="xs" type="button" onClick={remove}>
							Remove
						</Button>
						<span className="text-foreground-muted text-caption">·</span>
						<Button variant="link" size="xs" type="button" onClick={initials}>
							Initials
						</Button>
						<span className="text-foreground-muted text-caption">·</span>
						<Button variant="link" size="xs" type="button" onClick={gravatar}>
							Gravatar
						</Button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="group flex flex-col self-start">
			{hidden}
			<div className="flex self-center">
				<ImageButton
					shape="circle"
					aria-label="Change profile image"
					overlay={<Pencil />}
					onClick={() => input.current?.click()}
				>
					<img src={src} alt="profile" className={cn('rounded-full object-cover', imageClassName)} />
				</ImageButton>
			</div>
			<div className="mt-2 flex w-full flex-col justify-center">
				<Button
					variant="ghost"
					size="xs"
					className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
					type="button"
					onClick={remove}
				>
					Remove
				</Button>
				<Button
					variant="ghost"
					size="xs"
					className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
					type="button"
					onClick={initials}
				>
					Initials
				</Button>
				<Button
					variant="ghost"
					size="xs"
					className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
					type="button"
					onClick={gravatar}
				>
					Gravatar
				</Button>
			</div>
		</div>
	);
}
