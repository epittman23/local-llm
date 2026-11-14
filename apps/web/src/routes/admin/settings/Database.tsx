import saveAs from 'file-saver';
import { useRef } from 'react';
import { toast } from 'sonner';
import { SettingRow, SettingsForm, SettingsSection } from '@/components/settings/controls';
import { Button } from '@/components/ui/button';
import { getAllUserChats } from '@/lib/apis/chats';
import { exportConfig, importConfig } from '@/lib/apis/configs';
import { getAllUsers } from '@/lib/apis/users';
import { downloadDatabase } from '@/lib/apis/utils';
import { useAuthStore } from '@/lib/stores/authStore';
import { useConfigStore } from '@/lib/stores/configStore';
import { csvCell } from '@/lib/utils/csv';

/** id, name, email, role -- one CSV row per user; free-text cells are formula-neutralized. */
export function usersToCsv(users: Record<string, unknown>[]): string {
	const headers = ['id', 'name', 'email', 'role'];
	return [headers.join(','), ...users.map((user) => headers.map((h) => csvCell(user[h])).join(','))].join('\n');
}

/**
 * Ports admin/Settings/Database.svelte: config import/export, and (unless the
 * backend turns it off) database / all-chats / users exports. Nothing here has a
 * Save button; every action is its own.
 *
 * The users CSV quotes every field in the original; here it goes through csvCell,
 * which also stops a user whose *name* is `=HYPERLINK(...)` from running as a
 * formula when the admin opens the file in a spreadsheet.
 */
export default function Database() {
	const token = useAuthStore((s) => s.token) ?? '';
	const config = useConfigStore((s) => s.config);
	const importInput = useRef<HTMLInputElement>(null);

	const importFile = (file: File) => {
		const reader = new FileReader();
		reader.onload = async (event) => {
			try {
				const res = await importConfig(token, JSON.parse(String(event.target?.result)));
				if (res) toast.success('Config imported successfully');
			} catch (error) {
				toast.error(`${error}`);
			}
			if (importInput.current) importInput.current.value = '';
		};
		reader.readAsText(file);
	};

	const exportChats = async () => {
		try {
			const chats = await getAllUserChats(token);
			saveAs(new Blob([JSON.stringify(chats)], { type: 'application/json' }), `all-chats-export-${Date.now()}.json`);
		} catch (error) {
			toast.error(`${error}`);
		}
	};

	const exportUsers = async () => {
		try {
			const res = await getAllUsers(token);
			saveAs(new Blob([usersToCsv(res.users)], { type: 'text/csv;charset=utf-8;' }), 'users.csv');
		} catch (error) {
			toast.error(`${error}`);
		}
	};

	return (
		<SettingsForm title="Database" footer={false}>
			<input
				ref={importInput}
				id="config-json-input"
				hidden
				type="file"
				accept=".json"
				aria-label="Config JSON file"
				onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])}
			/>
			<SettingsSection title="Config" first>
				<SettingRow label="Import Config" description="Import admin configuration from a JSON export file.">
					<Button variant="outline" size="sm" type="button" onClick={() => importInput.current?.click()}>
						Import
					</Button>
				</SettingRow>
				<SettingRow label="Export Config" description="Download the current admin configuration as JSON.">
					<Button
						variant="outline"
						size="sm"
						type="button"
						onClick={async () => {
							const exported = await exportConfig(token).catch((error) => {
								toast.error(`${error}`);
								return null;
							});
							if (exported)
								saveAs(new Blob([JSON.stringify(exported)], { type: 'application/json' }), `config-${Date.now()}.json`);
						}}
					>
						Export
					</Button>
				</SettingRow>
			</SettingsSection>

			{(config?.features?.enable_admin_export ?? true) && (
				<SettingsSection title="Export">
					<SettingRow label="Database" description="Download the application database when supported.">
						<Button
							variant="outline"
							size="sm"
							type="button"
							onClick={() => downloadDatabase(token).catch((error) => toast.error(`${error}`))}
						>
							Database
						</Button>
					</SettingRow>
					<SettingRow label="All Chats" description="Download every user's chat history as JSON.">
						<Button variant="outline" size="sm" type="button" onClick={exportChats}>
							Export
						</Button>
					</SettingRow>
					<SettingRow label="Users" description="Download all users as CSV.">
						<Button variant="outline" size="sm" type="button" onClick={exportUsers}>
							Export
						</Button>
					</SettingRow>
				</SettingsSection>
			)}
		</SettingsForm>
	);
}
