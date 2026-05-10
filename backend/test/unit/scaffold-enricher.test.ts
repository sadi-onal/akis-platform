/**
 * ScaffoldEnricher unit tests — F-08 / FR-6.5..6.8.
 *
 * Cover stack detection (8 stacks), template rendering (install.sh + README +
 * Dockerfile + compose + .env.example), Turkish-language acceptance, and
 * idempotent re-enrichment behaviour.
 *
 * Run: pnpm -C backend test:unit
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ScaffoldEnricher,
  type ScaffoldFile,
  toScaffoldFile,
  fromScaffoldFile,
} from '../../src/pipeline/agents/proto/ScaffoldEnricher.js';

// ─── Fixtures ─────────────────────────────────────

const sampleSpec = { title: 'Veresiye Defteri', description: 'Bakkal müşteri borç takibi' };

function f(path: string, content = ''): ScaffoldFile {
  return { path, content };
}

// ─── Stack detection ──────────────────────────────

describe('ScaffoldEnricher.detectStack', () => {
  const e = new ScaffoldEnricher();

  it('detects node-npm from package.json (no lockfile)', () => {
    assert.equal(e.detectStack([f('package.json', '{}'), f('src/index.js')]), 'node-npm');
  });

  it('detects node-npm from package.json + package-lock.json', () => {
    assert.equal(
      e.detectStack([f('package.json', '{}'), f('package-lock.json', '{}')]),
      'node-npm',
    );
  });

  it('detects node-pnpm from package.json + pnpm-lock.yaml', () => {
    assert.equal(
      e.detectStack([f('package.json', '{}'), f('pnpm-lock.yaml', 'lockfileVersion: 9.0')]),
      'node-pnpm',
    );
  });

  it('detects node-yarn from package.json + yarn.lock', () => {
    assert.equal(
      e.detectStack([f('package.json', '{}'), f('yarn.lock', '# yarn lockfile')]),
      'node-yarn',
    );
  });

  it('detects python-pip from requirements.txt', () => {
    assert.equal(
      e.detectStack([f('requirements.txt', 'flask==3.0\n'), f('main.py', 'print("hi")')]),
      'python-pip',
    );
  });

  it('detects python-poetry from pyproject.toml with [tool.poetry] section', () => {
    const py = f(
      'pyproject.toml',
      '[tool.poetry]\nname = "veresiye"\nversion = "0.1.0"\n',
    );
    assert.equal(e.detectStack([py, f('main.py')]), 'python-poetry');
  });

  it('detects python-pip from pyproject.toml without poetry section', () => {
    const py = f('pyproject.toml', '[project]\nname = "veresiye"\n');
    assert.equal(e.detectStack([py, f('main.py')]), 'python-pip');
  });

  it('detects go from go.mod', () => {
    assert.equal(e.detectStack([f('go.mod', 'module foo\ngo 1.22\n'), f('main.go')]), 'go');
  });

  it('detects rust from Cargo.toml', () => {
    assert.equal(
      e.detectStack([f('Cargo.toml', '[package]\nname = "veresiye"\n'), f('src/main.rs')]),
      'rust',
    );
  });

  it('detects static from HTML/CSS/JS only', () => {
    assert.equal(
      e.detectStack([f('index.html', '<html></html>'), f('style.css', 'body{}'), f('app.js', '//')]),
      'static',
    );
  });

  it('returns unknown for ambiguous file sets', () => {
    assert.equal(e.detectStack([f('Makefile', 'all:\n\tgcc main.c'), f('main.c')]), 'unknown');
  });

  it('returns unknown for empty file set', () => {
    assert.equal(e.detectStack([]), 'unknown');
  });
});

// ─── install.sh template ──────────────────────────

describe('ScaffoldEnricher.enrich → install.sh', () => {
  const e = new ScaffoldEnricher();

  it('adds install.sh for node-npm with set -euo pipefail and AKIS header', () => {
    const out = e.enrich([f('package.json', '{}')], sampleSpec);
    const sh = out.find((x) => x.path === 'install.sh');
    assert.ok(sh, 'install.sh should be added');
    assert.match(sh.content, /^#!\/usr\/bin\/env bash/m);
    assert.match(sh.content, /Bu komut dosyası AKIS tarafından üretildi/);
    assert.match(sh.content, /set -euo pipefail/);
    assert.match(sh.content, /npm install/);
    assert.match(sh.content, /npm run dev/);
  });

  it('uses pnpm commands for node-pnpm', () => {
    const out = e.enrich([f('package.json', '{}'), f('pnpm-lock.yaml', '')], sampleSpec);
    const sh = out.find((x) => x.path === 'install.sh');
    assert.ok(sh);
    assert.match(sh.content, /pnpm install/);
    assert.match(sh.content, /pnpm dev/);
  });

  it('uses yarn commands for node-yarn', () => {
    const out = e.enrich([f('package.json', '{}'), f('yarn.lock', '')], sampleSpec);
    const sh = out.find((x) => x.path === 'install.sh');
    assert.ok(sh);
    assert.match(sh.content, /yarn install/);
    assert.match(sh.content, /yarn dev/);
  });

  it('uses venv + pip for python-pip', () => {
    const out = e.enrich([f('requirements.txt', 'flask\n'), f('main.py')], sampleSpec);
    const sh = out.find((x) => x.path === 'install.sh');
    assert.ok(sh);
    assert.match(sh.content, /python3 -m venv \.venv/);
    assert.match(sh.content, /pip install -r requirements\.txt/);
  });

  it('uses poetry for python-poetry', () => {
    const py = f('pyproject.toml', '[tool.poetry]\nname = "x"\n');
    const out = e.enrich([py], sampleSpec);
    const sh = out.find((x) => x.path === 'install.sh');
    assert.ok(sh);
    assert.match(sh.content, /poetry install/);
  });

  it('uses go build for go', () => {
    const out = e.enrich([f('go.mod', 'module x\n')], sampleSpec);
    const sh = out.find((x) => x.path === 'install.sh');
    assert.ok(sh);
    assert.match(sh.content, /go build/);
  });

  it('uses cargo for rust', () => {
    const out = e.enrich([f('Cargo.toml', '[package]\nname = "x"\n')], sampleSpec);
    const sh = out.find((x) => x.path === 'install.sh');
    assert.ok(sh);
    assert.match(sh.content, /cargo build/);
    assert.match(sh.content, /cargo run/);
  });

  it('uses python http.server for static', () => {
    const out = e.enrich([f('index.html', '<html></html>'), f('app.js', '//')], sampleSpec);
    const sh = out.find((x) => x.path === 'install.sh');
    assert.ok(sh);
    assert.match(sh.content, /python3 -m http\.server 8000/);
  });

  it('skips install.sh for unknown stack', () => {
    const out = e.enrich([f('Makefile', 'all:\n\tgcc main.c'), f('main.c')], sampleSpec);
    assert.equal(
      out.find((x) => x.path === 'install.sh'),
      undefined,
      'install.sh should NOT be added for unknown stacks',
    );
  });

  it('preserves AI-supplied install.sh (does not overwrite)', () => {
    const aiInstall = '#!/usr/bin/env bash\n# AI custom install\nmake build\n';
    const out = e.enrich(
      [f('package.json', '{}'), f('install.sh', aiInstall)],
      sampleSpec,
    );
    const sh = out.find((x) => x.path === 'install.sh');
    assert.equal(sh?.content, aiInstall, 'should keep AI version untouched');
  });
});

// ─── README sections ──────────────────────────────

describe('ScaffoldEnricher.enrich → README.md', () => {
  const e = new ScaffoldEnricher();

  it('creates README with all three Turkish sections when none exists', () => {
    const out = e.enrich([f('package.json', '{}')], sampleSpec);
    const readme = out.find((x) => x.path === 'README.md');
    assert.ok(readme, 'README.md should be created');
    assert.match(readme.content, /# Veresiye Defteri/);
    assert.match(readme.content, /## Bu projeyi kendi bilgisayarında çalıştır/);
    assert.match(readme.content, /## Sunucuya kur/);
    assert.match(readme.content, /## GitHub'da gör/);
  });

  it('appends bakkal sections to existing README without overwriting', () => {
    const existing = '# My Project\nA cool app.\n';
    const out = e.enrich(
      [f('package.json', '{}'), f('README.md', existing)],
      sampleSpec,
    );
    const readme = out.find((x) => x.path === 'README.md');
    assert.ok(readme);
    assert.ok(readme.content.startsWith('# My Project'), 'original heading kept');
    assert.match(readme.content, /A cool app\./);
    assert.match(readme.content, /## Bu projeyi kendi bilgisayarında çalıştır/);
    assert.match(readme.content, /## Sunucuya kur/);
    assert.match(readme.content, /## GitHub'da gör/);
  });

  it('is idempotent — re-enriching does not duplicate sections', () => {
    const first = e.enrich([f('package.json', '{}')], sampleSpec);
    const second = e.enrich(first, sampleSpec);
    const readme = second.find((x) => x.path === 'README.md');
    assert.ok(readme);
    const occurrences = readme.content.match(/## Bu projeyi kendi bilgisayarında çalıştır/g);
    assert.equal(occurrences?.length, 1, 'section should appear exactly once after double enrichment');
  });

  it('mentions docker compose in server section for docker-capable stacks', () => {
    const out = e.enrich([f('package.json', '{}')], sampleSpec);
    const readme = out.find((x) => x.path === 'README.md');
    assert.ok(readme);
    assert.match(readme.content, /docker compose up/);
  });

  it('mentions hosting (Netlify/Vercel) for static stack', () => {
    const out = e.enrich(
      [f('index.html', '<html></html>'), f('app.js', '//')],
      sampleSpec,
    );
    const readme = out.find((x) => x.path === 'README.md');
    assert.ok(readme);
    assert.match(readme.content, /Netlify|Vercel|GitHub Pages/);
  });

  it('uses bakkal-language (no "repo" / "PR" / "branch")', () => {
    const out = e.enrich([f('package.json', '{}')], sampleSpec);
    const readme = out.find((x) => x.path === 'README.md');
    assert.ok(readme);
    // Must NOT contain raw English jargon in user-facing prose.
    assert.doesNotMatch(readme.content, /\brepository\b/i);
    assert.doesNotMatch(readme.content, /\bpull request\b/i);
  });
});

// ─── .env.example ─────────────────────────────────

describe('ScaffoldEnricher.enrich → .env.example', () => {
  const e = new ScaffoldEnricher();

  it('adds .env.example with Turkish per-line comments', () => {
    const out = e.enrich([f('package.json', '{}')], sampleSpec);
    const envExample = out.find((x) => x.path === '.env.example');
    assert.ok(envExample, '.env.example should be added');
    assert.match(envExample.content, /# bu değer:/);
    assert.match(envExample.content, /PORT=/);
    assert.match(envExample.content, /OPENAI_API_KEY=/);
    assert.match(envExample.content, /AUTH_SECRET=/);
  });

  it('mentions OpenAI API-key source link', () => {
    const out = e.enrich([f('requirements.txt', '')], sampleSpec);
    const envExample = out.find((x) => x.path === '.env.example');
    assert.ok(envExample);
    assert.match(envExample.content, /platform\.openai\.com/);
  });

  it('uses port 8000 for python stacks, 8080 for go/rust, 3000 default', () => {
    const py = e.enrich([f('requirements.txt', '')], sampleSpec);
    const goOut = e.enrich([f('go.mod', 'module x\n')], sampleSpec);
    const node = e.enrich([f('package.json', '{}')], sampleSpec);
    assert.match(py.find((x) => x.path === '.env.example')!.content, /PORT=8000/);
    assert.match(goOut.find((x) => x.path === '.env.example')!.content, /PORT=8080/);
    assert.match(node.find((x) => x.path === '.env.example')!.content, /PORT=3000/);
  });

  it('preserves AI-supplied .env.example (does not overwrite)', () => {
    const aiEnv = 'CUSTOM_AI_VAR=value\n';
    const out = e.enrich(
      [f('package.json', '{}'), f('.env.example', aiEnv)],
      sampleSpec,
    );
    assert.equal(out.find((x) => x.path === '.env.example')?.content, aiEnv);
  });
});

// ─── Dockerfile + docker-compose.yml ──────────────

describe('ScaffoldEnricher.enrich → Docker', () => {
  const e = new ScaffoldEnricher();

  it('adds Dockerfile + docker-compose.yml for node by default', () => {
    const out = e.enrich([f('package.json', '{}')], sampleSpec);
    assert.ok(out.find((x) => x.path === 'Dockerfile'));
    assert.ok(out.find((x) => x.path === 'docker-compose.yml'));
  });

  it('uses multi-stage Node Dockerfile (FROM ... AS builder + AS runner)', () => {
    const out = e.enrich([f('package.json', '{}')], sampleSpec);
    const docker = out.find((x) => x.path === 'Dockerfile');
    assert.ok(docker);
    assert.match(docker.content, /FROM node:20-alpine AS builder/);
    assert.match(docker.content, /FROM node:20-alpine AS runner/);
  });

  // F-08 review fix #1: Node Dockerfile must (a) drop `|| true` so build
  // failures are visible, and (b) pick a CMD that works for the actual
  // scaffold's package.json. The previous CMD `[<pm>, "start"]` produced a
  // container that exited immediately on Vite scaffolds (no `start` script).
  it('Node Dockerfile build step does not swallow failures (no `|| true`)', () => {
    const out = e.enrich([f('package.json', '{}')], sampleSpec);
    const docker = out.find((x) => x.path === 'Dockerfile');
    assert.ok(docker);
    // Old behaviour was `RUN <pm> run build || true` — assert it's gone.
    assert.doesNotMatch(docker.content, /run build \|\| true/);
    assert.match(docker.content, /RUN (npm|pnpm|yarn) run build\b/);
  });

  it('Node Dockerfile CMD targets `start` when package.json declares it', () => {
    const pkg = JSON.stringify({
      name: 'app',
      scripts: { start: 'node server.js', dev: 'nodemon server.js' },
    });
    const out = e.enrich([f('package.json', pkg)], sampleSpec);
    const docker = out.find((x) => x.path === 'Dockerfile');
    assert.ok(docker);
    assert.match(docker.content, /CMD \["npm", "start"\]/);
    assert.doesNotMatch(docker.content, /run preview/);
  });

  it('Node Dockerfile CMD falls back to `preview` for Vite scaffolds (no `start`)', () => {
    // The AKIS reference scaffold — React + Vite — has `dev` and `preview`
    // but no `start`. The previous default CMD ["npm","start"] would fail
    // immediately. The fix uses `preview` for this case.
    const pkg = JSON.stringify({
      name: 'app',
      scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    });
    const out = e.enrich([f('package.json', pkg)], sampleSpec);
    const docker = out.find((x) => x.path === 'Dockerfile');
    assert.ok(docker);
    assert.match(docker.content, /CMD \["npm", "run", "preview"\]/);
    assert.doesNotMatch(docker.content, /CMD \["npm", "start"\]/);
  });

  it('Node Dockerfile CMD falls back to `serve dist` when neither start nor preview exists', () => {
    const pkg = JSON.stringify({
      name: 'app',
      scripts: { dev: 'vite', build: 'vite build' }, // no start, no preview
    });
    const out = e.enrich([f('package.json', pkg)], sampleSpec);
    const docker = out.find((x) => x.path === 'Dockerfile');
    assert.ok(docker);
    assert.match(docker.content, /RUN npm install -g serve/);
    assert.match(docker.content, /CMD \["serve", "dist", "-l", "3000"\]/);
  });

  it('Node Dockerfile CMD respects pnpm package manager when start is present', () => {
    const pkg = JSON.stringify({
      name: 'app',
      scripts: { start: 'node server.js' },
    });
    const out = e.enrich(
      [f('package.json', pkg), f('pnpm-lock.yaml', 'lockfileVersion: 9.0')],
      sampleSpec,
    );
    const docker = out.find((x) => x.path === 'Dockerfile');
    assert.ok(docker);
    assert.match(docker.content, /CMD \["pnpm", "start"\]/);
  });

  it('uses python:3.12-slim for python-pip Dockerfile', () => {
    const out = e.enrich(
      [f('requirements.txt', ''), f('main.py', 'pass')],
      sampleSpec,
    );
    const docker = out.find((x) => x.path === 'Dockerfile');
    assert.ok(docker);
    assert.match(docker.content, /FROM python:3\.12-slim/);
  });

  it('uses multi-stage Go Dockerfile', () => {
    const out = e.enrich([f('go.mod', 'module x\n'), f('main.go')], sampleSpec);
    const docker = out.find((x) => x.path === 'Dockerfile');
    assert.ok(docker);
    assert.match(docker.content, /FROM golang.*AS builder/);
    assert.match(docker.content, /FROM alpine/);
  });

  it('uses multi-stage Rust Dockerfile', () => {
    const out = e.enrich([f('Cargo.toml', '[package]\nname="x"\n')], sampleSpec);
    const docker = out.find((x) => x.path === 'Dockerfile');
    assert.ok(docker);
    assert.match(docker.content, /FROM rust.*AS builder/);
    assert.match(docker.content, /FROM debian/);
  });

  it('skips Dockerfile when generateDockerfile=false', () => {
    const out = e.enrich(
      [f('package.json', '{}')],
      sampleSpec,
      { generateDockerfile: false },
    );
    assert.equal(out.find((x) => x.path === 'Dockerfile'), undefined);
    assert.equal(out.find((x) => x.path === 'docker-compose.yml'), undefined);
  });

  it('skips Docker for static stack', () => {
    const out = e.enrich(
      [f('index.html', '<html></html>'), f('app.js', '//')],
      sampleSpec,
    );
    assert.equal(out.find((x) => x.path === 'Dockerfile'), undefined);
    assert.equal(out.find((x) => x.path === 'docker-compose.yml'), undefined);
  });

  it('skips Docker for unknown stack', () => {
    const out = e.enrich(
      [f('Makefile', 'all:'), f('main.c', '/* */')],
      sampleSpec,
    );
    assert.equal(out.find((x) => x.path === 'Dockerfile'), undefined);
  });

  it('compose service name is derived from spec.title (kebab-case)', () => {
    const out = e.enrich([f('package.json', '{}')], { title: 'Veresiye Defteri Pro!' });
    const compose = out.find((x) => x.path === 'docker-compose.yml');
    assert.ok(compose);
    assert.match(compose.content, /veresiye-defteri-pro:/);
  });
});

