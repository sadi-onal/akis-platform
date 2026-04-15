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
    let errorData: { error?: { code?: string; message?: string; details?: unknown } } = {};
    try {
      errorData = await response.json();
    } catch {
      // If response is not JSON, use status text
    }

    const error: ApiError = new Error(
      errorData.error?.message || response.statusText || 'Request failed'
    ) as ApiError;
    error.code = errorData.error?.code || `HTTP_${response.status}`;
    error.statusCode = response.status;
    error.details = errorData.error?.details;
    error.requestId = response.headers.get('request-id') || undefined;

    return error;
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
        
        // Add Content-Type only when body is present and not already set
        if (fetchOptions.body && !headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }

        const response = await fetch(url, {
          ...fetchOptions,
          headers,
        });

        // Auth expired — redirect to login (don't retry)
        if (response.status === 401) {
          const currentPath = window.location.pathname;
          const authPaths = ['/login', '/signup', '/forgot-password', '/reset-password', '/auth/'];
          const isOnAuthPage = authPaths.some(p => currentPath.startsWith(p));
          if (!isOnAuthPage) {
            window.location.href = '/login';
          }
          throw await this.parseErrorResponse(response);
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

    throw lastError || new Error('Request failed after retries');
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
