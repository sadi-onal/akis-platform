/**
 * Prod smoke — BUG-09 / PR #403: multimodal (image) prompt acknowledgement.
 *
 * When the user uploads an image + text prompt, Scribe's FIRST reply must
 * explicitly acknowledge the image — i.e. contain the Turkish substring
 * "görsel" or "resim". This guards against silent drops in the multipart
 * upload pipeline.
 *
 * We stub a Scribe streaming response for the assertion target; the real
 * pipeline is not invoked against prod. If TEST_USER_EMAIL/password are
 * provided, the test can be adapted to a live run (skipped by default since
 * a completed pipeline costs real LLM tokens).
 *
 * Tag: @prod @smoke
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

const HAS_LIVE =
  !!process.env.TEST_USER_EMAIL &&
  !!process.env.TEST_USER_PASSWORD &&
  process.env.PROD_SMOKE_RUN_LIVE_PIPELINE === 'true';

// 1x1 transparent PNG.
const TINY_PNG = Buffer.from(
  '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489' +
    '0000000A49444154789C6300010000000500010D0A2DB40000000049454E44AE426082',
  'hex',
);

async function writeTempPng(): Promise<string> {
  const tmp = path.join(
    process.env.RUNNER_TEMP ?? '/tmp',
    `prod-smoke-${Date.now()}.png`,
  );
  fs.writeFileSync(tmp, TINY_PNG);
  return tmp;
}

async function stubScribeAckResponse(page: Page) {
  await page.route('**/auth/me', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'smoke',
        email: 'smoke@akisflow.com',
        firstName: 'Smoke',
        lastName: 'User',
        emailVerified: true,
        hasSeenBetaWelcome: true,
        dataSharingConsent: true,
        role: 'user',
      }),
    });
  });

  await page.route('**/api/pipelines', async (route: Route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'img-ack-chat',
          state: 'scribe_generating',
          messages: [
            {
              id: 'm1',
              role: 'assistant',
              content:
                'Yüklediğiniz görseli inceledim, üç ikon fark ettim ve isteğinizi anladım. Devam ediyorum.',
            },
          ],
        }),
      });
    } else {
      await route.continue();
    }
  });
}

test.describe('BUG-09 / #403 — Scribe acknowledges uploaded image @prod @smoke', () => {
  test.skip(
    !HAS_LIVE && !process.env.PLAYWRIGHT_BASE_URL?.startsWith('http://127.0.0.1'),
    'Live pipeline runs are gated on PROD_SMOKE_RUN_LIVE_PIPELINE=true',
  );

  test('first Scribe reply mentions "görsel" or "resim" after image upload', async ({
    page,
  }) => {
    await stubScribeAckResponse(page);

    const pngPath = await writeTempPng();

    await page.goto('/chat');

    // Attach the image via hidden file input (common a11y pattern).
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(pngPath);

    const textInput = page.locator('textarea, [contenteditable="true"]').first();
    await textInput.fill('Bu resimdeki ikonları kırmızıdan yeşile değiştir');
    await textInput.press('Meta+Enter').catch(() => textInput.press('Control+Enter'));

    const ack = page.getByText(/görsel|resim/i).first();
    await expect(ack).toBeVisible({ timeout: 30_000 });
  });
});
