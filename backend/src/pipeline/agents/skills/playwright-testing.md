---
name: playwright-testing
description: Playwright E2E test authoring discipline. Apply when writing browser tests against a generated codebase.
agents: trace
tier: core
version: 1
---

# Playwright Testing

## Locator strategy (in priority order)

1. `getByRole('button', { name: 'Submit' })` — accessible name match
2. `getByText('visible text')` — user-facing content
3. `getByTestId('...')` — only when semantic locators are ambiguous
4. `getByLabel('...')` — form inputs
5. CSS selectors — last resort, never `nth-child()` or deeply nested paths

Avoid: auto-generated class names, dynamic IDs, brittle positional selectors.

## Assertions

- Web-first assertions only: `expect(locator).toBeVisible()`, `.toHaveText()`, `.toContainText()`, `.toHaveValue()`, `.toHaveURL(/pattern/)`.
- Add descriptive messages: `expect(btn).toBeVisible({ message: 'Submit button appears after form fills' })`.
- Never `page.waitForTimeout(ms)`. Use `expect(locator).toBeVisible()` or `page.waitForURL()` instead.
- For async work: explicit timeout on the assertion, e.g. `toBeVisible({ timeout: 10_000 })`.

## Page Object Model

- Create `BasePage` with shared utilities (goto, waitForReady, etc.).
- Page-specific classes extend `BasePage`, expose semantic methods (`loginPage.submit(email, password)`).
- Tests use page objects, not raw selectors.

## Turkish UI matching

- Target app UI is Turkish. Match the exact visible text: `getByRole('button', { name: 'Giriş Yap' })`.
- Never translate Turkish labels to English in selectors.
- If i18n keys are present, resolve to the rendered Turkish string before asserting.

## Test structure

- `test.describe('Feature', () => { test('should X', async ({ page }) => { ... }) })`.
- `test.beforeEach` for common setup (`page.goto('/')`).
- Test names in English; user-facing strings in Turkish.
- TypeScript for all test files.

## Traceability

- Each acceptance criterion gets at least one test.
- `Given` → test setup / beforeEach. `When` → user action. `Then` → assertion.
- Produce a mapping: `{criterionId, testFile, testName, coverage: 'full'|'partial'|'none'}`.
- If any AC has no test, surface it in `uncoveredCriteria` with explanation.

## What not to produce

- No unit tests — end-to-end only.
- Do not modify the source under test.
- Do not attempt to execute tests — only author them.
