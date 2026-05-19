import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useEffect } from 'react';
import { LazyMotion, domMax, motion, useReducedMotion } from 'framer-motion';
import { LOGO_MARK_SVG } from '../theme/brand';
import { HeroSection } from '../components/landing/HeroSection';
import { HowItWorksSection } from '../components/landing/HowItWorksSection';
import { FeaturesSection } from '../components/landing/FeaturesSection';
import { StatsSection } from '../components/landing/StatsSection';

export default function LandingPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const reduced = useReducedMotion();

  useEffect(() => {
    if (!loading && user) {
      navigate('/chat', { replace: true });
    }
  }, [user, loading, navigate]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ak-bg">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#07D1AF] border-t-transparent" />
      </div>
    );
  }

  return (
    <LazyMotion features={domMax}>
      <div className="min-h-screen bg-ak-bg text-ak-text-primary">
        {/* Nav */}
        <motion.nav
          aria-label="Ana navigasyon"
          className="sticky top-0 z-50 flex items-center justify-between px-6 py-4 max-w-6xl mx-auto backdrop-blur-md bg-ak-bg/80 border-b border-ak-border/50"
          initial={reduced ? {} : { y: -10 }}
          animate={{ y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <div className="flex items-center gap-2">
            <img src={LOGO_MARK_SVG} alt="AKIS" className="h-8 w-8" />
            <span className="text-lg font-extrabold tracking-tight text-[#07D1AF]">AKIS</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/docs')}
              aria-label="Dokümantasyon sayfasına git"
              className="text-sm text-ak-text-secondary hover:text-ak-text-primary transition-colors"
            >
              Dokümantasyon
            </button>
            <motion.button
              onClick={() => navigate('/login')}
              aria-label="Giriş yap sayfasına git"
              className="rounded-lg bg-[#07D1AF] px-4 py-2 text-sm font-semibold text-[#0A1215]"
              whileHover={reduced ? {} : { scale: 1.05 }}
              whileTap={{ scale: 0.97 }}
            >
              Giriş Yap
            </motion.button>
          </div>
        </motion.nav>

        <main>
          <HeroSection />
          <HowItWorksSection />
          <StatsSection />
          <FeaturesSection />

          {/* CTA Section */}
          <section className="px-4 sm:px-6 py-24 text-center">
            <motion.div
              className="mx-auto max-w-md"
              initial={reduced ? {} : { y: 20 }}
              whileInView={{ y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
            >
              <h2 className="text-2xl font-bold mb-3">Hemen Deneyin</h2>
              <p className="text-sm text-ak-text-secondary mb-6">
                Hesap oluşturun ve ilk pipeline'ınızı dakikalar içinde başlatın.
              </p>
              <motion.button
                onClick={() => navigate('/signup')}
                aria-label="Ücretsiz hesap oluştur"
                className="rounded-xl bg-[#07D1AF] px-10 py-4 text-sm font-bold text-[#0A1215] shadow-lg shadow-[#07D1AF]/20"
                whileHover={
                  reduced ? {} : { scale: 1.05, boxShadow: '0 0 40px rgba(7,209,175,0.3)' }
                }
                whileTap={{ scale: 0.97 }}
              >
                Ücretsiz Başla
              </motion.button>
            </motion.div>
          </section>
        </main>

        {/* Footer */}
        <footer className="border-t border-ak-border px-4 py-8 text-center">
          <p className="text-xs text-ak-text-secondary">
            AKIS Platform — FSMVÜ Bitirme Projesi &copy; 2026
          </p>
          <p className="mt-1 text-xs text-ak-text-secondary/60">
            Ömer Yasir Önal — Dr. Öğr. Üyesi Nazlı Doğan
          </p>
        </footer>
      </div>
    </LazyMotion>
  );
}
