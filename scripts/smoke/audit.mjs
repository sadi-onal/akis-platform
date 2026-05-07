#!/usr/bin/env node
/**
 * ChatPanel visual audit — captures the chat surface in several states
 * for a side-by-side review. Sidebar collapse + composer focus + chat
 * mode toggle + sidebar empty + sidebar populated.
 *
 * Output goes to docs/dogfooding/screenshots/ with the prefix `audit-`.
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
const EMAIL = `audit+${Date.now()}@akis.local`;
const PASSWORD = 'AuditTest123!';
const NAME = 'Audit Tester';

function log(...args) {
  console.log(`[audit ${new Date().toISOString().slice(11, 19)}]`, ...args);
}

async function shot(page, label) {
  const path = resolve(SHOTS, `audit-${STAMP}-${label}.png`);
  await page.screenshot({ path, fullPage: false });
  log(`📸 ${label}`);
  return path;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: 'tr-TR',
  });
  const page = await ctx.newPage();

  // 1. signup + activate + login
  const signup = await fetch('http://localhost:3000/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: NAME }),
  });
  if (!signup.ok) throw new Error(`signup: ${signup.status}`);
  const { execSync } = await import('node:child_process');
  execSync(
    `PGPASSWORD=postgres psql -h localhost -p 5433 -U postgres -d akis_v2 -c "UPDATE users SET status='active' WHERE email = '${EMAIL}';" >/dev/null`,
  );
  const login = await fetch('http://localhost:3000/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const setCookie = login.headers.get('set-cookie') ?? '';
  const sid = /akis_sid=([^;]+)/.exec(setCookie)?.[1];
  await ctx.addCookies([
    { name: 'akis_sid', value: sid, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' },
  ]);

  // 2. /chat empty (no conversations)
  await page.goto(`${FRONTEND}/chat`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const dismiss = page.getByRole('button', { name: /Şimdi değil|Not now/i });
  if (await dismiss.count()) await dismiss.first().click();
  await page.waitForTimeout(400);
  await shot(page, '01-chat-empty-sidebar-empty');

  // 3. Open new chat panel — composer in pristine state
  const startBtn = page.getByRole('button', { name: /Yeni Sohbet Başlat/i }).first();
  if (await startBtn.count()) await startBtn.click();
  await page.waitForTimeout(500);
  await shot(page, '02-new-chat-composer-empty');

  // 4. Mode toggle states — header has Plan/Act/Ask/Review
  for (const mode of ['ask', 'plan', 'act', 'review']) {
    const btn = page.getByRole('button', { name: new RegExp(`^${mode}$`, 'i') });
    if (await btn.count()) {
      await btn.first().click().catch(() => {});
      await page.waitForTimeout(200);
      await shot(page, `03-mode-${mode}`);
    }
  }

  // 5. Composer with text
  const composer = page
    .locator(
      'main textarea, textarea[placeholder*="anlat" i], textarea[placeholder*="Projenizi" i]',
    )
    .first();
  if (await composer.count()) {
    await composer.click();
    await composer.fill(
      'Bir not alma uygulaması istiyorum. Tarayıcıda çalışsın, localStorage kullansın, görevleri kategorilere ayırabileyim.',
    );
    await shot(page, '04-composer-with-text');
  }

  // 6. Submit and capture running state
  await composer.press('Enter');
  await page.waitForTimeout(2500);
  await shot(page, '05-pipeline-running-with-rail');

  // 7. Wait until terminal + capture failed/completed state. Real
  // Anthropic runs can take 1–3 min for Scribe + Critic-spec; mock runs
  // are < 5 s. Cap at 4 min so a stuck run doesn't block the audit.
  const start = Date.now();
  let lastShotAt = 0;
  while (Date.now() - start < 4 * 60 * 1000) {
    const railBody = await page
      .locator('[aria-label="Pipeline detayı"]')
      .innerText()
      .catch(() => '');
    // Snap an interim screenshot every 30 s so we can see progression
    // even if the pipeline is still running when the timeout hits.
    const elapsed = Date.now() - start;
    if (elapsed - lastShotAt > 30000) {
      lastShotAt = elapsed;
      await shot(page, `progress-${Math.round(elapsed / 1000)}s`);
    }
    const approveBtnCount = await page
      .locator('button')
      .filter({ hasText: /Onayla|Approve/i })
      .count();
    if (
      /başarısız|failed|completed|tamamland|onay/i.test(railBody) ||
      (await page.locator('text=Yeniden Dene').count()) > 0 ||
      approveBtnCount > 0
    ) {
      break;
    }
    await page.waitForTimeout(2500);
  }
  await shot(page, '06-after-terminal-state');

  // 8. Collapse the rail
  const railToggle = page.getByRole('button', { name: /Pipeline detayı/ });
  if (await railToggle.count()) {
    await railToggle.first().click();
    await page.waitForTimeout(300);
    await shot(page, '07-rail-collapsed');
  }

  // 9. Sidebar collapse
  const sidebarToggle = page
    .locator('button[aria-label*="kenar" i], button[title*="Sidebar" i], button:has-text("«")')
    .last();
  if (await sidebarToggle.count()) {
    await sidebarToggle.click().catch(() => {});
    await page.waitForTimeout(300);
    await shot(page, '08-sidebar-collapsed');
  }

  await browser.close();
  log('done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
