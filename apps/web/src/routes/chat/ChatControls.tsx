import { FileText } from 'lucide-react';
import { AdvancedParams } from '@/components/common/AdvancedParams';
import { Textarea } from '@/components/ui/textarea';

type Params = Record<string, any>;
type ChatFile = { id?: string | null; name?: string; type?: string; file?: { filename?: string } };

/**
 * A reduced port of chat/ChatControls.svelte + Controls.svelte: the files
 * attached to messages on the branch shown (read from those messages, so not
 * removable here; #160), its system prompt and its advanced
 * parameters. What is edited here is the chat's own `params` -- sent with
 * every request and saved with the chat -- layered over the user's defaults
 * from Settings > General. Function valves are not ported. It is the body of
 * the chat's side panel (`SidePanel`), which gives it its heading and Close.
 */
export function ChatControls({
	params,
	onParams,
	files,
	admin
}: {
	params: Params;
	onParams: (p: Params) => void;
	files: ChatFile[];
	admin: boolean;
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4 text-sm">
			{files.length > 0 && (
				<section>
					<h3 className="mb-1 text-xs font-medium">Files</h3>
					<ul className="flex flex-col gap-1" aria-label="Chat files">
						{files.map((f, i) => (
							<li key={f.id ?? i} className="flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs">
								<FileText className="text-muted-foreground size-3.5 shrink-0" />
								<span className="truncate">{f.name ?? f.file?.filename ?? f.id}</span>
							</li>
						))}
					</ul>
				</section>
			)}
			<section>
				<label htmlFor="chat-system-prompt" className="mb-1 block text-xs font-medium">
					System prompt
				</label>
				<Textarea
					id="chat-system-prompt"
					rows={4}
					className="min-h-0 field-sizing-fixed resize-y"
					placeholder="Enter system prompt"
					value={params.system ?? ''}
					onChange={(e) => onParams({ ...params, system: e.target.value || undefined })}
				/>
			</section>
			<section>
				<h3 className="mb-1 text-xs font-medium">Model parameters</h3>
				<AdvancedParams params={params} onChange={(p) => onParams({ ...p, system: params.system })} admin={admin} />
			</section>
		</div>
	);
}
