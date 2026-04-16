import { cn } from '../../utils/cn';

interface AgentFeatureCardProps {
  agent: 'scribe' | 'proto' | 'trace';
  title: string;
  description: string;
  icon: React.ReactNode;
  delay?: number;
}

const agentStyles = {
  scribe: {
    frame: 'bg-gradient-to-br from-ak-scribe/90 via-ak-scribe/45 to-ak-scribe/15',
    iconBg: 'bg-ak-scribe/12',
    text: 'text-ak-scribe',
  },
  proto: {
    frame: 'bg-gradient-to-br from-ak-proto/90 via-ak-proto/45 to-ak-proto/15',
    iconBg: 'bg-ak-proto/12',
    text: 'text-ak-proto',
  },
  trace: {
    frame: 'bg-gradient-to-br from-ak-trace/90 via-ak-trace/45 to-ak-trace/15',
    iconBg: 'bg-ak-trace/12',
    text: 'text-ak-trace',
  },
};

export function AgentFeatureCard({ agent, title, description, icon, delay = 0 }: AgentFeatureCardProps) {
  const s = agentStyles[agent];

  return (
    <div
      className={cn(
        'h-full rounded-2xl p-[2px] shadow-sm transition-all duration-200 animate-fade-in',
        'hover:shadow-md hover:brightness-[1.02]',
        s.frame,
      )}
      style={delay > 0 ? { animationDelay: `${delay}ms`, animationFillMode: 'backwards' } : undefined}
    >
      <div
        className={cn(
          'flex h-full min-h-[7.5rem] flex-col rounded-[14px] bg-ak-surface px-4 py-3.5',
          'border border-ak-border/60',
        )}
      >
        <div className="grid min-w-0 grid-cols-[2.75rem_minmax(0,1fr)] grid-rows-[auto_1fr] gap-x-3 gap-y-1">
          <div
            className={cn(
              'row-span-2 row-start-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl',
              s.iconBg,
            )}
          >
            <span className={s.text}>{icon}</span>
          </div>
          <h3 className={cn('col-start-2 row-start-1 self-center text-sm font-semibold leading-tight', s.text)}>
            {title}
          </h3>
          <p className="col-start-2 row-start-2 text-xs leading-relaxed text-ak-text-secondary text-pretty">
            {description}
          </p>
        </div>
      </div>
    </div>
  );
}
