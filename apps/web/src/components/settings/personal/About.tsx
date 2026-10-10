import { useQuery } from '@tanstack/react-query';
import { getOllamaVersion } from '@/lib/apis/ollama';
import { WEBUI_BUILD_HASH, WEBUI_VERSION } from '@/lib/constants';
import { useAuthStore } from '@/lib/stores/authStore';
import { useWebUIName } from '@/lib/stores/configStore';
import { SettingRow, SettingsForm, SettingsSection } from '../controls';

/**
 * Ports Settings/About.svelte: the installed version and build, the Ollama
 * version when there is one, and the license attribution. There is no update
 * check (this is a hard fork with no upstream releases to compare against) and
 * no community links. The license and copyright lines below are kept exactly
 * as the original has them; the repository's NOTICE file records what is
 * derived from Open WebUI and under which license.
 */
export default function About() {
	const token = useAuthStore((s) => s.token) ?? '';
	const name = useWebUIName();
	const ollama = useQuery({
		queryKey: ['ollama-version'],
		queryFn: async () => ((await getOllamaVersion(token).catch(() => '')) as string) || ''
	});

	return (
		<SettingsForm title="About" footer={false}>
			<SettingsSection title={`${name} Version`} first>
				<SettingRow label={`v${WEBUI_VERSION}`} description="The installed version and build.">
					{() => (
						<span className="text-muted-foreground text-xs" title={WEBUI_BUILD_HASH}>
							{WEBUI_BUILD_HASH}
						</span>
					)}
				</SettingRow>
			</SettingsSection>
			{ollama.data && (
				<SettingsSection title="Ollama Version">
					<div className="text-muted-foreground text-xs">{ollama.data}</div>
				</SettingsSection>
			)}
			<SettingsSection title="License">
				<div className="text-muted-foreground text-xs">
					Portions are derived from Open WebUI and remain under its license; see NOTICE in the repository.
				</div>
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
