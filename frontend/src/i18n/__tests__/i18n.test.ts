import { describe, it, expect } from 'vitest';
import trJson from '../locales/tr.json';
import enJson from '../locales/en.json';
import { MESSAGE_KEYS } from '../i18n.types';

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

const typedKeys = MESSAGE_KEYS as readonly string[];
const trKeys = Object.keys(trJson) as string[];
const enKeys = Object.keys(enJson) as string[];
const trRecord = trJson as Record<string, string>;
const enRecord = enJson as Record<string, string>;

/** Extract `{placeholder}` tokens from a translation value. */
function extractPlaceholders(value: string): string[] {
  const matches = value.match(/\{(\w+)\}/g);
  return matches ? matches.sort() : [];
}

/**
 * Flatten nested keys into dot-notation if the JSON were nested.
 * Both locale files are already flat, so this is a no-op guard.
 */
function flatKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const result: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      result.push(...flatKeys(v as Record<string, unknown>, full));
    } else {
      result.push(full);
    }
  }
  return result;
}

const flatTrKeys = flatKeys(trJson as Record<string, unknown>);
const flatEnKeys = flatKeys(enJson as Record<string, unknown>);

// ─────────────────────────────────────────────────────────
// Translation Completeness
// ─────────────────────────────────────────────────────────

