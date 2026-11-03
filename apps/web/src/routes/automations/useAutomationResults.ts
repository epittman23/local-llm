import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useSocket } from '@/lib/socket/SocketProvider';

/** The payload of an `automation:result` event (utils/automations.py's finish_automation_run). */
type AutomationResult = { automation_id?: string; status?: string };

/**
 * Refetch an automation and its runs when one of its runs ends.
 *
 * A run is recorded once its reply has ended (#264), which for a thinking
 * model is often well after "Run now" returns, so the page cannot know
 * when to look again. The backend emits `automation:result` to the owner
 * after recording the run, and this refetches on it.
 */
export function useAutomationResults(id: string) {
	const { socket } = useSocket();
	const queryClient = useQueryClient();

	useEffect(() => {
		if (!socket || !id) return;
		const handler = (result: AutomationResult) => {
			if (result?.automation_id !== id) return;
			void queryClient.invalidateQueries({ queryKey: ['automations', 'runs', id] });
			void queryClient.invalidateQueries({ queryKey: ['automations', 'item', id] });
		};
		socket.on('automation:result', handler);
		return () => {
			socket.off('automation:result', handler);
		};
	}, [socket, id, queryClient]);
}
