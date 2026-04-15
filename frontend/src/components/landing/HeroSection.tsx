import { motion, useReducedMotion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { LOGO_MARK_SVG } from '../../theme/brand';

const WORDS = ['Fikirden', 'Koda,'];
const ACCENT_WORDS = ['Dakikalar', 'İçinde.'];

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.12, delayChildren: 0.2 } },
};

const wordVariants = {
  hidden: { y: 20, filter: 'blur(8px)' },
  visible: { y: 0, filter: 'blur(0px)', transition: { duration: 0.5, ease: 'easeOut' as const } },
};

export function HeroSection() {
  const navigate = useNavigate();
  const reduced = useReducedMotion();

  return (
    <section className="relative flex min-h-[calc(100vh-72px)] flex-col items-center justify-center px-4 sm:px-6 lg:px-8 pb-20 text-center overflow-hidden">
      {/* Background glow */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <motion.div
          className="absolute left-1/2 top-1/3 h-[60vw] w-[60vw] max-h-[500px] max-w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#07D1AF]/8 blur-[80px] sm:blur-[100px]"
          animate={reduced ? {} : { scale: [1, 1.15, 1], opacity: [0.08, 0.15, 0.08] }}
          transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute right-0 bottom-0 h-[50vw] w-[50vw] max-h-[400px] max-w-[400px] rounded-full bg-[#07D1AF]/5 blur-[60px] sm:blur-[80px]"
          animate={reduced ? {} : { scale: [1, 1.1, 1], opacity: [0.05, 0.1, 0.05] }}
          transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut', delay: 2 }}
        />
      </div>

      {/* Logo */}
      <motion.img
        src={LOGO_MARK_SVG}
        alt="AKIS"
        className="relative z-10 mb-8 h-20 w-20 object-contain"
        initial={reduced ? {} : { scale: 0.5 }}
        animate={{ scale: 1 }}
        transition={{ duration: 0.6, ease: 'easeOut' as const }}
      />

      {/* Animated heading */}
      <motion.h1
        className="relative z-10 text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl leading-tight"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        {WORDS.map((word, i) => (
          <motion.span key={i} className="inline-block mr-3" variants={reduced ? {} : wordVariants}>
            {word}
          </motion.span>
        ))}
        <br className="sm:hidden" />
        {ACCENT_WORDS.map((word, i) => (
          <motion.span key={`a-${i}`} className="inline-block mr-3 text-[#07D1AF]" variants={reduced ? {} : wordVariants}>
            {word}
          </motion.span>
        ))}
      </motion.h1>

      {/* Subtitle */}
      <motion.p
        className="relative z-10 mt-6 max-w-xl text-lg text-ak-text-primary leading-relaxed"
        initial={reduced ? {} : { y: 15 }}
        animate={{ y: 0 }}
        transition={{ duration: 0.5, delay: 0.8 }}
      >
        AI destekli agent'lar ile yazılım geliştirme sürecinizi hızlandırın.
        Fikrinizi anlatın, AKIS spec yazarken siz onaylayın, kod ve testler otomatik oluşsun.
      </motion.p>

      {/* Pipeline mini-flow */}
      <motion.div
        className="relative z-10 mt-8 flex items-center gap-3 text-sm"
        transition={{ delay: 1.1, duration: 0.5 }}
      >
        {['Scribe', 'Proto', 'Trace'].map((agent, i) => (
          <motion.span
            key={agent}
            className="rounded-full px-3 py-1 font-medium"
            style={{
              background: i === 0 ? 'rgba(59,130,246,0.12)' : i === 1 ? 'rgba(245,158,11,0.12)' : 'rgba(139,92,246,0.12)',
              color: i === 0 ? '#3b82f6' : i === 1 ? '#f59e0b' : '#8b5cf6',
            }}
            initial={reduced ? {} : { x: -10 }}
            animate={{ x: 0 }}
            transition={{ delay: 1.2 + i * 0.15, duration: 0.4 }}
          >
            {agent}
          </motion.span>
        ))}
      </motion.div>

      {/* CTA buttons */}
      <motion.div
        className="relative z-10 mt-10 flex flex-wrap justify-center gap-4"
        initial={reduced ? {} : { y: 15 }}
        animate={{ y: 0 }}
        transition={{ delay: 1.5, duration: 0.5 }}
      >
        <motion.button
          onClick={() => navigate('/signup')}
          className="rounded-xl bg-[#07D1AF] px-8 py-3.5 text-sm font-bold text-[#0A1215] shadow-lg shadow-[#07D1AF]/20"
          whileHover={reduced ? {} : { scale: 1.05, boxShadow: '0 0 30px rgba(7,209,175,0.35)' }}
          whileTap={{ scale: 0.97 }}
        >
          Hemen Başla
        </motion.button>
        <motion.button
          onClick={() => navigate('/docs')}
          className="rounded-xl border border-ak-border px-8 py-3.5 text-sm font-semibold text-ak-text-secondary"
          whileHover={reduced ? {} : { scale: 1.03, borderColor: '#07D1AF' }}
          whileTap={{ scale: 0.97 }}
        >
          Dokümantasyon
        </motion.button>
      </motion.div>
    </section>
  );
}
