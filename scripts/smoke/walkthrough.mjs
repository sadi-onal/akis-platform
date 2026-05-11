#!/usr/bin/env node
/**
 * AKIS Level-4 surface smoke walkthrough.
 *
 * Drives the frontend at :5173 with Playwright:
 *   1. Sign up a fresh test user (mock email so no verification is needed).
 *   2. Type an idea, submit.
 *   3. Wait until Scribe finishes — pipeline reaches awaiting_approval
 *      (mock provider so this is fast and deterministic).
 *   4. Capture screenshots of the new PipelineDetailRail in BOTH tabs
 *      (Açıklama + Akış).
 *
 * Output: docs/dogfooding/screenshots/<stamp>-*.png
 *
 * Usage:
 *   node scripts/smoke/walkthrough.mjs
 *
 * Pre-req: ./scripts/dev-up.sh has booted backend (:3000) + frontend (:5173).
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
const PIPELINE_TIMEOUT = 90 * 1000;
const EMAIL = `smoke+${Date.now()}@akis.local`;
const PASSWORD = 'SmokeTest123!';
const NAME = 'Smoke Tester';

function log(...args) {
  console.log(`[smoke ${new Date().toISOString().slice(11, 19)}]`, ...args);
}

async function shot(page, label) {
  const path = resolve(SHOTS, `${STAMP}-${label}.png`);
  await page.screenshot({ path, fullPage: true });
  log(`📸 ${label} → ${path}`);
  return path;
}

async function main() {
  log(`booting browser; frontend=${FRONTEND}, email=${EMAIL}`);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: 'tr-TR',
  });
  const page = await ctx.newPage();
  page.on('pageerror', (err) => log('!! pageerror', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') log('!! console.error', msg.text());
  });

  try {
    // 1. Land on home, take baseline shot
    await page.goto(FRONTEND, { waitUntil: 'networkidle' });
    await shot(page, '01-landing');

    // 2. Sign up via API (use the fact that backend EMAIL_PROVIDER=mock
    //    means accounts skip verification). Doing it via API + then
    //    setting cookie in the browser context is more deterministic
    //    than driving the multi-step wizard which has rate limits.
    log('signing up via /auth/signup');
    const signup = await fetch('http://localhost:3000/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: NAME }),
    });
    if (!signup.ok) throw new Error(`signup failed: ${signup.status} ${await signup.text()}`);
    log(`signup ok`);

    // Activate the test user directly — local dev path bypasses email
    // verification (EMAIL_PROVIDER=mock) but the row still lands as
    // pending_verification, which requireAuth rejects.
    const { execSync } = await import('node:child_process');
    execSync(
      `PGPASSWORD=postgres psql -h localhost -p 5433 -U postgres -d akis_v2 -c "UPDATE users SET status='active' WHERE email = '${EMAIL}';" >/dev/null`
    );
    log('user force-activated');

    // Re-login to get a fresh cookie tied to the activated user.
    const login = await fetch('http://localhost:3000/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
    const setCookie = login.headers.get('set-cookie') ?? '';
    const sid = /akis_sid=([^;]+)/.exec(setCookie)?.[1];
    if (!sid) throw new Error('no akis_sid cookie returned by login');
    log(`login ok; sid len=${sid.length}`);

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

    // 3. Reload — should now be authenticated
    await page.goto(FRONTEND, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await shot(page, '02-authenticated-home');

    // 4. Find a "new chat" route — try direct navigation
    log('navigating to /chat');
    await page.goto(`${FRONTEND}/chat`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await shot(page, '03-chat-empty');

    // Dismiss the GitHub-connect modal that pops up on first chat visit.
    const dismissBtn = page.getByRole('button', { name: /Şimdi değil|Not now/i });
    if (await dismissBtn.count()) {
      await dismissBtn.first().click();
      await page.waitForTimeout(400);
      log('GitHub-connect modal dismissed');
    }

    // 5. Click "+ Yeni Sohbet Başlat" so a pending conversation panel opens
    //    with its real composer. Without this, the only "input" on screen
    //    is the sidebar's chat search.
    const startBtn = page
      .getByRole('button', { name: /Yeni Sohbet Başlat/i })
      .first();
    if (await startBtn.count()) {
      await startBtn.click();
      await page.waitForTimeout(600);
      log('opened new chat panel');
      await shot(page, '04-new-chat-empty');
    }

    // 6. Find the composer textarea inside the chat panel. The sidebar has
    //    a small input we want to skip — scope by visible textarea + role.
    const idea =
      'Tek kullanıcılı tarayıcı tabanlı not alma uygulaması istiyorum. localStorage kullansın.';
    const composer = page.locator('main textarea, [data-testid="chat-input"] textarea, textarea[placeholder*="anlat" i], textarea[placeholder*="Projenizi" i]').first();
    await composer.waitFor({ state: 'visible', timeout: 10000 });
    await composer.click();
    await composer.fill(idea);
    await shot(page, '05-idea-typed');

    // 7. Submit — try Enter, fall back to a send button
    await composer.press('Enter');
    await page.waitForTimeout(800);
    log('idea submitted');

    // 7. Wait until pipeline reaches awaiting_approval — this is when the
    //    rail's Açıklama tab auto-activates. With mock provider this is
    //    typically <30s; we cap at 90s.
    const start = Date.now();
    let reachedApproval = false;
    while (Date.now() - start < PIPELINE_TIMEOUT) {
      const railText = await page
        .locator('[aria-label="Pipeline detayı"]')
        .first()
        .innerText()
        .catch(() => '');
      const hasApprovalSignal =
        railText.includes('Açıklama') &&
        railText.toLowerCase().includes('spec');
      const approveBtn = await page
        .locator('button')
        .filter({ hasText: /Onayla|Approve/i })
        .count();
      if (hasApprovalSignal || approveBtn > 0) {
        reachedApproval = true;
        break;
      }
      await page.waitForTimeout(2000);
    }

    log(`reachedApproval=${reachedApproval} after ${(Date.now() - start) / 1000}s`);

    // 8. Capture the rail in whatever state we got to
    await shot(page, reachedApproval ? '06-awaiting-approval' : '06-pipeline-running');

    // 9. Try to switch to Akış tab to capture cinema view
    const flowTab = page.getByRole('tab', { name: 'Akış' });
    if (await flowTab.count()) {
      await flowTab.first().click();
      await page.waitForTimeout(500);
      await shot(page, '07-rail-flow-tab');
    }

    // 10. Switch to Açıklama
    const whyTab = page.getByRole('tab', { name: 'Açıklama' });
    if (await whyTab.count()) {
      await whyTab.first().click();
      await page.waitForTimeout(800);
      await shot(page, '08-rail-why-tab');
    }

    // 11. Regresyon tab (PDP-2 / F-04 + F-11) — visible when pipeline has outputs.
    const regressionTab = page.getByRole('tab', { name: 'Regresyon' });
    if (await regressionTab.count()) {
      await regressionTab.first().click();
      await page.waitForTimeout(800);
      await shot(page, '09-rail-regression-tab');
    } else {
      log('regression tab not yet visible (pipeline not yet completed) — OK');
    }

    // 12. PDP-2 / F-10 intent disambiguation — type ambiguous word, expect modal.
    log('=== PDP-2: intent disambiguation smoke ===');
    try {
      const newChatBtn = page.getByRole('button', { name: /Yeni Sohbet/i }).first();
      if (await newChatBtn.count()) {
        await newChatBtn.click();
        await page.waitForTimeout(500);
        const input2 = page.getByRole('textbox').last();
        await input2.fill('rapor');
        await input2.press('Enter');
        await page.waitForTimeout(1500);
        const modal = page.getByText(/Bunu nasıl yapayım/i);
        if (await modal.count()) {
          await shot(page, '10-intent-disambiguation-modal');
          const cancel = page.getByRole('button', { name: /Vazgeç/i });
          if (await cancel.count()) await cancel.first().click();
        } else {
          log('disambiguation modal did not surface — intent confidence too high for "rapor"');
        }
      }
    } catch (err) {
      log('disambiguation smoke step soft-failed: ' + err.message);
    }

    // 13. PDP-2 / F-09 chat-qa SSE — pipeline-free Q&A.
    log('=== PDP-2: chat-qa SSE smoke ===');
    try {
      const sidebarFirst = page.getByRole('button').filter({ hasText: /Sohbet|Bakkal|Stok/i }).first();
      if (await sidebarFirst.count()) {
        await sidebarFirst.click();
        await page.waitForTimeout(500);
        const input3 = page.getByRole('textbox').last();
        await input3.fill('Bu kod ne kadar büyük olacak?');
        await input3.press('Enter');
        await page.waitForTimeout(3000);
        await shot(page, '11-chat-qa-response');
      }
    } catch (err) {
      log('chat-qa smoke step soft-failed: ' + err.message);
    }

    log('done');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
