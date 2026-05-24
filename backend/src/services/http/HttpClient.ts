/**
 * HttpClient - Thin wrapper for HTTP requests
 * Provides timeout, retry/backoff hooks for OCI Free Tier constraints
 */

export interface HttpClientOptions {
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

export class HttpClient {
  private defaultTimeout: number;
  private defaultRetries: number;
  private defaultRetryDelay: number;

  constructor(options: HttpClientOptions = {}) {
    this.defaultTimeout = options.timeout || 30000; // 30s default
    this.defaultRetries = options.retries || 3;
    this.defaultRetryDelay = options.retryDelay || 1000; // 1s default
  }

  /**
   * GET request with timeout and retry
   */
  async get(url: string, token?: string, extraHeaders?: Record<string, string>): Promise<Response> {
    return this.request(url, { method: 'GET' }, token, extraHeaders);
  }

  /**
   * POST request with timeout and retry
   * Only sets Content-Type: application/json if body is provided
   */
  async post(
    url: string,
    body?: unknown,
    token?: string,
    extraHeaders?: Record<string, string>
  ): Promise<Response> {
    const init: RequestInit = { method: 'POST' };
    
    // Only set Content-Type and body if body is provided
    if (body !== undefined && body !== null) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    
    return this.request(url, init, token, extraHeaders);
  }
  
  /**
   * PUT request with timeout and retry
   * Only sets Content-Type: application/json if body is provided
   */
  async put(
    url: string,
    body?: unknown,
    token?: string,
    extraHeaders?: Record<string, string>
  ): Promise<Response> {
    const init: RequestInit = { method: 'PUT' };
    
    if (body !== undefined && body !== null) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    
    return this.request(url, init, token, extraHeaders);
  }
  
  /**
   * DELETE request with timeout and retry
   */
  async delete(url: string, token?: string, extraHeaders?: Record<string, string>): Promise<Response> {
    return this.request(url, { method: 'DELETE' }, token, extraHeaders);
  }

  /**
   * Generic request with retry/backoff
   */
  private async request(
    url: string,
    init: RequestInit,
    token?: string,
    extraHeaders?: Record<string, string>
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    if (extraHeaders) {
      for (const [key, value] of Object.entries(extraHeaders)) {
        headers.set(key, value);
      }
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.defaultRetries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.defaultTimeout);
      try {
        const response = await fetch(url, {
          ...init,
          headers,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        clearTimeout(timeoutId);
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.defaultRetries) {
          // Exponential backoff
          const delay = this.defaultRetryDelay * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('Request failed after retries');
  }
}

