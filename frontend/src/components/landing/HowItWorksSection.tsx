import { motion, useReducedMotion } from 'framer-motion';

const STEPS = [
  {
    agent: 'Scribe',
    color: '#3b82f6',
    step: 1,
    title: 'Fikrinizi Anlatın',
    description: 'Scribe agent fikirlerinizi yapılandırılmış bir spec\'e dönüştürür. Sorular sorar, detayları netleştirir, spec\'i siz onaylarsınız.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
    ),
  },
  {
    agent: 'Proto',
    color: '#f59e0b',
    step: 2,
    title: 'Otomatik Prototipleme',
    description: 'Proto agent onaylanan spec\'ten çalışan bir MVP scaffold üretir ve direkt GitHub main branch\'ine push eder.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
      </svg>
    ),
  },
  {
    agent: 'Trace',
    color: '#8b5cf6',
    step: 3,
    title: 'Otomatik Test Yazımı',
    description: 'Trace agent üretilen kodu GitHub\'dan okur, Playwright e2e testleri yazar ve acceptance criteria ile eşleştirir.',
    icon: (
      <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
      </svg>
    ),
  },
];

const cardVariants = {
  hidden: { y: 40 },
  visible: { y: 0, transition: { duration: 0.6, ease: 'easeOut' as const } },
};

export function HowItWorksSection() {
  const reduced = useReducedMotion();

  return (
    <section className="relative px-4 sm:px-6 lg:px-8 py-24 max-w-5xl mx-auto">
      <motion.h2
        className="text-center text-3xl font-bold mb-4"
        initial={reduced ? {} : { y: 20 }}
        whileInView={{ y: 0 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 0.5 }}
      >
        Nasıl Çalışır?
      </motion.h2>
      <motion.p
        className="text-center text-ak-text-secondary mb-16 max-w-lg mx-auto"
        viewport={{ once: true }}
        transition={{ delay: 0.2, duration: 0.5 }}
      >
        3 AI agent, fikrinizi spec → kod → test zincirine dönüştürür.
      </motion.p>

      <div className="grid gap-4 md:gap-6 md:grid-cols-3">
        {STEPS.map((step, i) => (
          <motion.div
            key={step.agent}
            className="group relative rounded-2xl border border-ak-border bg-ak-surface/70 p-6 backdrop-blur-sm transition-colors hover:border-opacity-60"
            style={{ '--card-color': step.color } as React.CSSProperties}
            variants={reduced ? {} : cardVariants}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.3 }}
            transition={{ delay: i * 0.15 }}
            whileHover={reduced ? {} : { y: -4, boxShadow: `0 8px 30px ${step.color}15` }}
          >
            {/* Step number */}
            <div
              className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl"
              style={{ background: `${step.color}15`, color: step.color }}
            >
              {step.icon}
            </div>

            {/* Agent badge */}
            <div className="mb-3 flex items-center gap-2">
              <span
                className="text-xs font-bold uppercase tracking-wider"
                style={{ color: step.color }}
              >
                Adım {step.step} — {step.agent}
              </span>
            </div>

            <h3 className="text-lg font-semibold mb-2">{step.title}</h3>
            <p className="text-sm text-ak-text-primary leading-relaxed">{step.description}</p>

            {/* Connecting arrow (visible on desktop between cards) */}
            {i < 2 && (
              <div className="hidden md:block absolute -right-3 top-1/2 -translate-y-1/2 z-10">
                <motion.svg
                  width="24" height="24" viewBox="0 0 24 24" fill="none"
                  initial={reduced ? {} : { x: -5 }}
                  whileInView={{ x: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.5 + i * 0.2 }}
                >
                  <path d="M5 12h14M15 8l4 4-4 4" stroke="#07D1AF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </motion.svg>
              </div>
            )}
          </motion.div>
        ))}
      </div>
    </section>
  );
}
