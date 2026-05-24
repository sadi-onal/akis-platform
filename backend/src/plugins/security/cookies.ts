import cookie from '@fastify/cookie';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface CookiesPluginOptions {
  name: string;
  maxAge: number;
  sameSite: 'lax' | 'strict' | 'none';
  secure: boolean;
  domain?: string;
}

export const cookiesPlugin = fp<CookiesPluginOptions>(
  async (fastify: FastifyInstance, options: CookiesPluginOptions) => {
    await fastify.register(cookie, {
      hook: 'onRequest',
    });

    fastify.decorate('authCookieName', options.name);
    fastify.decorateRequest('authSessionId', null as string | null);

    fastify.addHook('onRequest', (request: FastifyRequest, _reply, done: (err?: Error) => void) => {
      const sessionId = request.cookies?.[options.name];
      if (sessionId) {
        request.authSessionId = sessionId;
      }
      done();
    });

    // NOTE: setAuthCookie/clearAuthCookie are NOT called in production code.
    // Production auth (auth.oauth.ts, auth.ts) uses reply.setCookie() with
    // cookieOpts from lib/env.ts directly. These decorators exist for test
    // ergonomics and plugin-based cookie handling.
    const pluginCookieOpts = {
      path: '/',
      httpOnly: true,
      secure: options.secure,
      sameSite: options.sameSite,
      maxAge: options.maxAge,
      ...(options.domain ? { domain: options.domain } : {}),
    };

    fastify.decorateReply(
      'setAuthCookie',
      function setAuthCookie(this: FastifyReply, sessionId: string) {
        this.setCookie(options.name, sessionId, pluginCookieOpts);
        return this;
      }
    );

    fastify.decorateReply('clearAuthCookie', function clearAuthCookie(this: FastifyReply) {
      const clearOptions: {
        path: string;
        sameSite: 'lax' | 'strict' | 'none';
        domain?: string;
      } = {
        path: '/',
        sameSite: options.sameSite,
      };

      if (options.domain) {
        clearOptions.domain = options.domain;
      }

      this.clearCookie(options.name, clearOptions);
      return this;
    });
  }
);

export type CookiesPlugin = typeof cookiesPlugin;
