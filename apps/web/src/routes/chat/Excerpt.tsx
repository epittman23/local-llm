import { useState } from 'react';
import { Button } from '@/components/ui/button';

const PREVIEW = 1500;

/** A retrieved passage as text, cut at 1,500 characters with a button for the rest. */
export function Excerpt({ text }: { text: string }) {
	const [all, setAll] = useState(false);
	return (
		<div className="text-sm whitespace-pre-wrap">
			{all ? text : text.slice(0, PREVIEW)}
			{!all && text.length > PREVIEW && (
				<Button type="button" variant="link" size="xs" className="ml-1" onClick={() => setAll(true)}>
					Show all ({text.length} characters)
				</Button>
			)}
		</div>
	);
}
