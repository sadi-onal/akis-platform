import { test, describe } from 'node:test';
import assert from 'node:assert';
import Fastify from 'fastify';

describe('Trust Proxy (OPS-2)', () => {
  test('respects X-Forwarded-Proto when trustProxy is true', async () => {
    const app = Fastify({ trustProxy: true });

    app.get('/probe', async (request) => ({
      protocol: request.protocol,
      ip: request.ip,
      hostname: request.hostname,
    }));

    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '203.0.113.50',
        'x-forwarded-host': 'akisflow.com',
      },
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.protocol, 'https');
    assert.strictEqual(body.ip, '203.0.113.50');
    assert.strictEqual(body.hostname, 'akisflow.com');

    await app.close();
  });

  test('ignores X-Forwarded-Proto when trustProxy is false', async () => {
    const app = Fastify({ trustProxy: false });

    app.get('/probe', async (request) => ({
      protocol: request.protocol,
      ip: request.ip,
    }));

    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '203.0.113.50',
      },
    });

    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.protocol, 'http');
    assert.notStrictEqual(body.ip, '203.0.113.50');

    await app.close();
  });
});
