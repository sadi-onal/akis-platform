import { getApiBaseUrl } from './config';

export interface RequestOptions extends RequestInit {
  retries?: number;
  retryDelay?: number;
}

export interface ApiError extends Error {
  code: string;
  statusCode: number;
  details?: unknown;
  requestId?: string;
}

export class HttpClient {
  private baseURL: string;

  constructor(baseURL?: string) {
    const resolved = baseURL ?? getApiBaseUrl();
    this.baseURL = resolved.replace(/\/$/, '').replace(/\/api\/?$/, '');
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async parseErrorResponse(response: Response): Promise<ApiError> {
    let errorData: Record<string, unknown> = {};
    try {
      errorData = await response.json();
    } catch {
      // If response is not JSON, use status text
    }

    // Handle multiple error response formats:
    // 1. AKIS standard envelope: { error: { code, message, details } }
    // 2. Fastify default format:  { statusCode, error: "string", message: "string" }
    // 3. Raw message:             { message: "string" }
    const errorObj = errorData.error;
    const nestedMessage = typeof errorObj === 'object' && errorObj !== null
      ? (errorObj as { message?: string }).message
      : undefined;
    const topLevelMessage = typeof errorData.message === 'string'
      ? (errorData.message as string)
      : undefined;

    const message = nestedMessage
      || topLevelMessage
      || response.statusText
      || HttpClient.getDefaultMessageForStatus(response.status);

    const nestedCode = typeof errorObj === 'object' && errorObj !== null
      ? (errorObj as { code?: string }).code
      : undefined;
    const nestedDetails = typeof errorObj === 'object' && errorObj !== null
      ? (errorObj as { details?: unknown }).details
      : undefined;

    const error: ApiError = new Error(message) as ApiError;
    error.code = nestedCode || `HTTP_${response.status}`;
    error.statusCode = response.status;
    error.details = nestedDetails;
    error.requestId = response.headers.get('request-id') || undefined;

    return error;
  }

  /** Fallback messages when HTTP/2 statusText is empty and body is unparseable */
  private static getDefaultMessageForStatus(status: number): string {
    switch (status) {
      case 400: return 'Geçersiz istek';
      case 401: return 'Oturum süresi doldu';
      case 403: return 'Erişim engellendi';
      case 404: return 'Kaynak bulunamadı';
      case 409: return 'Çakışma hatası';
      case 429: return 'Çok fazla istek — lütfen biraz bekleyin';
      case 500: return 'Sunucu hatası';
      case 502: return 'Sunucu bağlantı hatası';
      case 503: return 'Sunucu geçici olarak kullanılamıyor';
      case 504: return 'Sunucu yanıt zaman aşımı';
      default: return `Sunucu hatası (${status})`;
    }
  }

  /**
   * Safely parse JSON response with content-type validation
   * Throws helpful error if response is HTML (common proxy/routing issue)
   */
  private async parseJsonResponse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get('content-type') || '';
    
    // Check if response is HTML (likely a proxy/routing error)
    if (contentType.includes('text/html')) {
      const error: ApiError = new Error(
        'Received HTML response instead of JSON. This usually means the API endpoint was not found or the request was routed incorrectly. Please check that the backend server is running.'
      ) as ApiError;
      error.code = 'HTML_RESPONSE_ERROR';
      error.statusCode = response.status;
      error.requestId = response.headers.get('request-id') || undefined;
      throw error;
    }

    try {
      const data = await response.json();
      const requestId = response.headers.get('request-id');
      
      // Attach request-id to response if present
      if (requestId && typeof data === 'object' && data !== null) {
        (data as { requestId?: string }).requestId = requestId;
      }

      return data as T;
    } catch {
      const error: ApiError = new Error(
        'Failed to parse JSON response. The server may have returned invalid data.'
      ) as ApiError;
      error.code = 'JSON_PARSE_ERROR';
      error.statusCode = response.status;
      error.requestId = response.headers.get('request-id') || undefined;
      throw error;
    }
  }

