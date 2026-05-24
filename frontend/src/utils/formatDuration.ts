/**
 * Format a millisecond duration into a compact Turkish phrase.
 *
 *   < 60s:    "X sn"
 *   < 60m:    "X dk" (eğer kalan sn < 5) veya "X dk Y sn"
 *   >= 1 sa:  "X sa" veya "X sa Y dk"
 *
 * Returns '' for undefined / null / negative input — UI uses falsy check to
 * skip rendering the duration meta (spec NF-2: yanlış değer yerine yok).
 *
 * NOTE: hardcoded TR strings (sn / dk / sa). TODO(i18n Task 12): externalize.
 */
export function formatDuration(durationMs: number | undefined | null): string {
  if (durationMs == null || durationMs < 0) return '';

  const totalSeconds = Math.floor(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} sn`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const remainderSec = totalSeconds - totalMinutes * 60;
    if (remainderSec < 5) return `${totalMinutes} dk`;
    return `${totalMinutes} dk ${remainderSec} sn`;
  }

  const totalHours = Math.floor(totalMinutes / 60);
  const remainderMin = totalMinutes - totalHours * 60;
  if (remainderMin === 0) return `${totalHours} sa`;
  return `${totalHours} sa ${remainderMin} dk`;
}
