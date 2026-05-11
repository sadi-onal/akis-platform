import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPatch = vi.fn();
const mockDelete = vi.fn();

vi.mock('../HttpClient', () => ({
  HttpClient: class MockHttpClient {
    get = mockGet;
    post = mockPost;
    patch = mockPatch;
    delete = mockDelete;
  },
}));

vi.mock('../config', () => ({
  getApiBaseUrl: () => 'http://localhost:3000',
}));

const { agentConfigsApi, integrationsApi } = await import('../agent-configs');

const WITH_CREDS = { credentials: 'include' };

describe('agentConfigsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('listConfigs GETs /api/agents/configs', async () => {
    mockGet.mockResolvedValueOnce({ configs: [] });
    const res = await agentConfigsApi.listConfigs();
    expect(mockGet).toHaveBeenCalledWith('/api/agents/configs', WITH_CREDS);
    expect(res).toEqual({ configs: [] });
  });

  it('getConfig GETs /api/agents/configs/:agentType', async () => {
    mockGet.mockResolvedValueOnce({ config: null, integrationStatus: {} });
    await agentConfigsApi.getConfig('scribe');
    expect(mockGet).toHaveBeenCalledWith('/api/agents/configs/scribe', WITH_CREDS);
  });

  it('updateConfig POSTs payload to /api/agents/configs/:agentType', async () => {
    mockPost.mockResolvedValueOnce({ config: {}, message: 'ok' });
    const payload = { enabled: true, repositoryOwner: 'me', repositoryName: 'repo' };
    await agentConfigsApi.updateConfig('proto', payload);
    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/configs/proto',
      payload,
      WITH_CREDS,
    );
  });

  it('validateConfig POSTs to /api/agents/configs/:agentType/validate', async () => {
    mockPost.mockResolvedValueOnce({ valid: true, checks: {} });
    await agentConfigsApi.validateConfig('trace', { enabled: false });
    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents/configs/trace/validate',
      { enabled: false },
      WITH_CREDS,
    );
  });

  it('getModelAllowlist GETs /api/agents/configs/:agentType/models', async () => {
    mockGet.mockResolvedValueOnce({ allowlist: ['gpt-4'], defaultModel: 'gpt-4' });
    const res = await agentConfigsApi.getModelAllowlist('scribe');
    expect(mockGet).toHaveBeenCalledWith('/api/agents/configs/scribe/models', WITH_CREDS);
    expect(res.allowlist).toContain('gpt-4');
  });

  it('lets HttpClient errors bubble through updateConfig', async () => {
    mockPost.mockRejectedValueOnce(new Error('forbidden'));
    await expect(agentConfigsApi.updateConfig('scribe', {})).rejects.toThrow('forbidden');
  });
});

describe('integrationsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('getStatus GETs /api/integrations/status', async () => {
    mockGet.mockResolvedValueOnce({ integrations: {} });
    await integrationsApi.getStatus();
    expect(mockGet).toHaveBeenCalledWith('/api/integrations/status', WITH_CREDS);
  });
});
