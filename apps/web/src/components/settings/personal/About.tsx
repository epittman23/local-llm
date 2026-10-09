import { useQuery } from '@tanstack/react-query';
import { getVersionUpdates } from '@/lib/apis';
import { getOllamaVersion } from '@/lib/apis/ollama';
import { WEBUI_BUILD_HASH, WEBUI_VERSION } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore, useWebUIName } from '@/lib/stores/configStore';
import { compareVersion } from '@/lib/utils/plugins';
import { SettingRow, SettingsForm, SettingsSection } from '../controls';

const link = 'hover:text-foreground underline-offset-2 hover:underline';

/**
 * Ports Settings/About.svelte: the installed version and (when the server
 * allows the check) whether a newer release exists, the Ollama version when
 * there is one, and the community links and attributions. The attributions
 * below are kept as the original has them: Open WebUI's LICENSE requires
 * that its About identifier, license and copyright lines are not altered,
 * removed or obscured (https://docs.openwebui.com/license). No "See what's
 * new" link: the changelog modal is not ported.
 */
export default function About() {
	const token = useAuthStore((s) => s.token) ?? '';
	const config = useConfigStore((s) => s.config);
	const name = useWebUIName();
	const checkUpdates = Boolean((config?.features as Record<string, unknown> | undefined)?.enable_version_update_check);
	const version = useQuery({
		queryKey: ['version-updates'],
		enabled: checkUpdates,
		queryFn: async () =>
			((await getVersionUpdates(token).catch(() => null)) ?? { current: WEBUI_VERSION, latest: WEBUI_VERSION }) as {
				current: string;
				latest: string;
			}
	});
	const ollama = useQuery({
		queryKey: ['ollama-version'],
		queryFn: async () => ((await getOllamaVersion(token).catch(() => '')) as string) || ''
	});
	const license = config?.license_metadata as { type?: string; organization_name?: string } | null | undefined;
	const status =
		version.isFetching || !version.data
			? 'Checking for updates...'
			: compareVersion(version.data.latest, version.data.current)
				? `(v${version.data.latest} available!)`
				: '(latest)';

	return (
		<SettingsForm title="About" footer={false}>
			<SettingsSection title={`${name} Version`} first>
				<SettingRow label={`v${WEBUI_VERSION}`} description="View the installed version and check release updates.">
					{() =>
						checkUpdates ? (
							<div className="flex items-center gap-3 text-xs">
								<a
									className={link}
									href={`https://github.com/open-webui/open-webui/releases/tag/v${version.data?.latest ?? WEBUI_VERSION}`}
									target="_blank"
									rel="noreferrer"
								>
									{status}
								</a>
								<button type="button" className={link} onClick={() => void version.refetch()}>
									Check for updates
								</button>
							</div>
						) : (
							<span className="text-muted-foreground text-xs" title={WEBUI_BUILD_HASH}>
								{WEBUI_BUILD_HASH}
							</span>
						)
					}
				</SettingRow>
			</SettingsSection>
			{ollama.data && (
				<SettingsSection title="Ollama Version">
					<div className="text-muted-foreground text-xs">{ollama.data}</div>
				</SettingsSection>
			)}
			<SettingsSection title="Community">
				{license ? (
					// LICENSE covers this Open WebUI license attribution; see the component comment.
					<div className="text-muted-foreground text-xs">
						{!name.includes('Open WebUI') && <span>{name} - </span>}
						<span className="capitalize">{license.type}</span> license purchased by{' '}
						<span className="capitalize">{license.organization_name}</span>
					</div>
				) : (
					<div className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs">
						<a className={link} href="https://discord.gg/5rJgQTnV4s" target="_blank" rel="noreferrer">
							Discord
						</a>
						<a className={link} href="https://twitter.com/OpenWebUI" target="_blank" rel="noreferrer">
							X
						</a>
						<a className={link} href="https://github.com/open-webui/open-webui" target="_blank" rel="noreferrer">
							GitHub
						</a>
					</div>
				)}
				{/* LICENSE covers this Open WebUI copyright attribution; see the component comment. */}
				<div className="text-muted-foreground text-xs">
					Copyright (c) {new Date().getFullYear()}{' '}
					<a href="https://openwebui.com" target="_blank" rel="noreferrer" className="underline">
						Open WebUI Inc.
					</a>{' '}
					<a href="https://github.com/open-webui/open-webui/blob/main/LICENSE" target="_blank" rel="noreferrer">
						All rights reserved.
					</a>
				</div>
				<div className="text-muted-foreground text-xs">
					Created by{' '}
					<a href="https://github.com/tjbck" target="_blank" rel="noreferrer">
						Tim J. Baek
					</a>
				</div>
			</SettingsSection>
		</SettingsForm>
	);
}
