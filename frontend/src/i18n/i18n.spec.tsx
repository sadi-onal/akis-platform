import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';

import { I18nProvider } from './I18nProvider';
import { useI18n } from './useI18n';

describe('I18nProvider', () => {
  // PR-T1 follow-up: DEFAULT_LOCALE is now 'tr' (Turkish thesis project)
  // and `resolveInitialLocale` skips navigator detection — the bootstrap
  // path lands on TR immediately. Test flow flipped: assert TR by default,
  // then switch to EN.
  it('loads default Turkish locale and switches to English', async () => {
    const mountSpy = vi.fn();

    function TestConsumerWithMount() {
      const { t, setLocale } = useI18n();

      // Track consumer lifetime to assert locale switches don't remount the subtree.
      useEffect(() => {
        mountSpy();
      }, []);

      return (
        <>
          <span data-testid="title">{t('app.title')}</span>
          <button
            data-testid="switch-en"
            onClick={() => {
              void setLocale('en');
            }}
          >
            Switch to en
          </button>
        </>
      );
    }

    render(
      <I18nProvider>
        <TestConsumerWithMount />
      </I18nProvider>
    );

    await waitFor(() => expect(screen.getByTestId('title').textContent).toBe('AKIS Platformu'));

    fireEvent.click(screen.getByTestId('switch-en'));

    await waitFor(() => expect(screen.getByTestId('title').textContent).toBe('AKIS Platform'));

    expect(mountSpy).toHaveBeenCalledTimes(1);
  });
});
