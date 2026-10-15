import Button from './Button';

export interface PagerProps {
  /** 1-based current page. */
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

export default function Pager({ page, pageSize, total, onPageChange }: PagerProps) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav
      aria-label="Pagination"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-3)',
        fontFamily: 'var(--font-ui)',
        fontSize: 14,
        color: 'var(--c-text-2)',
      }}
    >
      <Button variant="secondary" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
        Previous
      </Button>
      <span aria-live="polite">
        Page {page} of {pages}
      </span>
      <Button variant="secondary" disabled={page >= pages} onClick={() => onPageChange(page + 1)}>
        Next
      </Button>
    </nav>
  );
}
