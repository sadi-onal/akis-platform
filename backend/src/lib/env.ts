import { getEnv } from '../config/env.js';

const base = getEnv();

export const env = {
  FRONTEND_URL: base.FRONTEND_URL,
  AUTH_COOKIE_NAME: base.AUTH_COOKIE_NAME,
  AUTH_COOKIE_MAXAGE: base.AUTH_COOKIE_MAXAGE,
  AUTH_COOKIE_SAMESITE: base.AUTH_COOKIE_SAMESITE,
  AUTH_COOKIE_SECURE: base.AUTH_COOKIE_SECURE,
  // IMPORTANT: For localhost development, cookie domain should be undefined/omitted
  // Setting domain to 'localhost' can cause issues with some browsers
  AUTH_COOKIE_DOMAIN: base.AUTH_COOKIE_DOMAIN,
  AUTH_JWT_SECRET: process.env.AUTH_JWT_SECRET ?? base.AUTH_JWT_SECRET,
};

const sameSite = env.AUTH_COOKIE_SAMESITE;

// Build cookie options, omitting domain for localhost compatibility
const baseCookieOpts: {
  path: string;
  httpOnly: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  secure: boolean;
  maxAge: number;
  domain?: string;
} = {
  path: '/',
  httpOnly: true,
  sameSite,
  secure: env.AUTH_COOKIE_SECURE,
  maxAge: env.AUTH_COOKIE_MAXAGE,
};

// Only add domain if explicitly set and not empty
// For localhost development, omitting domain is correct behavior
if (env.AUTH_COOKIE_DOMAIN && env.AUTH_COOKIE_DOMAIN.length > 0) {
  baseCookieOpts.domain = env.AUTH_COOKIE_DOMAIN;
}

export const cookieOpts = baseCookieOpts;
