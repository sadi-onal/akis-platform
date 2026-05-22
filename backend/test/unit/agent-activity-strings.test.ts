process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';
process.env.AUTH_JWT_SECRET ??= 'test-jwt-secret-at-least-32-chars-long-for-zod';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const AGENT_FILES = [
  'src/pipeline/agents/scribe/ScribeAgent.ts',
  'src/pipeline/agents/proto/ProtoAgent.ts',
  'src/pipeline/agents/trace/TraceAgent.ts',
];

describe('Agent activity strings — provider-agnostic + bakkalca', () => {
  it('no "Claude AI" appears in any emit() activity string', () => {
    for (const f of AGENT_FILES) {
      const src = readFileSync(resolve(process.cwd(), f), 'utf-8');
      // Match only inside emit() string literals — code comments OK.
      const matches = src.match(
        /emit\?\.\(\s*['"]ai_call['"],\s*['"`][^'"`]*Claude AI[^'"`]*['"`]/g
      );
      assert.equal(
        matches,
        null,
        `${f}: found "Claude AI" in emit() string: ${matches?.join('\n')}`
      );
    }
  });

  it('no "iskelet" appears in any emit() activity string', () => {
    for (const f of AGENT_FILES) {
      const src = readFileSync(resolve(process.cwd(), f), 'utf-8');
      const matches = src.match(/emit\?\.\(\s*['"]ai_call['"],\s*['"`][^'"`]*iskelet[^'"`]*['"`]/g);
      assert.equal(matches, null, `${f}: found "iskelet" in emit() string: ${matches?.join('\n')}`);
    }
  });

  it('no "Playwright" appears in any emit() activity string', () => {
    for (const f of AGENT_FILES) {
      const src = readFileSync(resolve(process.cwd(), f), 'utf-8');
      const matches = src.match(
        /emit\?\.\(\s*['"]ai_call['"],\s*['"`][^'"`]*Playwright[^'"`]*['"`]/g
      );
      assert.equal(
        matches,
        null,
        `${f}: found "Playwright" in emit() string: ${matches?.join('\n')}`
      );
    }
  });
});
