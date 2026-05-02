import { motion, useReducedMotion } from 'framer-motion';

const FEATURES = [
  {
    title: 'Çoklu AI Sağlayıcı',
    description: 'Anthropic Claude, OpenAI GPT-4o ve OpenRouter desteği. Kendi API key\'inizi kullanın.',
    icon: '🧠',
    color: '#07D1AF',
  },
  {
    title: 'GitHub Entegrasyonu',
    description: 'Repo oluşturma, dosya push, branch yönetimi — tamamı otomatik.',
    icon: '🐙',
    color: '#f0f6fc',
  },
  {
    title: 'Jira Entegrasyonu',
    description: 'Spec onayında otomatik Jira Epic; Proto ve Trace sonuçları Epic\'e yorum olarak eklenir.',
    icon: '📋',
    color: '#0052CC',
  },
  {
    title: 'Otomatik Test',
    description: 'Trace, Proto\'nun ürettiği koddan Playwright e2e testleri yazar. Cucumber export opsiyoneldir.',
    icon: '🧪',
    color: '#23D96C',
  },
];

const cardVariants = {
  hidden: { scale: 0.95 },
  visible: { scale: 1, transition: { duration: 0.5, ease: 'easeOut' as const } },
};

export function FeaturesSection() {
  const reduced = useReducedMotion();

  return (
    <section className="px-4 sm:px-6 lg:px-8 py-24 max-w-5xl mx-auto">
      <motion.h2
        className="text-center text-3xl font-bold mb-4"
        initial={reduced ? {} : { y: 20 }}
        whileInView={{ y: 0 }}
        viewport={{ once: true, amount: 0.5 }}
        transition={{ duration: 0.5 }}
      >
        Entegrasyonlar
      </motion.h2>
      <motion.p
        className="text-center text-ak-text-secondary mb-16 max-w-lg mx-auto"
        viewport={{ once: true }}
        transition={{ delay: 0.2, duration: 0.5 }}
      >
        Tek platformda AI, GitHub, Jira ve otomatik test entegrasyonu.
      </motion.p>

      <div className="grid gap-5 sm:grid-cols-2">
        {FEATURES.map((f, i) => (
          <motion.div
            key={f.title}
            className="group rounded-2xl border border-ak-border bg-ak-surface/70 p-6 backdrop-blur-sm"
            variants={reduced ? {} : cardVariants}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, amount: 0.3 }}
            transition={{ delay: i * 0.1 }}
            whileHover={reduced ? {} : { scale: 1.02, boxShadow: `0 4px 20px ${f.color}10` }}
          >
            <div className="mb-3 text-2xl">{f.icon}</div>
            <h3 className="text-base font-semibold mb-1.5">{f.title}</h3>
            <p className="text-sm text-ak-text-primary leading-relaxed">{f.description}</p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
