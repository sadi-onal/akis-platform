import type { PipelineError } from './PipelineTypes.js';

// ─── Typed Error Classes ─────────────────────────

export class PipelineNotFoundError extends Error {
  readonly code = 'PIPELINE_NOT_FOUND';
  constructor(pipelineId: string) {
    super(`Pipeline not found: ${pipelineId}`);
    this.name = 'PipelineNotFoundError';
  }
}

export class InvalidStageError extends Error {
  readonly code = 'INVALID_STAGE';
  constructor(expected: string, actual: string) {
    super(`Invalid stage: expected ${expected}, got ${actual}`);
    this.name = 'InvalidStageError';
  }
}

export class GitHubAPIError extends Error {
  readonly code = 'GITHUB_API_ERROR';
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'GitHubAPIError';
  }
}

export class GitHubRateLimitError extends Error {
  readonly code = 'GITHUB_RATE_LIMITED';
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = 'GitHubRateLimitError';
  }
}

// ─── Error Codes ─────────────────────────────────

export const PipelineErrorCode = {
  // Scribe errors
  AI_RATE_LIMITED: 'AI_RATE_LIMITED',
  AI_PROVIDER_ERROR: 'AI_PROVIDER_ERROR',
  AI_INVALID_RESPONSE: 'AI_INVALID_RESPONSE',
  SCRIBE_EMPTY_IDEA: 'SCRIBE_EMPTY_IDEA',
  SCRIBE_SPEC_VALIDATION_FAILED: 'SCRIBE_SPEC_VALIDATION_FAILED',

  // Proto errors
  GITHUB_NOT_CONNECTED: 'GITHUB_NOT_CONNECTED',
  GITHUB_REPO_EXISTS: 'GITHUB_REPO_EXISTS',
  GITHUB_PERMISSION_DENIED: 'GITHUB_PERMISSION_DENIED',
  GITHUB_API_ERROR: 'GITHUB_API_ERROR',
  PROTO_SCAFFOLD_GENERATION_FAILED: 'PROTO_SCAFFOLD_GENERATION_FAILED',
  PROTO_PUSH_FAILED: 'PROTO_PUSH_FAILED',

  // Trace errors
  TRACE_CODE_READ_FAILED: 'TRACE_CODE_READ_FAILED',
  TRACE_EMPTY_CODEBASE: 'TRACE_EMPTY_CODEBASE',
  TRACE_TEST_GENERATION_FAILED: 'TRACE_TEST_GENERATION_FAILED',
  TRACE_AI_CALL_TIMEOUT: 'TRACE_AI_CALL_TIMEOUT',

  // General pipeline errors
  AI_KEY_MISSING: 'AI_KEY_MISSING',
  PIPELINE_TIMEOUT: 'PIPELINE_TIMEOUT',
  PIPELINE_CANCELLED: 'PIPELINE_CANCELLED',
  NETWORK_ERROR: 'NETWORK_ERROR',
} as const;

export type PipelineErrorCodeType =
  (typeof PipelineErrorCode)[keyof typeof PipelineErrorCode];

const ERROR_DEFINITIONS: Record<
  PipelineErrorCodeType,
  Omit<PipelineError, 'code' | 'technicalDetail'>
