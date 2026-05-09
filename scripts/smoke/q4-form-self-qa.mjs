#!/usr/bin/env node
/**
 * Self-QA: open the Q4 rubric form locally with Playwright and snap a few
 * states (top, mid-scroll, bottom, after a click) so the form's actual
 * rendering can be reviewed before sending it to raters.
 *
 * Form fetches q4-specs-snapshot.json — file:// blocks fetch in some
 * browsers, so we serve the dogfooding dir over a tiny in-process HTTP
 * server first.
 */

import { chromium } from '/Users/omeryasironal/Projects/akis-platform/frontend/node_modules/.pnpm/playwright@1.57.0/node_modules/playwright/index.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, '..', '..');
const DOG = resolve(REPO, 'docs', 'dogfooding');
const SHOTS = resolve(DOG, 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const safe = u.pathname.replace(/^\/+/, '').replace(/\.\.\//g, '');
  const path = resolve(DOG, safe || 'q4-rubric-form.html');
  try {
    statSync(path);
    const ext = path.slice(path.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(readFileSync(path));
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

async function shot(page, label) {
  const path = resolve(SHOTS, `q4form-${STAMP}-${label}.png`);
  await page.screenshot({ path, fullPage: false });
  console.log(`📸 ${label}`);
  return path;
}

async function main() {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const url = `http://localhost:${port}/q4-rubric-form.html`;
  console.log(`Serving at ${url}`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: 'tr-TR',
  });
  const page = await ctx.newPage();

  page.on('pageerror', (err) => console.log('[pageerror]', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[console.error]', msg.text());
  });

  await page.goto(url);
  // Wait until snapshot fetch resolves (cards rendered)
  await page.waitForSelector('section.card[data-spec]', { timeout: 5000 });
  await page.waitForTimeout(300);

  await shot(page, '01-top');

  await page.evaluate(() => window.scrollTo({ top: 600 }));
  await page.waitForTimeout(150);
  await shot(page, '02-rubric-criteria');

  await page.evaluate(() => {
    const card = document.querySelectorAll('section.card[data-spec]')[0];
    card?.scrollIntoView({ block: 'start' });
  });
  await page.waitForTimeout(200);
  await shot(page, '03-first-spec');

  // Click a few criteria scores to confirm radio + running total
  const radios = page.locator('section.card[data-spec]:nth-of-type(1) .scale input[type="radio"][value="7"]');
  const count = await radios.count();
  for (let i = 0; i < Math.min(count, 6); i++) {
    await radios.nth(i).click({ force: true });
  }
  await page.waitForTimeout(150);
  await shot(page, '04-after-scoring-first-spec');

  await page.evaluate(() => {
    const cards = document.querySelectorAll('section.card[data-spec]');
    cards[Math.floor(cards.length / 2)]?.scrollIntoView({ block: 'start' });
  });
  await page.waitForTimeout(200);
  await shot(page, '05-mid-spec');

  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight }));
  await page.waitForTimeout(200);
  await shot(page, '06-bottom');

  // Diagnostics
  const dims = await page.evaluate(() => {
    const allCards = document.querySelectorAll('section.card[data-spec]');
    const radioCount = document.querySelectorAll('input[type="radio"]').length;
    const scaleCount = document.querySelectorAll('.scale').length;
    // Make sure no Critic content leaked into DOM
    const html = document.documentElement.outerHTML;
    const leakHits = [
      'criticSpecOutput', 'overallScore', 'approved',
      'critic.confidence', 'Spec onaylandi', 'Spec reddedildi',
    ].filter((k) => html.includes(k));
    return {
      scrollHeight: document.body.scrollHeight,
      specCardCount: allCards.length,
      radioCount,
      scaleCount,
      title: document.title,
      leakHits,
    };
  });
  console.log('\nDIAGNOSTIC:');
  console.log('  scrollHeight    :', dims.scrollHeight, 'px');
  console.log('  spec cards      :', dims.specCardCount, '(expected 5)');
  console.log('  radio count     :', dims.radioCount, '(expected 5 × 6 × 11 = 330)');
  console.log('  .scale groups   :', dims.scaleCount, '(expected 30)');
  console.log('  title           :', dims.title);
  console.log('  Critic leak hits:', dims.leakHits.length === 0 ? '(none ✓)' : dims.leakHits.join(', '));

  await browser.close();
  server.close();
  console.log(`\n✅ Screenshots → ${SHOTS}/q4form-${STAMP}-*.png`);
  if (dims.leakHits.length > 0) {
    console.error('❌ Bias leak: Critic-related strings found in DOM. Fix before shipping.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  server.close();
  process.exit(1);
});
