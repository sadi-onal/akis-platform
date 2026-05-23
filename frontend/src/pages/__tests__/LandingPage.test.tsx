import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import React from 'react';

// ---- mocks (must come before any component imports) ----

const navigateMock = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const useAuthMock = vi.fn(() => ({ user: null, loading: false }));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: (...args: unknown[]) => useAuthMock(...args),
}));

vi.mock('../../theme/brand', () => ({
  LOGO_MARK_SVG: '/mock-logo.svg',
}));

// Mock framer-motion so animation props don't break jsdom rendering
vi.mock('framer-motion', async () => {
  const ANIMATION_PROPS = new Set([
    'initial',
    'animate',
    'whileInView',
    'whileHover',
    'whileTap',
    'viewport',
    'transition',
    'variants',
    'custom',
    'exit',
    'onAnimationComplete',
    'layout',
    'layoutId',
  ]);

  function filterProps(props: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(props).filter(([k]) => !ANIMATION_PROPS.has(k)));
  }

  const motionProxy = new Proxy(
    {},
    {
      get(_target, tag: string) {
        const Component = React.forwardRef<HTMLElement, Record<string, unknown>>(
          ({ children, ...rest }, ref) => {
            const Tag = tag as keyof React.JSX.IntrinsicElements;
            return React.createElement(
              Tag,
              { ...filterProps(rest), ref } as Record<string, unknown>,
              children as React.ReactNode
            );
          }
        );
        Component.displayName = `motion.${tag}`;
        return Component;
      },
    }
  );

  return {
    LazyMotion: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    domMax: {},
    motion: motionProxy,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useReducedMotion: () => false,
    useInView: () => true,
  };
});

// ---- imports (after mocks) ----

import LandingPage from '../LandingPage';
import { HeroSection } from '../../components/landing/HeroSection';
import { HowItWorksSection } from '../../components/landing/HowItWorksSection';
import { FeaturesSection } from '../../components/landing/FeaturesSection';
import { StatsSection } from '../../components/landing/StatsSection';

// ---- helpers ----

function renderWithRouter(ui: React.ReactElement) {
  return render(<BrowserRouter>{ui}</BrowserRouter>);
}

beforeEach(() => {
  navigateMock.mockReset();
  useAuthMock.mockReset();
  useAuthMock.mockReturnValue({ user: null, loading: false });
});

// ===================== LandingPage =====================

