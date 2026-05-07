#!/usr/bin/env node
/**
 * Self-QA: open the Q2 Likert form locally with Playwright and snap a
 * few states (top, mid-scroll, bottom) so the form's actual rendering
 * can be reviewed before sending it to participants.
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
const FORM_URL = 'file://' + resolve(REPO, 'docs', 'dogfooding', 'q2-likert-form.html');

async function shot(page, label) {
  const path = resolve(SHOTS, `q2form-${STAMP}-${label}.png`);
  await page.screenshot({ path, fullPage: false });
  console.log(`📸 ${label}`);
  return path;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: 'tr-TR',
  });
  const page = await ctx.newPage();

  // Surface any JS errors in the console output.
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[console.error]', msg.text());
  });

  await page.goto(FORM_URL);
  await page.waitForTimeout(800); // give images time to decode

  await shot(page, '01-top');

  // Scroll to demographics
  await page.evaluate(() => window.scrollTo({ top: 200 }));
  await page.waitForTimeout(200);
  await shot(page, '02-demographics');

  // Scroll to first problem block
  await page.evaluate(() => {
    const card = document.querySelectorAll('section.card')[2];
    card?.scrollIntoView({ block: 'start' });
  });
  await page.waitForTimeout(300);
  await shot(page, '03-first-problem');

  // Try clicking a Likert option to confirm radios + visual state
  const firstRadio = page.locator('input[type="radio"]').nth(2); // 3rd radio = "3"
  if (await firstRadio.count()) {
    await firstRadio.click({ force: true });
    await page.waitForTimeout(150);
  }
  await shot(page, '04-after-radio-click');

  // Scroll to mid problem
  await page.evaluate(() => {
    const card = document.querySelectorAll('section.card')[4];
    card?.scrollIntoView({ block: 'start' });
  });
  await page.waitForTimeout(300);
  await shot(page, '05-mid-problem');

  // Scroll to bottom (download button + comment)
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight }));
  await page.waitForTimeout(300);
  await shot(page, '06-bottom');

  // Get full-page measurement
  const dims = await page.evaluate(() => ({
    scrollHeight: document.body.scrollHeight,
    viewport: window.innerHeight,
    radioCount: document.querySelectorAll('input[type="radio"]').length,
    likertGroupCount: document.querySelectorAll('.likert').length,
    imgCount: document.querySelectorAll('img').length,
    imgsLoaded: Array.from(document.querySelectorAll('img'))
      .filter((img) => img.complete && img.naturalWidth > 0).length,
    orderTitle: document.title,
  }));
  console.log('\nDIAGNOSTIC:');
  console.log('  scrollHeight:', dims.scrollHeight, 'px');
  console.log('  radio count :', dims.radioCount, '(expected 30 questions × 5 = 150)');
  console.log('  likert groups:', dims.likertGroupCount, '(expected 30 = 5 problems × 2 conditions × 3 questions)');
  console.log('  img count   :', dims.imgCount, '(expected 10 = 5 problems × 2 conditions)');
  console.log('  imgs loaded :', dims.imgsLoaded);
  console.log('  title       :', dims.orderTitle);

  await browser.close();
  console.log(`\n✅ Screenshots → ${SHOTS}/q2form-${STAMP}-*.png`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