> = {
  [PipelineErrorCode.AI_RATE_LIMITED]: {
    message: 'AI servisi şu an yoğun. Birkaç saniye içinde otomatik olarak tekrar denenecek...',
    retryable: true,
    recoveryAction: 'retry',
  },
  [PipelineErrorCode.AI_PROVIDER_ERROR]: {
    message: 'AI servisi geçici bir hata yaşıyor. Lütfen tekrar deneyin.',
    retryable: true,
    recoveryAction: 'retry',
  },
  [PipelineErrorCode.AI_INVALID_RESPONSE]: {
    message: 'Spec oluşturulurken beklenmeyen bir yanıt alındı. Tekrar deneniyor...',
    retryable: true,
    recoveryAction: 'retry',
  },
  [PipelineErrorCode.SCRIBE_EMPTY_IDEA]: {
    message:
      "Lütfen fikrinizi biraz daha detaylı açıklayın. Örneğin: 'React ile bir todo uygulaması istiyorum, kullanıcılar Google ile giriş yapabilsin.'",
    retryable: false,
  },
  [PipelineErrorCode.SCRIBE_SPEC_VALIDATION_FAILED]: {
    message:
      'Spec oluşturuldu ama yeterli detay içermiyor. Daha fazla bilgi vererek tekrar deneyelim.',
    retryable: true,
    recoveryAction: 'retry',
  },
  [PipelineErrorCode.GITHUB_NOT_CONNECTED]: {
    message:
      'GitHub hesabınız bağlı değil. Devam etmek için GitHub hesabınızı bağlayın.',
    retryable: false,
    recoveryAction: 'reconnect_github',
  },
  [PipelineErrorCode.GITHUB_REPO_EXISTS]: {
    message: 'Bu isimde bir repo zaten mevcut. Farklı bir isim seçin.',
    retryable: false,
    recoveryAction: 'edit_spec',
  },
  [PipelineErrorCode.GITHUB_PERMISSION_DENIED]: {
    message:
      "GitHub izinleriniz repo oluşturmaya yetmiyor. Lütfen GitHub bağlantınızı yenileyip 'repo' iznini verin.",
    retryable: false,
    recoveryAction: 'reconnect_github',
  },
  [PipelineErrorCode.GITHUB_API_ERROR]: {
    message:
      "GitHub'a bağlanırken bir sorun oluştu. Lütfen birkaç dakika sonra tekrar deneyin.",
    retryable: true,
    recoveryAction: 'retry',
  },
  [PipelineErrorCode.PROTO_SCAFFOLD_GENERATION_FAILED]: {
    message:
      "Kod üretilirken bir sorun oluştu. Spec'i basitleştirmeyi deneyebilirsiniz.",
    retryable: true,
    recoveryAction: 'retry',
  },
  [PipelineErrorCode.PROTO_PUSH_FAILED]: {
    message:
      "Kod başarıyla üretildi ama GitHub'a yüklenirken sorun oluştu.",
    retryable: true,
    recoveryAction: 'retry',
  },
  [PipelineErrorCode.TRACE_CODE_READ_FAILED]: {
    message:
      "Üretilen kod GitHub'dan okunamadı. Tekrar deneniyor...",
    retryable: true,
    recoveryAction: 'retry',
  },
  [PipelineErrorCode.TRACE_EMPTY_CODEBASE]: {
    message:
      'Üretilen projede test yazılabilecek kaynak kod bulunamadı.',
    retryable: false,
    recoveryAction: 'edit_spec',
  },
  [PipelineErrorCode.TRACE_TEST_GENERATION_FAILED]: {
    message: 'Test dosyaları oluşturulurken sorun oluştu. Tekrar deneniyor...',
    retryable: true,
    recoveryAction: 'retry',
  },
  [PipelineErrorCode.TRACE_AI_CALL_TIMEOUT]: {
    message: 'Test üretimi sırasında AI yanıt vermedi. Tekrar deneniyor...',
    retryable: true,
    recoveryAction: 'retry',
  },
  [PipelineErrorCode.AI_KEY_MISSING]: {
    message:
      'Pipeline calistirmak icin AI API anahtariniz gerekli. Lutfen Ayarlar > AI Anahtarlarindan ekleyin.',
    retryable: false,
    recoveryAction: 'configure_ai_key',
  },
  [PipelineErrorCode.PIPELINE_TIMEOUT]: {
    message: 'İşlem beklenenden uzun sürdü. Pipeline duraklatıldı.',
    retryable: true,
    recoveryAction: 'retry',
  },
  [PipelineErrorCode.PIPELINE_CANCELLED]: {
    message: 'Pipeline iptal edildi.',
    retryable: false,
  },
  [PipelineErrorCode.NETWORK_ERROR]: {
    message:
      'Bağlantı kesildi. Bağlantı geri geldiğinde otomatik olarak devam edilecek.',
    retryable: true,
    recoveryAction: 'retry',
  },
};

export function createPipelineError(
  code: PipelineErrorCodeType,
  technicalDetail?: string
): PipelineError {
  const def = ERROR_DEFINITIONS[code];
  return {
    code,
    message: def.message,
    technicalDetail,
    retryable: def.retryable,
    recoveryAction: def.recoveryAction,
  };
}

export const RETRY_CONFIG = {
  maxRetries: 3,
  backoffDelays: [5_000, 15_000, 30_000],
  specValidationMaxRetries: 2,
  stageTimeoutMs: 5 * 60 * 1000,
  /** Trace reads files from GitHub + generates many tests — needs more time */
  traceStageTimeoutMs: 10 * 60 * 1000,
  /** Dedicated timeout for a single AI generation call (prevents indefinite hangs) */
  aiCallTimeoutMs: 3 * 60 * 1000,
  /** Max total codebase context size sent to AI (characters) */
  maxCodebaseContextChars: 200_000,
} as const;
