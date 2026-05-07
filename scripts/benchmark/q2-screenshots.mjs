#!/usr/bin/env node
/**
 * Q2 self-pilot screenshot generator.
 *
 * For each of the 5 baseline-benchmark pipelines, captures two
 * screenshots in the same browser context:
 *   - <pipelineId>-A.png  (baseline=1, rail hidden)
 *   - <pipelineId>-B.png  (rail visible)
 *
 * The two screenshots are identical except for the Level-4 rail. They
 * are the source material for the Likert A/B form so participants can
 * compare like-for-like.
 *
 * Output: docs/dogfooding/q2-pairs/<problem>-<A|B>.png
 *
 * Pre-req:
 *   - Backend + frontend running (./scripts/dev-up.sh)
 *   - The 5 benchmark pipelines from PR #507 still exist in awaiting_approval
 */

import { chromium } from '/Users/omeryasironal/Projects/akis-platform/frontend/node_modules/.pnpm/playwright@1.57.0/node_modules/playwright/index.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, '..', '..');
const OUT = resolve(REPO, 'docs', 'dogfooding', 'q2-pairs');
mkdirSync(OUT, { recursive: true });

const FRONTEND = process.env.FRONTEND_URL ?? 'http://localhost:5173';
const PASSWORD = 'BenchTest123!';

// Auto-load PIPELINES from the most recent benchmark results JSON. The
// in-memory ExplainabilityService and activity buffer don't survive a
// dev restart, so we always want the freshest pipelines (created right
// before this script ran) — not stale IDs hard-coded in source.
function loadLatestPipelines() {
  const dir = resolve(REPO, 'docs', 'dogfooding');
  const files = readdirSync(dir)
    .filter((f) => /^results-.*\.json$/.test(f))
    .sort();
  if (files.length === 0) {
    throw new Error(
      'No results-*.json found. Run scripts/benchmark/run.mjs first.',
    );
  }
  const latest = resolve(dir, files[files.length - 1]);
  console.log(`▶ source: ${files[files.length - 1]}`);
  const report = JSON.parse(readFileSync(latest, 'utf8'));
  return report.results
    .filter((r) => r.pipelineId && r.finalStage === 'awaiting_approval')
    .map((r) => ({
      id: r.pipelineId,
      // owner email is encoded in the runner — bench+<label>+<ts>@akis.local
      // We don't have it in the report; fetch from DB.
      email: null, // resolved below
      problemId: r.problemId,
    }));
}

function resolveOwnerEmails(pipelines) {
  const ids = pipelines.map((p) => `'${p.id}'`).join(',');
  const sql = `SELECT p.id::text || '|' || u.email FROM pipelines p JOIN users u ON p.user_id = u.id WHERE p.id IN (${ids});`;
  const rows = execSync(
    `PGPASSWORD=postgres psql -h localhost -p 5433 -U postgres -d akis_v2 -tAc "${sql}"`,
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n');
  const map = new Map();
  for (const row of rows) {
    const [id, email] = row.split('|');
    if (id && email) map.set(id, email);
  }
  for (const p of pipelines) p.email = map.get(p.id) ?? null;
  return pipelines.filter((p) => p.email);
}

const PIPELINES = resolveOwnerEmails(loadLatestPipelines());

async function loginCookie(email) {
  const res = await fetch('http://localhost:3000/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${email}: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  return /akis_sid=([^;]+)/.exec(setCookie)?.[1] ?? null;
}

async function snap(page, label) {
  const path = resolve(OUT, `${label}.png`);
  // fullPage so we capture everything below the fold — including the
  // approval gate buttons + composer. Viewport-only screenshots crop
  // these out asymmetrically (the rail eats ~270px at the top of B
  // but not A), which biases A/B comparison for participants. The
  // form's CSS clamps the displayed image height so layout stays sane.
  await page.screenshot({ path, fullPage: true });
  return path;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  for (const pipe of PIPELINES) {
    console.log(`▶ ${pipe.problemId} (${pipe.id.slice(0, 8)})`);
    const ctx = await browser.newContext({
      // Tall viewport so the chat panel's inner scroll container can fit
      // ALL content (rail in B condition + user message + Proje Planı +
      // Onayla button + composer) without internal scrolling. fullPage
      // does not expand inner overflow-y-auto containers; a tall
      // viewport bypasses the issue cleanly.
      viewport: { width: 1400, height: 2000 },
      locale: 'tr-TR',
    });
    const page = await ctx.newPage();
    const sid = await loginCookie(pipe.email);
    if (!sid) {
      console.log(`  ✗ login failed`);
      await ctx.close();
      continue;
    }
    await ctx.addCookies([
      {
        name: 'akis_sid',
        value: sid,
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    // ─── B: with rail (default) ─────────────────────────────
    await page.goto(`${FRONTEND}/chat/${pipe.id}?baseline=0`, {
      waitUntil: 'networkidle',
    });
    await page.waitForTimeout(1200);
    // Dismiss the GitHub-connect modal if present
    const dismiss = page.getByRole('button', { name: /Şimdi değil|Not now/i });
    if (await dismiss.count()) {
      await dismiss.first().click();
      await page.waitForTimeout(400);
    }
    // The rail auto-opens to Açıklama tab in awaiting_approval — that's
    // the highest-information condition, ideal for A/B comparison.
    await page.waitForTimeout(800);
    await snap(page, `${pipe.problemId}-B-explainable`);
    console.log(`  ✓ B captured`);

    // ─── A: baseline (rail hidden) ──────────────────────────
    await page.goto(`${FRONTEND}/chat/${pipe.id}?baseline=1`, {
      waitUntil: 'networkidle',
    });
    await page.waitForTimeout(800);
    await snap(page, `${pipe.problemId}-A-baseline`);
    console.log(`  ✓ A captured`);

    await ctx.close();
  }
  await browser.close();
  console.log(`\n📸 10 screenshots → ${OUT}/`);
  // Quick sanity-list
  execSync(`ls -1 ${OUT}/`, { stdio: 'inherit' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
