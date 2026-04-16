import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpClient, type ApiError } from '../HttpClient';

// Mock fetch
global.fetch = vi.fn();

const mockFetch = global.fetch as ReturnType<typeof vi.fn>;

function jsonResponse(status: number, data: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    json: async () => data,
  };
}

function htmlResponse(status: number, html = '<html>Not Found</html>') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Not Found',
    headers: new Headers({ 'content-type': 'text/html' }),
    json: async () => { throw new SyntaxError('Unexpected token <'); },
    text: async () => html,
  };
}

describe('HttpClient', () => {
  let client: HttpClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new HttpClient('http://localhost:3000');
  });

  it('should make GET request successfully', async () => {
    const mockResponse = { data: 'test' };
    mockFetch.mockResolvedValueOnce(jsonResponse(200, mockResponse, { 'request-id': 'test-request-id' }));

    const result = await client.get('/test');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/test',
      expect.objectContaining({ method: 'GET' })
    );
    expect(result).toEqual({ ...mockResponse, requestId: 'test-request-id' });
  });

  it('should handle API errors correctly', async () => {
    const errorResponse = { error: { code: 'NOT_FOUND', message: 'Resource not found' } };
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers({ 'request-id': 'error-request-id' }),
      json: async () => errorResponse,
    });

    await expect(client.get('/test')).rejects.toThrow();
  });

  it('should retry on server errors', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          headers: new Headers(),
          json: async () => ({ error: { code: 'SERVER_ERROR', message: 'Server error' } }),
        });
      }
      return Promise.resolve(jsonResponse(200, { success: true }));
    });

    const result = await client.get('/test', { retries: 3 });
    expect(callCount).toBe(3);
    expect(result).toEqual({ success: true });
  });

  it('should make POST request with body', async () => {
    const mockBody = { type: 'scribe', payload: { doc: 'test' } };
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { jobId: '123', state: 'pending' }));

    await client.post('/test', mockBody);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/test',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(mockBody),
      })
    );
  });
});

// ─── HTML response detection ────────────────────────────────────────

describe('HttpClient HTML response detection', () => {
  let client: HttpClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new HttpClient('http://localhost:3000');
  });

  it('throws HTML_RESPONSE_ERROR when response is text/html', async () => {
    mockFetch.mockResolvedValueOnce(htmlResponse(200));

    try {
      await client.get('/api/test');
      expect.fail('Expected to throw');
    } catch (err) {
      const error = err as ApiError;
      expect(error.code).toBe('HTML_RESPONSE_ERROR');
      expect(error.message).toMatch(/Received HTML response/);
    }
  });

  it('includes statusCode and requestId on HTML error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({
        'content-type': 'text/html',
        'request-id': 'req-html-1',
      }),
      json: async () => { throw new SyntaxError('Unexpected'); },
    });

    try {
      await client.get('/api/test');
      expect.fail('Expected to throw');
    } catch (err) {
      const error = err as ApiError;
      expect(error.statusCode).toBe(200);
      expect(error.requestId).toBe('req-html-1');
    }
  });
});

// ─── JSON parse error handling ──────────────────────────────────────

describe('HttpClient JSON parse errors', () => {
  let client: HttpClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new HttpClient('http://localhost:3000');
  });

  it('throws JSON_PARSE_ERROR when response is not valid JSON', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
    });

    try {
      await client.get('/api/test');
      expect.fail('Expected to throw');
    } catch (err) {
      const error = err as ApiError;
      expect(error.code).toBe('JSON_PARSE_ERROR');
      expect(error.message).toMatch(/Failed to parse JSON/);
    }
  });
});

// ─── Retry logic ────────────────────────────────────────────────────

describe('HttpClient retry logic', () => {
  let client: HttpClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new HttpClient('http://localhost:3000');
  });

  it('retries on 429 rate limit', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: new Headers(),
          json: async () => ({ error: { code: 'RATE_LIMITED', message: 'Slow down' } }),
        });
      }
      return Promise.resolve(jsonResponse(200, { ok: true }));
    });

    const result = await client.get('/api/test', { retries: 2, retryDelay: 1 });
    expect(callCount).toBe(2);
    expect(result).toEqual({ ok: true });
  });

  it('does not retry on 4xx client errors (except 429)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: new Headers(),
      json: async () => ({ error: { code: 'BAD_REQUEST', message: 'Invalid payload' } }),
    });

    await expect(client.get('/api/test', { retries: 3 })).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on network errors', async () => {
    let callCount = 0;
    mockFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return Promise.resolve(jsonResponse(200, { recovered: true }));
    });

    const result = await client.get('/api/test', { retries: 2, retryDelay: 1 });
    expect(callCount).toBe(2);
    expect(result).toEqual({ recovered: true });
  });

  it('throws after max retries exhausted', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(
      client.get('/api/test', { retries: 2, retryDelay: 1 })
    ).rejects.toThrow('Failed to fetch');
    expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});

