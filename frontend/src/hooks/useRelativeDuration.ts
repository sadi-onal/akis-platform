import { useEffect, useState } from 'react';

/**
 * Live "X dakikadır çalışıyor" rölatif duration. Dakika floor — sn jitter
 * yok (spec NF-3). 30s tick interval; dakika değişimini yakalamak için
 * yeterince sık ama hassas değil (worst-case ~30s gecikme).
 *
 * NOTE: hardcoded TR strings. TODO(i18n Task 12): externalize via t().
 *
 * @param startedAt ISO timestamp; null ise/!isLive ise '' döner
 * @param isLive    Ajan hâlâ çalışmaktaysa true
 */
export function useRelativeDuration(
  startedAt: string | null | undefined,
  isLive: boolean
): string {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!isLive || !startedAt) return;
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [isLive, startedAt]);

  if (!isLive || !startedAt) return '';

  const startedAtMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startedAtMs)) return '';

  const elapsedMs = Date.now() - startedAtMs;
  if (elapsedMs < 0) return '';

  const totalMinutes = Math.floor(elapsedMs / 60_000);
  if (totalMinutes < 1) return '1 dakikadan az';
  if (totalMinutes === 1) return '1 dakikadır çalışıyor';
  return `${totalMinutes} dakikadır çalışıyor`;
}
