#!/usr/bin/env node
/**
 * Inspect an existing awaiting_approval pipeline — open it in the
 * browser and snap screenshots of both rail tabs with real reasoning
 * data populated.
 */

import { chromium } from '/Users/omeryasironal/Projects/akis-platform/frontend/node_modules/.pnpm/playwright@1.57.0/node_modules/playwright/index.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, '..', '..');
const SHOTS = resolve(REPO, 'docs', 'dogfooding', 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const FRONTEND = process.env.FRONTEND_URL ?? 'http://localhost:5173';
const PIPELINE_ID = process.env.PIPELINE_ID ?? '556348fe-a578-4cc2-89bd-383043afb1a2';
const EMAIL = process.env.EMAIL ?? 'audit+1778147887049@akis.local';
const PASSWORD = 'AuditTest123!';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: 'tr-TR',
  });
  const page = await ctx.newPage();

  const login = await fetch('http://localhost:3000/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`login: ${login.status} ${await login.text()}`);
  const sid = /akis_sid=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1];
  await ctx.addCookies([
    { name: 'akis_sid', value: sid, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' },
  ]);

  await page.goto(`${FRONTEND}/chat/${PIPELINE_ID}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  // Dismiss the GitHub-connect modal that pops up on first chat visit.
  const dismiss = page.getByRole('button', { name: /Şimdi değil|Not now/i });
  if (await dismiss.count()) {
    await dismiss.first().click();
    await page.waitForTimeout(400);
  }
  await page.screenshot({
    path: resolve(SHOTS, `inspect-${STAMP}-01-default.png`),
    fullPage: false,
  });

  // Açıklama tab
  const why = page.getByRole('tab', { name: 'Açıklama' });
  if (await why.count()) {
    await why.first().click();
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: resolve(SHOTS, `inspect-${STAMP}-02-aciklama.png`),
      fullPage: false,
    });
    // Expand the first stage's details
    const expand = page.locator('button:has-text("Detayları göster")').first();
    if (await expand.count()) {
      await expand.click();
      await page.waitForTimeout(400);
      await page.screenshot({
        path: resolve(SHOTS, `inspect-${STAMP}-03-aciklama-expanded.png`),
        fullPage: true,
      });
    }
  }

  // Akış tab
  const flow = page.getByRole('tab', { name: 'Akış' });
  if (await flow.count()) {
    await flow.first().click();
    await page.waitForTimeout(800);
    await page.screenshot({
      path: resolve(SHOTS, `inspect-${STAMP}-04-akis.png`),
      fullPage: false,
    });
  }

  console.log(`[inspect] screenshots → ${SHOTS}/inspect-${STAMP}-*.png`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