describe('LandingPage', () => {
  it('renders the AKIS logo image', () => {
    renderWithRouter(<LandingPage />);
    const logos = screen.getAllByAltText('AKIS');
    expect(logos.length).toBeGreaterThanOrEqual(1);
  });

  it('renders the "Giriş Yap" button', () => {
    renderWithRouter(<LandingPage />);
    expect(screen.getByText('Giriş Yap')).toBeInTheDocument();
  });

  it('renders the "Dokümantasyon" link in the nav', () => {
    renderWithRouter(<LandingPage />);
    const docButtons = screen.getAllByText(/Dok[uü]mantasyon/);
    expect(docButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('renders the "Hemen Deneyin" CTA section', () => {
    renderWithRouter(<LandingPage />);
    expect(screen.getByText('Hemen Deneyin')).toBeInTheDocument();
  });

  it('renders the "Ücretsiz Başla" button', () => {
    renderWithRouter(<LandingPage />);
    expect(screen.getByText('Ücretsiz Başla')).toBeInTheDocument();
  });

  it('renders the footer with FSMVÜ text', () => {
    renderWithRouter(<LandingPage />);
    expect(screen.getByText(/FSMVÜ Bitirme Projesi/)).toBeInTheDocument();
  });

  it('renders the footer author line', () => {
    renderWithRouter(<LandingPage />);
    expect(screen.getByText(/Ömer Yasir Önal/)).toBeInTheDocument();
  });

  it('"Giriş Yap" button calls navigate to /login', () => {
    renderWithRouter(<LandingPage />);
    screen.getByText('Giriş Yap').click();
    expect(navigateMock).toHaveBeenCalledWith('/login');
  });

  it('"Ücretsiz Başla" button calls navigate to /signup', () => {
    renderWithRouter(<LandingPage />);
    screen.getByText('Ücretsiz Başla').click();
    expect(navigateMock).toHaveBeenCalledWith('/signup');
  });
});

describe('LandingPage — authenticated nav', () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue({
      user: { id: '1', name: 'Test User', email: 'test@test.com', role: 'member' },
      loading: false,
    });
  });

  it('does NOT auto-redirect to /chat (landing stays browsable for logged-in users)', () => {
    renderWithRouter(<LandingPage />);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('swaps "Giriş Yap" for "Sohbete Git"', () => {
    renderWithRouter(<LandingPage />);
    expect(screen.queryByText('Giriş Yap')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Sohbete dön')).toBeInTheDocument();
  });

  it('renders the user initials in the nav', () => {
    renderWithRouter(<LandingPage />);
    // "Test User" → "T". Title attribute holds the full name for tooltip.
    expect(screen.getByLabelText('Test User')).toHaveTextContent('T');
  });

  it('bottom CTA navigates to /chat (not /signup)', () => {
    renderWithRouter(<LandingPage />);
    screen.getByLabelText('Sohbete git').click();
    expect(navigateMock).toHaveBeenCalledWith('/chat');
  });
});

describe('HeroSection — authenticated CTA', () => {
  it('swaps "Hemen Başla" for "Sohbete Git" and targets /chat', () => {
    useAuthMock.mockReturnValueOnce({
      user: { id: '1', name: 'Test', email: 'test@test.com', role: 'member' },
      loading: false,
    });

    renderWithRouter(<HeroSection />);
    expect(screen.queryByText(/Hemen Başla/)).not.toBeInTheDocument();
    const cta = screen.getByText('Sohbete Git');
    cta.click();
    expect(navigateMock).toHaveBeenCalledWith('/chat');
  });
});

// ===================== HeroSection =====================

describe('HeroSection', () => {
  it('renders the hero headline opening "Üç" / "Ajan."', () => {
    renderWithRouter(<HeroSection />);
    expect(screen.getByText('Üç')).toBeInTheDocument();
    expect(screen.getByText('Ajan.')).toBeInTheDocument();
  });

  it('renders the accent words including "Fikirden" and "Koda."', () => {
    renderWithRouter(<HeroSection />);
    expect(screen.getByText('Fikirden')).toBeInTheDocument();
    expect(screen.getByText('Koda.')).toBeInTheDocument();
  });

  it('renders a subtitle that mentions Scribe, Proto, and Trace', () => {
    renderWithRouter(<HeroSection />);
    expect(screen.getByText(/Scribe, Proto, Trace/)).toBeInTheDocument();
  });

  it('renders Scribe, Proto, and Trace badges', () => {
    renderWithRouter(<HeroSection />);
    expect(screen.getByText('Scribe')).toBeInTheDocument();
    expect(screen.getByText('Proto')).toBeInTheDocument();
    expect(screen.getByText('Trace')).toBeInTheDocument();
  });

  it('renders "Hemen Basla" CTA button', () => {
    renderWithRouter(<HeroSection />);
    expect(screen.getByText(/Hemen Başla/)).toBeInTheDocument();
  });
});

// ===================== HowItWorksSection =====================

describe('HowItWorksSection', () => {
  it('renders "Nasil Calisir?" section heading', () => {
    renderWithRouter(<HowItWorksSection />);
    expect(screen.getByText(/Nasıl Çalışır/)).toBeInTheDocument();
  });

  it('renders all 3 step badges', () => {
    renderWithRouter(<HowItWorksSection />);
    expect(screen.getByText(/Adım 1/)).toBeInTheDocument();
    expect(screen.getByText(/Adım 2/)).toBeInTheDocument();
    expect(screen.getByText(/Adım 3/)).toBeInTheDocument();
  });

  it('renders step title "Fikrinizi Anlatin"', () => {
    renderWithRouter(<HowItWorksSection />);
    expect(screen.getByText(/Fikrinizi Anlatın/)).toBeInTheDocument();
  });

  it('renders step title "Otomatik Prototipleme"', () => {
    renderWithRouter(<HowItWorksSection />);
    expect(screen.getByText(/Otomatik Prototipleme/)).toBeInTheDocument();
  });

  it('renders step title "Otomatik Test Yazimi"', () => {
    renderWithRouter(<HowItWorksSection />);
    expect(screen.getByText(/Otomatik Test Yazımı/)).toBeInTheDocument();
  });
});

// ===================== FeaturesSection =====================

describe('FeaturesSection', () => {
  it('renders "Entegrasyonlar" section heading', () => {
    renderWithRouter(<FeaturesSection />);
    expect(screen.getByText('Entegrasyonlar')).toBeInTheDocument();
  });

  it('renders the AI Sağlayıcı feature heading (PR-A: Anthropic-only copy)', () => {
    renderWithRouter(<FeaturesSection />);
    expect(screen.getByRole('heading', { name: 'AI Sağlayıcı' })).toBeInTheDocument();
  });

  it('renders "GitHub Entegrasyonu" feature', () => {
    renderWithRouter(<FeaturesSection />);
    expect(screen.getByText(/GitHub Entegrasyonu/)).toBeInTheDocument();
  });

  it('renders "Jira Entegrasyonu" feature', () => {
    renderWithRouter(<FeaturesSection />);
    expect(screen.getByText(/Jira Entegrasyonu/)).toBeInTheDocument();
  });

  it('renders "Otomatik Test" feature (Playwright primary, Cucumber optional)', () => {
    renderWithRouter(<FeaturesSection />);
    expect(screen.getByText(/Otomatik Test/)).toBeInTheDocument();
  });
});

// ===================== StatsSection =====================

describe('StatsSection', () => {
  it('renders "AI Agent" stat label (3 = Scribe + Proto + Trace)', () => {
    renderWithRouter(<StatsSection />);
    expect(screen.getByText('AI Agent')).toBeInTheDocument();
  });

  it('renders "Anthropic Modeli" stat label (PR-A: stat counts the 3 Anthropic models)', () => {
    renderWithRouter(<StatsSection />);
    expect(screen.getByText('Anthropic Modeli')).toBeInTheDocument();
  });

  it('renders the setup-command stat with "pnpm dev" display', () => {
    renderWithRouter(<StatsSection />);
    expect(screen.getByText(/Tek Komutla Kurulum/)).toBeInTheDocument();
    expect(screen.getByText('pnpm dev')).toBeInTheDocument();
  });

  it('renders "Otomatik Test" stat with "Playwright" display', () => {
    renderWithRouter(<StatsSection />);
    expect(screen.getByText(/Otomatik Test/)).toBeInTheDocument();
    expect(screen.getByText('Playwright')).toBeInTheDocument();
  });
});