describe('Translation Completeness', () => {
  it('every key in i18n.types.ts exists in tr.json', () => {
    const missing = typedKeys.filter((k) => !flatTrKeys.includes(k));
    expect(missing, `Missing in tr.json:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every key in i18n.types.ts exists in en.json', () => {
    const missing = typedKeys.filter((k) => !flatEnKeys.includes(k));
    expect(missing, `Missing in en.json:\n${missing.join('\n')}`).toEqual([]);
  });

  it('no keys in tr.json that are missing from en.json', () => {
    const enSet = new Set(flatEnKeys);
    const orphans = flatTrKeys.filter((k) => !enSet.has(k));
    expect(
      orphans,
      `Keys in tr.json but not en.json:\n${orphans.join('\n')}`,
    ).toEqual([]);
  });

  it('no keys in en.json that are missing from tr.json', () => {
    const trSet = new Set(flatTrKeys);
    const orphans = flatEnKeys.filter((k) => !trSet.has(k));
    expect(
      orphans,
      `Keys in en.json but not tr.json:\n${orphans.join('\n')}`,
    ).toEqual([]);
  });

  it('no empty string values in tr.json', () => {
    const empties = trKeys.filter((k) => trRecord[k] === '');
    expect(
      empties,
      `Empty values in tr.json:\n${empties.join('\n')}`,
    ).toEqual([]);
  });

  it('no empty string values in en.json', () => {
    const empties = enKeys.filter((k) => enRecord[k] === '');
    expect(
      empties,
      `Empty values in en.json:\n${empties.join('\n')}`,
    ).toEqual([]);
  });

  it('placeholder consistency: if tr has {name}, en also has {name}', () => {
    const mismatches: string[] = [];
    const allKeys = [...new Set([...flatTrKeys, ...flatEnKeys])];

    for (const key of allKeys) {
      const trVal = trRecord[key];
      const enVal = enRecord[key];
      if (!trVal || !enVal) continue;

      const trPlaceholders = extractPlaceholders(trVal);
      const enPlaceholders = extractPlaceholders(enVal);

      if (trPlaceholders.join(',') !== enPlaceholders.join(',')) {
        mismatches.push(
          `"${key}": tr=${JSON.stringify(trPlaceholders)} vs en=${JSON.stringify(enPlaceholders)}`,
        );
      }
    }

    expect(
      mismatches,
      `Placeholder mismatches:\n${mismatches.join('\n')}`,
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────
// Translation Quality
// ─────────────────────────────────────────────────────────

describe('Translation Quality', () => {
  it('all error-related keys have both languages', () => {
    const errorKeys = typedKeys.filter(
      (k) => k.includes('error') || k.includes('Error') || k.startsWith('error.'),
    );
    expect(errorKeys.length).toBeGreaterThan(0);

    const missingTr = errorKeys.filter((k) => !trRecord[k]);
    const missingEn = errorKeys.filter((k) => !enRecord[k]);

    expect(
      missingTr,
      `Error keys missing in tr.json:\n${missingTr.join('\n')}`,
    ).toEqual([]);
    expect(
      missingEn,
      `Error keys missing in en.json:\n${missingEn.join('\n')}`,
    ).toEqual([]);
  });

  it('all settings labels have both languages', () => {
    const settingsKeys = typedKeys.filter((k) => k.startsWith('settings.'));
    expect(settingsKeys.length).toBeGreaterThan(0);

    const missingTr = settingsKeys.filter((k) => !trRecord[k]);
    const missingEn = settingsKeys.filter((k) => !enRecord[k]);

    expect(
      missingTr,
      `Settings keys missing in tr.json:\n${missingTr.join('\n')}`,
    ).toEqual([]);
    expect(
      missingEn,
      `Settings keys missing in en.json:\n${missingEn.join('\n')}`,
    ).toEqual([]);
  });

  it('timestamp-related translations exist in both locales', () => {
    const timeKeys = typedKeys.filter(
      (k) =>
        k.includes('date') ||
        k.includes('Date') ||
        k.includes('time') ||
        k.includes('Time') ||
        k.includes('duration') ||
        k.includes('Duration') ||
        k.includes('period') ||
        k.includes('Period') ||
        k.includes('startedAt') ||
        k.includes('updatedAt') ||
        k.includes('memberSince') ||
        k.includes('lastUpdated'),
    );
    expect(timeKeys.length).toBeGreaterThan(0);

    const missingTr = timeKeys.filter((k) => !trRecord[k]);
    const missingEn = timeKeys.filter((k) => !enRecord[k]);

    expect(
      missingTr,
      `Timestamp keys missing in tr.json:\n${missingTr.join('\n')}`,
    ).toEqual([]);
    expect(
      missingEn,
      `Timestamp keys missing in en.json:\n${missingEn.join('\n')}`,
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────
// Theme CSS Variable Consistency
// ─────────────────────────────────────────────────────────

describe('Theme CSS variable consistency', () => {
  /**
   * The CSS variables defined in global.css for :root (light) and html.dark.
   * Both themes must define the same set of custom properties so nothing
   * is accidentally visible only in one mode.
   */
  const lightVars = [
    '--ak-bg',
    '--ak-surface',
    '--ak-surface-2',
    '--ak-surface-3',
    '--ak-text-primary',
    '--ak-text-secondary',
    '--ak-border',
    '--ak-text-tertiary',
    '--ak-border-subtle',
    '--ak-border-default',
    '--ak-border-strong',
    '--ak-hover-surface',
    '--ak-active-surface',
    '--ak-elevation-1',
    '--ak-elevation-2',
    '--ak-elevation-3',
    '--ak-glow-accent',
    '--ak-glow-subtle',
    '--ak-bg-sidebar',
    '--ak-bg-chat',
    '--ak-bg-input',
    '--ak-bg-bubble-user',
    '--ak-bg-panel',
    '--ak-shadow-sm',
    '--ak-shadow-md',
  ];

  const darkVars = [...lightVars]; // dark must mirror light

  it('light and dark themes define the same custom properties', () => {
    // Both arrays should match (order-insensitive)
    expect([...lightVars].sort()).toEqual([...darkVars].sort());
  });

  it('brand accent color is defined as a CSS variable', () => {
    // --ak-primary should reference the brand color token
    expect(lightVars.some((v) => v.startsWith('--ak-'))).toBe(true);
  });

  it('elevation tokens are present for both themes', () => {
    const elevations = lightVars.filter((v) => v.startsWith('--ak-elevation'));
    expect(elevations).toContain('--ak-elevation-1');
    expect(elevations).toContain('--ak-elevation-2');
    expect(elevations).toContain('--ak-elevation-3');
  });

  it('glow tokens are present for both themes', () => {
    const glows = lightVars.filter((v) => v.startsWith('--ak-glow'));
    expect(glows).toContain('--ak-glow-accent');
    expect(glows).toContain('--ak-glow-subtle');
  });
});