  private async fetchWithRetry(url: string, options: RequestOptions = {}): Promise<Response> {
    const { retries = 3, retryDelay = 1000, ...fetchOptions } = options;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        // Only set Content-Type: application/json if there's a body
        const headers: Record<string, string> = {
          ...((fetchOptions.headers as Record<string, string>) || {}),
        };
        
        // Add Content-Type only when body is present, not FormData, and not already set
        if (fetchOptions.body && !(fetchOptions.body instanceof FormData) && !headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }

        const response = await fetch(url, {
          ...fetchOptions,
          headers,
        });

        // Auth expired — redirect to login (don't retry). Skip redirect for known non-session errors.
        if (response.status === 401) {
          const apiErr = await this.parseErrorResponse(response);
          const currentPath = window.location.pathname;
          const authPaths = ['/login', '/signup', '/forgot-password', '/reset-password', '/auth/'];
          const isOnAuthPage = authPaths.some((p) => currentPath.startsWith(p));
          if (apiErr.code !== 'GITHUB_NOT_CONNECTED' && !isOnAuthPage) {
            window.location.href = '/login';
          }
          throw apiErr;
        }

        // Don't retry on client errors (4xx) except 429 (rate limit)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          throw await this.parseErrorResponse(response);
        }

        // Retry on server errors (5xx) or rate limit (429)
        if (response.status >= 500 || response.status === 429) {
          if (attempt < retries) {
            const delayMs = retryDelay * Math.pow(2, attempt); // Exponential backoff
            await this.delay(delayMs);
            continue;
          }
          throw await this.parseErrorResponse(response);
        }

        return response;
      } catch (error) {
        lastError = error as Error;
        // Don't retry if it's not a network error or server error
        if (error instanceof Error && !('statusCode' in error)) {
          // Network error - retry
          if (attempt < retries) {
            const delayMs = retryDelay * Math.pow(2, attempt);
            await this.delay(delayMs);
            continue;
          }
        } else {
          // Already parsed API error - don't retry
          throw error;
        }
      }
    }

    throw lastError || new Error('Bağlantı hatası — sunucuya ulaşılamıyor');
  }

  async get<T>(path: string, options?: RequestOptions): Promise<T> {
    const url = `${this.baseURL}${path}`;
    const response = await this.fetchWithRetry(url, {
      credentials: 'include',
      ...options,
      method: 'GET',
    });

    return this.parseJsonResponse<T>(response);
  }

  async postFormData<T>(path: string, formData: FormData, options?: RequestOptions): Promise<T> {
    const url = `${this.baseURL}${path}`;
    const response = await this.fetchWithRetry(url, {
      credentials: 'include',
      ...options,
      method: 'POST',
      body: formData,
      // Do NOT set Content-Type — browser auto-sets multipart boundary
    });
    return this.parseJsonResponse<T>(response);
  }

  async post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    const url = `${this.baseURL}${path}`;
    const response = await this.fetchWithRetry(url, {
      credentials: 'include',
      ...options,
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });

    return this.parseJsonResponse<T>(response);
  }

  async patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    const url = `${this.baseURL}${path}`;
    const response = await this.fetchWithRetry(url, {
      credentials: 'include',
      ...options,
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
    });

    return this.parseJsonResponse<T>(response);
  }

  async put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    const url = `${this.baseURL}${path}`;
    const response = await this.fetchWithRetry(url, {
      credentials: 'include',
      ...options,
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    });

    return this.parseJsonResponse<T>(response);
  }

  async delete<T>(path: string, options?: RequestOptions, body?: unknown): Promise<T> {
    const url = `${this.baseURL}${path}`;
    const response = await this.fetchWithRetry(url, {
      credentials: 'include',
      ...options,
      method: 'DELETE',
      body: body ? JSON.stringify(body) : undefined,
    });

    return this.parseJsonResponse<T>(response);
  }
}
