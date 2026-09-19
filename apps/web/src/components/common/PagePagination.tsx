import {
	Pagination,
	PaginationContent,
	PaginationEllipsis,
	PaginationItem,
	PaginationLink,
	PaginationNext,
	PaginationPrevious
} from '@/components/ui/pagination';

// The page numbers bits-ui's Pagination.Root computes for the Svelte version
// (first, last, current +/- 1, ellipses between), reproduced here because
// shadcn's Pagination is only styling -- it has no paging logic of its own.
export function pageWindow(page: number, pages: number): Array<number | 'ellipsis-left' | 'ellipsis-right'> {
	if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
	const result: Array<number | 'ellipsis-left' | 'ellipsis-right'> = [1];
	const start = Math.max(2, page - 1);
	const end = Math.min(pages - 1, page + 1);
	if (start > 2) result.push('ellipsis-left');
	for (let p = start; p <= end; p++) result.push(p);
	if (end < pages - 1) result.push('ellipsis-right');
	result.push(pages);
	return result;
}

/** Ports common/Pagination.svelte. `page` is 1-based, as in the original. */
export function PagePagination({
	page,
	count,
	perPage,
	onPageChange
}: {
	page: number;
	count: number;
	perPage: number;
	onPageChange: (page: number) => void;
}) {
	const pages = Math.max(1, Math.ceil(count / perPage));
	return (
		<Pagination>
			<PaginationContent>
				<PaginationItem>
					<PaginationPrevious
						href="#"
						aria-disabled={page <= 1}
						className={page <= 1 ? 'pointer-events-none opacity-50' : undefined}
						onClick={(e) => {
							e.preventDefault();
							if (page > 1) onPageChange(page - 1);
						}}
					/>
				</PaginationItem>
				{pageWindow(page, pages).map((entry) =>
					typeof entry === 'string' ? (
						<PaginationItem key={entry}>
							<PaginationEllipsis />
						</PaginationItem>
					) : (
						<PaginationItem key={entry}>
							<PaginationLink
								href="#"
								isActive={entry === page}
								onClick={(e) => {
									e.preventDefault();
									onPageChange(entry);
								}}
							>
								{entry}
							</PaginationLink>
						</PaginationItem>
					)
				)}
				<PaginationItem>
					<PaginationNext
						href="#"
						aria-disabled={page >= pages}
						className={page >= pages ? 'pointer-events-none opacity-50' : undefined}
						onClick={(e) => {
							e.preventDefault();
							if (page < pages) onPageChange(page + 1);
						}}
					/>
				</PaginationItem>
			</PaginationContent>
		</Pagination>
	);
}
