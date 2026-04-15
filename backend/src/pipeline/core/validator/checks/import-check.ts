/**
 * Import Check — Verify import statements resolve to known packages.
 *
 * - Extracts ES import and CommonJS require() statements
 * - Verifies bare specifiers against a top-500 npm packages list
 * - Flags unknown packages as warnings
 * - Flags relative imports to non-existent files as errors
 *   (checked against the file set provided in ValidationInput)
 */

import type { ValidationFile, ValidationIssue } from '../ValidatorTypes.js';

// ---------------------------------------------------------------------------
// Top-500 npm packages (curated subset — covers the vast majority of
// real-world LLM-generated code).  Kept as a Set for O(1) lookup.
// ---------------------------------------------------------------------------

const TOP_PACKAGES: ReadonlySet<string> = new Set([
  // Core / meta
  'typescript', 'tslib', 'ts-node', 'tsx', 'esbuild', 'webpack',
  'rollup', 'vite', 'parcel', 'turbo', 'lerna', 'nx',

  // Runtime / framework
  'express', 'fastify', 'koa', 'hapi', 'nest', '@nestjs/core',
  '@nestjs/common', 'next', 'nuxt', 'gatsby', 'remix', 'astro',

  // React ecosystem
  'react', 'react-dom', 'react-router', 'react-router-dom',
  'react-query', '@tanstack/react-query', 'react-hook-form',
  'react-redux', 'redux', '@reduxjs/toolkit', 'zustand', 'jotai',
  'recoil', 'mobx', 'mobx-react', 'framer-motion',
  '@emotion/react', '@emotion/styled', 'styled-components',

  // Vue / Svelte / Angular
  'vue', 'vuex', 'pinia', 'vue-router', 'svelte', '@angular/core',
  '@angular/common',

  // CSS / UI
  'tailwindcss', 'postcss', 'autoprefixer', 'sass', 'less',
  'bootstrap', '@mui/material', '@chakra-ui/react', 'antd',
  'radix-ui', '@radix-ui/react-dialog', '@headlessui/react',

  // Testing
  'jest', 'vitest', 'mocha', 'chai', 'sinon', 'ava', 'tap',
  'playwright', '@playwright/test', 'puppeteer', 'cypress',
  '@testing-library/react', '@testing-library/jest-dom',
  'supertest', 'nock', 'msw',

  // Database / ORM
  'pg', 'mysql2', 'sqlite3', 'better-sqlite3', 'mongodb',
  'mongoose', 'sequelize', 'typeorm', 'prisma', '@prisma/client',
  'drizzle-orm', 'drizzle-kit', 'knex', 'redis', 'ioredis',

  // HTTP / API
  'axios', 'node-fetch', 'got', 'undici', 'superagent',
  'graphql', 'apollo-server', '@apollo/client', 'urql',

  // Auth / Crypto
  'jsonwebtoken', 'jose', 'bcrypt', 'bcryptjs', 'argon2',
  'passport', 'passport-local', 'passport-jwt', 'helmet',
  'cors', 'csurf', 'crypto-js',

  // Validation / Schema
  'zod', 'joi', 'yup', 'ajv', 'class-validator', 'superstruct',
  'io-ts', 'typebox', '@sinclair/typebox',

  // Utility
  'lodash', 'underscore', 'ramda', 'date-fns', 'dayjs', 'moment',
  'uuid', 'nanoid', 'chalk', 'debug', 'dotenv', 'commander',
  'yargs', 'inquirer', 'ora', 'glob', 'minimatch', 'semver',
  'cross-env', 'concurrently', 'rimraf', 'mkdirp', 'fs-extra',
  'path-to-regexp', 'mime-types',

  // Logging / Monitoring
  'winston', 'pino', 'bunyan', 'morgan', 'log4js',

  // Cloud / Infra
  'aws-sdk', '@aws-sdk/client-s3', '@aws-sdk/client-dynamodb',
  'firebase', 'firebase-admin', '@google-cloud/storage',
  'stripe', '@stripe/stripe-js', 'twilio', 'nodemailer',
  'resend', 'sendgrid', '@sendgrid/mail',

  // AI / ML
  'openai', '@anthropic-ai/sdk', 'langchain', '@langchain/core',
  'tiktoken', 'onnxruntime-web',

  // File / Stream
  'formidable', 'multer', 'busboy', 'sharp', 'jimp',
  'csv-parse', 'csv-stringify', 'xlsx', 'pdf-lib', 'pdfkit',
  'archiver', 'unzipper',

  // WebSocket / Realtime
  'ws', 'socket.io', 'socket.io-client', 'primus',

  // Process / OS
  'execa', 'shelljs', 'child_process', 'node-cron', 'cron',

  // Markdown / Template
  'marked', 'markdown-it', 'remark', 'rehype', 'handlebars',
  'ejs', 'pug', 'nunjucks', 'mustache',

  // Lint / Format
  'eslint', 'prettier', 'stylelint',

  // Types (@types)
  '@types/node', '@types/express', '@types/react', '@types/jest',
  '@types/lodash', '@types/pg', '@types/bcryptjs',

  // Monorepo / Package
  'changesets', '@changesets/cli', 'husky', 'lint-staged',
  'commitlint', '@commitlint/cli',

  // Misc popular
  'cheerio', 'puppeteer-core', 'jsdom', 'p-limit', 'p-queue',
  'rxjs', 'eventemitter3', 'fast-json-stringify', 'devalue',
  'superjson', 'immer', 'clsx', 'classnames', 'cva',
  'lucide-react', '@heroicons/react', 'react-icons',
  'next-auth', '@auth/core', 'lucia',

  // Node built-ins (bare specifier form)
  'node:fs', 'node:path', 'node:url', 'node:http', 'node:https',
  'node:crypto', 'node:os', 'node:child_process', 'node:stream',
  'node:util', 'node:events', 'node:assert', 'node:test',
  'node:buffer', 'node:querystring', 'node:net', 'node:tls',
  'node:zlib', 'node:readline', 'node:worker_threads', 'node:perf_hooks',
  'fs', 'path', 'url', 'http', 'https', 'crypto', 'os',
  'stream', 'util', 'events', 'assert', 'buffer', 'querystring',
  'net', 'tls', 'zlib', 'readline', 'worker_threads', 'perf_hooks',
  'child_process', 'cluster', 'dgram', 'dns', 'domain',
  'tty', 'v8', 'vm', 'process',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract import specifiers from TS/JS source.
 * Returns array of { specifier, line }.
 */
function extractImports(
  content: string,
): Array<{ specifier: string; line: number }> {
  const results: Array<{ specifier: string; line: number }> = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    // ES imports:  import ... from 'specifier'
    //              import 'specifier'
    const esMatch = ln.match(
      /import\s+(?:type\s+)?(?:(?:\{[^}]*\}|[^'"]*)\s+from\s+)?['"]([^'"]+)['"]/,
    );
    if (esMatch) {
      results.push({ specifier: esMatch[1], line: i + 1 });
      continue;
    }

    // Dynamic import: import('specifier')
    const dynMatch = ln.match(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (dynMatch) {
      results.push({ specifier: dynMatch[1], line: i + 1 });
      continue;
    }

    // CommonJS: require('specifier')
    const cjsMatch = ln.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (cjsMatch) {
      results.push({ specifier: cjsMatch[1], line: i + 1 });
    }
  }

  return results;
}

/** Resolve whether a bare specifier is known. */
function isBareSpecifierKnown(specifier: string): boolean {
  // Direct hit
  if (TOP_PACKAGES.has(specifier)) return true;

  // Scoped packages: check @scope/name without sub-path
  // e.g. @nestjs/core/testing → check @nestjs/core
  const scopedMatch = specifier.match(/^(@[^/]+\/[^/]+)/);
  if (scopedMatch && TOP_PACKAGES.has(scopedMatch[1])) return true;

  // Non-scoped deep import: check root package
  // e.g. lodash/merge → check lodash
  if (!specifier.startsWith('@') && specifier.includes('/')) {
    const root = specifier.split('/')[0];
    if (TOP_PACKAGES.has(root)) return true;
  }

  return false;
}

/**
 * Normalize a relative import path to check against the file set.
 * Given importing file `/src/utils/helper.ts` and specifier `./foo`,
 * returns `/src/utils/foo`.
 */
function resolveRelativePath(
  importerPath: string,
  specifier: string,
): string {
  const dir = importerPath.replace(/\/[^/]+$/, '');
  const parts = dir.split('/').filter(Boolean);
  const specParts = specifier.split('/');

  for (const seg of specParts) {
    if (seg === '.') continue;
    if (seg === '..') {
      parts.pop();
    } else {
      parts.push(seg);
    }
  }

  return '/' + parts.join('/');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function importCheck(files: ValidationFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Build a set of known file paths (without extensions) for relative import resolution.
  const knownPaths = new Set<string>();
  for (const f of files) {
    knownPaths.add(f.path);
    // Also add without common extensions so `./foo` matches `./foo.ts`
    const withoutExt = f.path.replace(/\.(ts|tsx|js|jsx|mjs|cjs|json|css|html)$/, '');
    knownPaths.add(withoutExt);
  }

  const tsJsFiles = files.filter(
    (f) => f.language === 'typescript' || f.language === 'javascript',
  );

  for (const file of tsJsFiles) {
    const imports = extractImports(file.content);

    for (const { specifier, line } of imports) {
      // Relative import
      if (specifier.startsWith('.')) {
        const resolved = resolveRelativePath(file.path, specifier);
        // Strip .js/.ts extension from specifier for comparison
        const resolvedClean = resolved.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');

        const found =
          knownPaths.has(resolved) ||
          knownPaths.has(resolvedClean) ||
          // Check with index file
          knownPaths.has(resolved + '/index') ||
          knownPaths.has(resolvedClean + '/index');

        if (!found) {
          issues.push({
            severity: 'error',
            category: 'import',
            file: file.path,
            line,
            message: `Relative import '${specifier}' does not resolve to any file in the project`,
            rule: 'relative-import-exists',
          });
        }
        continue;
      }

      // Bare specifier — check against known packages
      if (!isBareSpecifierKnown(specifier)) {
        issues.push({
          severity: 'warning',
          category: 'import',
          file: file.path,
          line,
          message: `Unknown package '${specifier}' — not in top-500 npm list`,
          rule: 'known-package',
        });
      }
    }
  }

  return issues;
}
