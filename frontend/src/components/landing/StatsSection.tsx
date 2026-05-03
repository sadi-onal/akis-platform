import { motion, useReducedMotion, useInView } from 'framer-motion';
import { useRef, useState, useEffect } from 'react';

function AnimatedCounter({ target, suffix = '' }: { target: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.5 });
  const reduced = useReducedMotion();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!inView || reduced) { setCount(target); return; }
    let frame: number;
    const duration = 1200;
    const start = performance.now();
    function animate(now: number) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      setCount(Math.round(eased * target));
      if (progress < 1) frame = requestAnimationFrame(animate);
    }
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [inView, target, reduced]);

  return <span ref={ref}>{count}{suffix}</span>;
}

// Each stat must map to something verifiable in the code (the marketing
// "5 dk Ortalama Pipeline Süresi" / "100% Test Kapsamı Hedefi" stats were
// not backed by data and were removed).
const STATS: Array<{
  value: number;
  suffix?: string;
  label: string;
  display?: string;
}> = [
  { value: 3, label: 'AI Agent', display: '3' }, // Scribe + Proto + Trace
  { value: 3, label: 'Anthropic Modeli', display: '3' }, // Haiku 4.5, Sonnet 4.6, Opus 4.7
  { value: 1, label: 'Tek Komutla Kurulum', display: 'pnpm dev' },
  { value: 1, label: 'Otomatik Test', display: 'Playwright' },
];

export function StatsSection() {
  const reduced = useReducedMotion();

  return (
    <section className="px-4 sm:px-6 lg:px-8 py-20">
      <div className="mx-auto max-w-4xl rounded-2xl border border-ak-border bg-ak-surface/70 backdrop-blur-sm p-10">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          {STATS.map((stat, i) => (
            <motion.div
              key={stat.label}
              className="text-center"
              initial={reduced ? {} : { y: 20 }}
              whileInView={{ y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1, duration: 0.5 }}
            >
              <div className="text-3xl font-bold text-[#07D1AF]">
                {stat.display ?? <AnimatedCounter target={stat.value} suffix={stat.suffix} />}
              </div>
              <div className="mt-1 text-sm text-ak-text-primary">{stat.label}</div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