// ─── Unknown stack — README-only path ─────────────

describe('ScaffoldEnricher.enrich → unknown stack graceful skip', () => {
  const e = new ScaffoldEnricher();

  it('produces README + .env.example only for unknown stacks', () => {
    const out = e.enrich(
      [f('Makefile', 'all:'), f('main.c', '/* */')],
      sampleSpec,
    );
    assert.ok(out.find((x) => x.path === 'README.md'), 'README still produced');
    assert.ok(out.find((x) => x.path === '.env.example'), '.env.example still produced');
    assert.equal(
      out.find((x) => x.path === 'install.sh'),
      undefined,
      'install.sh skipped',
    );
    assert.equal(
      out.find((x) => x.path === 'Dockerfile'),
      undefined,
      'Dockerfile skipped',
    );
  });

  it('README guidance for unknown stacks tells user to follow stack-specific steps', () => {
    const out = e.enrich(
      [f('Makefile', 'all:'), f('main.c', '/* */')],
      sampleSpec,
    );
    const readme = out.find((x) => x.path === 'README.md');
    assert.ok(readme);
    assert.match(readme.content, /otomatik kurulum hazırlanamadı/);
  });
});

// ─── Bridge helpers ───────────────────────────────

describe('toScaffoldFile / fromScaffoldFile bridges', () => {
  it('converts Proto-shape file (filePath) to ScaffoldFile (path)', () => {
    const proto = { filePath: 'src/index.ts', content: 'export {};', linesOfCode: 1 };
    const scaffold = toScaffoldFile(proto);
    assert.equal(scaffold.path, 'src/index.ts');
    assert.equal(scaffold.content, 'export {};');
  });

  it('converts ScaffoldFile back to Proto shape with recomputed line count', () => {
    const scaffold: ScaffoldFile = { path: 'a.txt', content: 'line1\nline2\nline3' };
    const proto = fromScaffoldFile(scaffold);
    assert.equal(proto.filePath, 'a.txt');
    assert.equal(proto.linesOfCode, 3);
  });
});
