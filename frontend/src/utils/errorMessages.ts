/**
 * P11 — AI/akış hatalarını kullanıcıya bakkal-Türkçesi başlık + tek-cümle
 * açıklama olarak çevirir. Banner buradan dönen `severity` ile renk/ikon
 * seçer ve `detail` metnini kullanıcıya gösterir; backend'ten gelen ham
 * `error.message` ve `error.code` ise teknik detay olarak alta katlanır.
 *
 * Demo sahnesinde rate-limit en olası AI hatası — bu yüzden 4 ana sınıf
 * (kota, yoğunluk, zaman aşımı, ağ) ayrı görsel kimliklere bölündü.
 *
 * Bilinmeyen `code` için fallback: backend mesajı + jenerik başlık
 * (regression-safe — eski davranış korunur).
 */

export type FriendlyErrorSeverity = 'warn' | 'error' | 'info';

export interface FriendlyErrorMessage {
  /** Kısa, kullanıcıya dönük başlık (~3-6 kelime). */
  title: string;
  /** Tek cümle açıklama — neyin olduğunu ve sıradaki adımı söyler. */
  detail: string;
  /** Banner renk/ikon seçimi için. `warn` sarı, `error` kırmızı, `info` mavi. */
  severity: FriendlyErrorSeverity;
  /**
   * `true` ise bu mesaj `code`'a göre eşleşti; `false` ise fallback
   * (bilinmeyen kod — `detail` backend mesajıdır). Banner UI bilinen
   * eşleşmelerde ham mesajı teknik detay olarak ayrıca gösterir.
   */
  matched: boolean;
}

/**
 * Backend `PipelineError.code` (bkz. `backend/src/pipeline/core/contracts/
 * PipelineErrors.ts`) ve `AIProviderError.code` (bkz. `backend/src/core/
 * errors.ts`) için bilinen sınıflar. Tablo backend'le senkron olmalı —
 * yeni bir code eklendiğinde buraya da ekleyin.
 */
const KNOWN_MESSAGES: Record<string, Omit<FriendlyErrorMessage, 'matched'>> = {
  // ── AI sağlayıcı hataları ──────────────────────────────────────────────
  AI_RATE_LIMITED: {
    title: 'AI sağlayıcısı yoğun',
    detail: 'AI sağlayıcısı şu an çok istek alıyor; kısa bir süre sonra tekrar denenecek.',
    severity: 'warn',
  },
  AI_PROVIDER_ERROR: {
    title: 'AI sağlayıcısı hata döndürdü',
    detail: 'AI sağlayıcısı geçici bir hata yaşıyor. Birkaç saniye sonra tekrar deneyebilirsiniz.',
    severity: 'error',
  },
  AI_INVALID_RESPONSE: {
    title: 'AI beklenmedik yanıt verdi',
    detail: 'AI yanıtı çözümlenemedi; tekrar denemek için "Tekrar Dene" butonunu kullanın.',
    severity: 'warn',
  },
  AI_NETWORK_ERROR: {
    title: 'Ağ bağlantısı hatası',
    detail: 'AI sağlayıcısına ulaşılamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.',
    severity: 'error',
  },
  AI_AUTH_ERROR: {
    title: 'AI anahtarı reddedildi',
    detail:
      'AI anahtarınız geçersiz ya da süresi dolmuş. Ayarlar > AI Anahtarları menüsünden güncelleyin.',
    severity: 'error',
  },
  AI_KEY_MISSING: {
    title: 'AI anahtarı eksik',
    detail: 'Devam etmek için AI anahtarınızı Ayarlar > AI Anahtarları menüsünden ekleyin.',
    severity: 'error',
  },
  AI_MODEL_NOT_FOUND: {
    title: 'Model bulunamadı',
    detail: 'Seçili model şu an kullanılamıyor. Sohbet ayarlarından farklı bir model seçin.',
    severity: 'error',
  },
  MODEL_NOT_ALLOWED: {
    title: 'Model izin listesinde değil',
    detail: 'Seçilen model bu hesap için izinli değil. Sohbet ayarlarından izinli bir model seçin.',
    severity: 'error',
  },

  // ── Zaman aşımı / ağ ──────────────────────────────────────────────────
  TRACE_AI_CALL_TIMEOUT: {
    title: 'Zaman aşımı',
    detail:
      'Test üretimi sırasında AI yanıt vermedi; tekrar denemek için "Tekrar Dene" butonunu kullanın.',
    severity: 'warn',
  },
  PIPELINE_TIMEOUT: {
    title: 'İşlem zaman aşımına uğradı',
    detail:
      'Bir adım yanıt vermedi. Aşağıdaki teknik detay hangi adımın ne kadar süredir durduğunu gösterir.',
    severity: 'warn',
  },
  NETWORK_ERROR: {
    title: 'Bağlantı kesildi',
    detail: 'İnternet bağlantısı kesildi; bağlantı geri gelince otomatik olarak devam edilecek.',
    severity: 'warn',
  },

  // ── GitHub hataları (info — yardım butonu zaten yönlendiriyor) ─────────
  GITHUB_NOT_CONNECTED: {
    title: 'GitHub bağlı değil',
    detail: 'Kod üretimi için GitHub hesabınızı bağlamanız gerekiyor.',
    severity: 'info',
  },
  GITHUB_TOKEN_INVALID: {
    title: 'GitHub bağlantısının süresi doldu',
    detail: 'GitHub bağlantınızı yenilemeniz gerekiyor.',
    severity: 'warn',
  },
  GITHUB_PERMISSION_DENIED: {
    title: 'GitHub izinleri yetersiz',
    detail: 'GitHub bağlantınızı yenileyip depo izinlerini onaylayın.',
    severity: 'warn',
  },
  GITHUB_REPO_EXISTS: {
    title: 'Bu isimde depo var',
    detail: 'Aynı isimde bir GitHub deposu zaten var. Farklı bir isim seçin.',
    severity: 'warn',
  },
  GITHUB_API_ERROR: {
    title: 'GitHub geçici hata verdi',
    detail: "GitHub'a bağlanırken bir sorun oluştu. Birkaç dakika sonra tekrar deneyin.",
    severity: 'warn',
  },
  GITHUB_RATE_LIMITED: {
    title: 'GitHub kullanım sınırı aşıldı',
    detail: 'GitHub kullanım sınırına ulaşıldı; sınır sıfırlanınca tekrar deneyebilirsiniz.',
    severity: 'warn',
  },
} as const;