// ─── Error response parsing ────────────────────────────────────────

describe('HttpClient 401 session handling', () => {
  let client: HttpClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new HttpClient('http://localhost:3000');
  });

  it('redirects to /login on 401 for normal API errors', async () => {
    let currentHref = '';
    Object.defineProperty(window, 'location', {
      value: {
        pathname: '/dashboard',
        set href(v: string) {
          currentHref = v;
        },
        get href() {
          return currentHref;
        },
      },
      writable: true,
      configurable: true,
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }),
    });

    await expect(client.get('/api/test')).rejects.toThrow();
    expect(currentHref).toBe('/login');
  });

  it('does not redirect to login when 401 body is GITHUB_NOT_CONNECTED', async () => {
    let currentHref = '/initial';
    Object.defineProperty(window, 'location', {
      value: {
        pathname: '/engineer',
        set href(v: string) {
          currentHref = v;
        },
        get href() {
          return currentHref;
        },
      },
      writable: true,
      configurable: true,
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        error: { code: 'GITHUB_NOT_CONNECTED', message: 'GitHub not connected' },
      }),
    });

    try {
      await client.get('/api/github/repos');
    } catch (e) {
      const err = e as ApiError;
      expect(err.code).toBe('GITHUB_NOT_CONNECTED');
    }
    expect(currentHref).toBe('/initial');
  });
});

describe('HttpClient error response parsing', () => {
  let client: HttpClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new HttpClient('http://localhost:3000');
  });

  it('extracts code, message, and details from error response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      headers: new Headers({ 'request-id': 'req-err-1' }),
      json: async () => ({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Field "name" is required',
          details: { field: 'name' },
        },
      }),
    });

    try {
      await client.post('/api/test', { data: 'invalid' });
      expect.fail('Expected to throw');
    } catch (err) {
      const error = err as ApiError;
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).toBe('Field "name" is required');
      expect(error.statusCode).toBe(422);
      expect(error.details).toEqual({ field: 'name' });
      expect(error.requestId).toBe('req-err-1');
    }
  });

  it('falls back to statusText when JSON error body is not parseable', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: new Headers(),
      json: async () => { throw new SyntaxError('Invalid JSON'); },
    });

    try {
      await client.get('/api/test');
      expect.fail('Expected to throw');
    } catch (err) {
      const error = err as ApiError;
      expect(error.code).toBe('HTTP_403');
      expect(error.message).toBe('Forbidden');
      expect(error.statusCode).toBe(403);
    }
  });
});

// ─── HTTP methods ───────────────────────────────────────────────────

describe('HttpClient HTTP methods', () => {
  let client: HttpClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new HttpClient('http://localhost:3000');
  });

  it('makes PUT request with body', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { updated: true }));

    await client.put('/api/resource/1', { name: 'updated' });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/resource/1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ name: 'updated' }),
      })
    );
  });

  it('makes DELETE request', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { deleted: true }));

    await client.delete('/api/resource/1');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/resource/1',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('POST without body omits Content-Type header', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await client.post('/api/trigger');

    const callArgs = mockFetch.mock.calls[0];
    const headers = callArgs[1].headers;
    expect(headers['Content-Type']).toBeUndefined();
  });
});

// ─── Base URL normalization ─────────────────────────────────────────

describe('HttpClient base URL normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('strips trailing slash from baseURL', async () => {
    const c = new HttpClient('http://localhost:3000/');
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));

    await c.get('/api/test');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/test',
      expect.any(Object)
    );
  });

  it('strips trailing /api from baseURL', async () => {
    const c = new HttpClient('http://localhost:3000/api');
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));

    await c.get('/api/test');

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/test',
      expect.any(Object)
    );
  });
});
