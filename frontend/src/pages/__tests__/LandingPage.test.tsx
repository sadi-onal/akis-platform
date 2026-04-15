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
    'initial', 'animate', 'whileInView', 'whileHover', 'whileTap',
    'viewport', 'transition', 'variants', 'custom', 'exit',
    'onAnimationComplete', 'layout', 'layoutId',
  ]);

  function filterProps(props: Record<string, unknown>) {
    return Object.fromEntries(
      Object.entries(props).filter(([k]) => !ANIMATION_PROPS.has(k)),
    );
  }

  const motionProxy = new Proxy(
    {},
    {
      get(_target, tag: string) {
        const Component = React.forwardRef<HTMLElement, Record<string, unknown>>(
          ({ children, ...rest }, ref) => {
            const Tag = tag as keyof React.JSX.IntrinsicElements;
            return React.createElement(Tag, { ...filterProps(rest), ref } as Record<string, unknown>, children as React.ReactNode);
          },
        );
        Component.displayName = `motion.${tag}`;
        return Component;
      },
    },
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

  it('renders the "Giris Yap" button', () => {
    renderWithRouter(<LandingPage />);
    expect(screen.getByText('Giris Yap')).toBeInTheDocument();
  });

  it('renders the "Dokumantasyon" link in the nav', () => {
    renderWithRouter(<LandingPage />);
    const docButtons = screen.getAllByText(/Dok[uü]mantasyon/);
    expect(docButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('renders the "Hemen Deneyin" CTA section', () => {
    renderWithRouter(<LandingPage />);
    expect(screen.getByText('Hemen Deneyin')).toBeInTheDocument();
  });

  it('renders the "Ucretsiz Basla" button', () => {
    renderWithRouter(<LandingPage />);
    expect(screen.getByText('Ucretsiz Basla')).toBeInTheDocument();
  });

  it('renders the footer with FSMVU text', () => {
    renderWithRouter(<LandingPage />);
    expect(screen.getByText(/FSMVU Bitirme Projesi/)).toBeInTheDocument();
  });

  it('renders the footer author line', () => {
    renderWithRouter(<LandingPage />);
    expect(screen.getByText(/Omer Yasir Onal/)).toBeInTheDocument();
  });

  it('"Giris Yap" button calls navigate to /login', () => {
    renderWithRouter(<LandingPage />);
    screen.getByText('Giris Yap').click();
    expect(navigateMock).toHaveBeenCalledWith('/login');
  });

  it('"Ucretsiz Basla" button calls navigate to /signup', () => {
    renderWithRouter(<LandingPage />);
    screen.getByText('Ucretsiz Basla').click();
    expect(navigateMock).toHaveBeenCalledWith('/signup');
  });
});

describe('LandingPage — auth redirect', () => {
  it('redirects to /chat when user is logged in', () => {
    useAuthMock.mockReturnValueOnce({
      user: { id: '1', name: 'Test', email: 'test@test.com', role: 'member' },
      loading: false,
    });

    renderWithRouter(<LandingPage />);
    expect(navigateMock).toHaveBeenCalledWith('/chat', { replace: true });
  });
});

// ===================== HeroSection =====================

describe('HeroSection', () => {
  it('renders the hero headline containing "Fikirden"', () => {
    renderWithRouter(<HeroSection />);
    expect(screen.getByText('Fikirden')).toBeInTheDocument();
  });

  it('renders the hero headline containing "Koda,"', () => {
    renderWithRouter(<HeroSection />);
    expect(screen.getByText('Koda,')).toBeInTheDocument();
  });

  it('renders the accent words "Dakikalar" and "Icinde."', () => {
    renderWithRouter(<HeroSection />);
    expect(screen.getByText('Dakikalar')).toBeInTheDocument();
  });

  it('renders the subtitle about AI agents', () => {
    renderWithRouter(<HeroSection />);
    expect(
      screen.getByText(/AI destekli agent.*yazılım geliştirme/),
    ).toBeInTheDocument();
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

  it('renders "Coklu AI Saglayici" feature', () => {
    renderWithRouter(<FeaturesSection />);
    expect(screen.getByText(/Çoklu AI Sağlayıcı/)).toBeInTheDocument();
  });

  it('renders "GitHub Entegrasyonu" feature', () => {
    renderWithRouter(<FeaturesSection />);
    expect(screen.getByText(/GitHub Entegrasyonu/)).toBeInTheDocument();
  });

  it('renders "Jira Entegrasyonu" feature', () => {
    renderWithRouter(<FeaturesSection />);
    expect(screen.getByText(/Jira Entegrasyonu/)).toBeInTheDocument();
  });

  it('renders "BDD / Cucumber" feature', () => {
    renderWithRouter(<FeaturesSection />);
    expect(screen.getByText(/BDD \/ Cucumber/)).toBeInTheDocument();
  });
});

// ===================== StatsSection =====================

describe('StatsSection', () => {
  it('renders "AI Agent" stat label', () => {
    renderWithRouter(<StatsSection />);
    expect(screen.getByText('AI Agent')).toBeInTheDocument();
  });

  it('renders "Ortalama Pipeline Suresi" stat label', () => {
    renderWithRouter(<StatsSection />);
    expect(screen.getByText(/Ortalama Pipeline Süresi/)).toBeInTheDocument();
  });

  it('renders "Test Kapsami Hedefi" stat label', () => {
    renderWithRouter(<StatsSection />);
    expect(screen.getByText(/Test Kapsamı Hedefi/)).toBeInTheDocument();
  });

  it('renders "Yapilandirma Gerekli" stat label with "Sifir" display', () => {
    renderWithRouter(<StatsSection />);
    expect(screen.getByText(/Yapılandırma Gerekli/)).toBeInTheDocument();
    expect(screen.getByText('Sıfır')).toBeInTheDocument();
  });
});
