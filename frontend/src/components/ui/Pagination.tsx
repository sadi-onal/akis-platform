import Button from "../common/Button";

interface PaginationProps {
  nextCursor: string | null;
  onNext: () => void;
  isLoading?: boolean;
}

export function Pagination({ nextCursor, onNext, isLoading }: PaginationProps) {
  if (!nextCursor) {
    return null;
  }

  return (
    <div className="mt-6 flex justify-center">
      <Button onClick={onNext} disabled={isLoading}>
        {/* PR-B: previously 'Loading…' / 'Load more' — English in a TR UI. */}
        {isLoading ? 'Yükleniyor…' : 'Daha fazla'}
      </Button>
    </div>
  );
}