/**
 * Backend mesajında "kredi/credit/balance/quota/kota" geçtiğinde
 * `AI_PROVIDER_ERROR` aslında bir kota tükenmesi sinyalidir
 * (bkz. AIService.ts:725). Bu durumda mesajı kota sınıfına yönlendir.
 */
function looksLikeQuotaExhaustion(rawMessage: string | undefined): boolean {
  if (!rawMessage) return false;
  const lower = rawMessage.toLowerCase();
  return (
    lower.includes('credit') ||
    lower.includes('kredi') ||
    lower.includes('balance') ||
    lower.includes('billing') ||
    lower.includes('quota') ||
    lower.includes('kota') ||
    lower.includes('insufficient')
  );
}

const QUOTA_MESSAGE: Omit<FriendlyErrorMessage, 'matched'> = {
  title: 'AI kotası tükendi',
  detail:
    'AI sağlayıcısı hesabınızda yeterli kredi/kota kalmamış. Sağlayıcı panelinden bakiyenizi yenileyin ya da yeni bir AI anahtarı ekleyin.',
  severity: 'error',
};

/**
 * #637 — Detect the backend's `INVALID_STAGE` error, which surfaces when
 * the user clicks an action button (e.g. "Yine de devam et", "Seçilenleri
 * uygula") after the pipeline has already transitioned to the next stage.
 *
 * The HttpClient parses the backend envelope `{ error: { code, message } }`
 * into an `ApiError` with `.code = 'INVALID_STAGE'` and `.statusCode = 400`.
 * This helper checks for that shape so callers can show a user-friendly
 * message and auto-refresh instead of surfacing the raw backend text.
 */
export function isStageConflictError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { code?: string; message?: string };
  return (
    err.code === 'INVALID_STAGE' ||
    (typeof err.message === 'string' && err.message.startsWith('Invalid stage:'))
  );
}

/**
 * Tek-yönlü dönüşüm: backend `error.code` ve (varsa) `error.message`
 * ipuçlarından kullanıcı dostu başlık + açıklama üretir. Bilinmeyen kod
 * için fallback olarak ham mesajı `detail` alanına koyar.
 */
export function errorCodeToFriendlyMessage(
  code: string | undefined,
  fallbackMessage?: string
): FriendlyErrorMessage {
  // Kota sezgisi — backend henüz ayrı code üretmediği için mesaj sniff'i.
  if (code === 'AI_PROVIDER_ERROR' && looksLikeQuotaExhaustion(fallbackMessage)) {
    return { ...QUOTA_MESSAGE, matched: true };
  }

  // Açık kota kodu — backend ileride QUOTA_EXCEEDED eklerse hazır.
  if (code === 'QUOTA_EXCEEDED' || code === 'AI_QUOTA_EXCEEDED') {
    return { ...QUOTA_MESSAGE, matched: true };
  }

  if (code && code in KNOWN_MESSAGES) {
    return { ...KNOWN_MESSAGES[code], matched: true };
  }

  // Bilinmeyen code — eski davranışa düş: jenerik başlık + ham mesaj.
  return {
    title: 'Akış başarısız',
    detail: fallbackMessage ?? 'Beklenmedik bir hata oluştu. Tekrar deneyebilirsiniz.',
    severity: 'error',
    matched: false,
  };
}
