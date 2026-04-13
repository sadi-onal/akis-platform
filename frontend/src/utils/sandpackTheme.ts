import type { SandpackTheme } from '@codesandbox/sandpack-react';

export const akisSandpackTheme: SandpackTheme = {
  colors: {
    surface1: '#0f1419',
    surface2: '#1a1f2e',
    surface3: '#252b3b',
    clickable: '#9ca3af',
    base: '#e5e7eb',
    disabled: '#4b5563',
    hover: '#3ECFA0',
    accent: '#3ECFA0',
    error: '#ef4444',
    errorSurface: '#7f1d1d',
  },
  syntax: {
    plain: '#e5e7eb',
    comment: { color: '#6b7280', fontStyle: 'italic' },
    keyword: '#c084fc',
    tag: '#3ECFA0',
    punctuation: '#9ca3af',
    definition: '#67e8f9',
    property: '#3ECFA0',
    static: '#f59e0b',
    string: '#86efac',
  },
  font: {
    body: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    mono: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
    size: '13px',
    lineHeight: '1.6',
  },
};
