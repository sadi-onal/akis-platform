import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAnalytics, type Period } from '../hooks/useAnalytics';
import { useI18n } from '../i18n/useI18n';
import type { PieLabelRenderProps } from 'recharts';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';

const PERIODS: Period[] = ['7d', '14d', '30d', '90d'];

const CHART_COLORS = [
  '#10B981', // emerald
  '#6366F1', // indigo
  '#F59E0B', // amber
  '#EF4444', // red
  '#8B5CF6', // violet
  '#EC4899', // pink
  '#14B8A6', // teal
  '#F97316', // orange
];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDuration(ms: number): string {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = sec / 60;
  return `${min.toFixed(1)}m`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-xl border border-gray-800 bg-gray-900 p-5">
      <div className="mb-2 h-4 w-24 rounded bg-gray-700" />
      <div className="h-8 w-32 rounded bg-gray-700" />
    </div>
  );
}

function SkeletonChart() {
  return (
    <div className="animate-pulse rounded-xl border border-gray-800 bg-gray-900 p-5">
      <div className="mb-4 h-4 w-40 rounded bg-gray-700" />
      <div className="h-64 rounded bg-gray-800" />
    </div>
  );
}

export default function AnalyticsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<Period>('30d');
  const { data, isLoading, error, refetch } = useAnalytics(period);

  // ── Loading state ──
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-950 px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="mb-8 flex items-center justify-between">
            <div className="h-8 w-48 animate-pulse rounded bg-gray-700" />
            <div className="h-10 w-64 animate-pulse rounded-lg bg-gray-700" />
          </div>
          <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
          <div className="mb-6">
            <SkeletonChart />
          </div>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <SkeletonChart />
            <SkeletonChart />
          </div>
        </div>
      </div>
    );
  }

  // ── Error state ──
  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950">
        <div className="text-center">
          <p className="mb-4 text-gray-400">{t('analytics.error')}</p>
          <button
            onClick={refetch}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 transition-colors"
          >
            {t('analytics.error.retry')}
          </button>
        </div>
      </div>
    );
  }

  // ── Empty state ──
  if (!data || data.summary.totalPipelines === 0) {
    return (
      <div className="min-h-screen bg-gray-950 px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <PageHeader
            period={period}
            setPeriod={setPeriod}
            onRefresh={refetch}
            onBack={() => navigate('/chat')}
            t={t}
          />
          <div className="flex flex-col items-center justify-center gap-4 py-32">
            <svg className="h-16 w-16 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
            </svg>
            <p className="text-sm text-gray-400">{t('analytics.empty')}</p>
          </div>
        </div>
      </div>
    );
  }

  const { summary, timeSeries, providerBreakdown, modelBreakdown, agentBreakdown, pipelinePerformance, criticStats } = data;

  const successRateColor = summary.successRate >= 90 ? 'text-emerald-400' : summary.successRate >= 70 ? 'text-yellow-400' : 'text-red-400';

  const stageDurationData = [
    { name: t('analytics.pipeline.scribe'), ms: pipelinePerformance.avgScribeDurationMs },
    { name: t('analytics.pipeline.proto'), ms: pipelinePerformance.avgProtoDurationMs },
    { name: t('analytics.pipeline.trace'), ms: pipelinePerformance.avgTraceDurationMs },
  ].filter((d) => d.ms > 0);

  return (
    <div className="min-h-screen bg-gray-950 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        {/* 1. Header */}
        <PageHeader
          period={period}
          setPeriod={setPeriod}
          onRefresh={refetch}
          onBack={() => navigate('/chat')}
          t={t}
        />

        {/* 2. Hero KPI Cards */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <KPICard label={t('analytics.kpi.pipelines')} value={String(summary.totalPipelines)} />
          <KPICard label={t('analytics.kpi.tokens')} value={formatTokens(summary.totalTokens)} />
          <KPICard label={t('analytics.kpi.successRate')} value={`${summary.successRate}%`} valueClass={successRateColor} />
          <KPICard label={t('analytics.kpi.avgDuration')} value={formatDuration(summary.avgDurationMs)} />
          <KPICard label={t('analytics.kpi.cacheSavings')} value={`${summary.cacheSavingsPercent}%`} />
        </div>

        {/* 3. Token Usage Over Time */}
        {timeSeries.length > 0 && (
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <h3 className="mb-4 text-lg font-semibold text-gray-200">{t('analytics.chart.tokenUsage')}</h3>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timeSeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="date" tick={{ fill: '#9CA3AF', fontSize: 11 }} tickFormatter={(v: string) => v.slice(5)} />
                  <YAxis tick={{ fill: '#9CA3AF', fontSize: 11 }} tickFormatter={formatTokens} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #374151', borderRadius: '8px' }}
                    labelStyle={{ color: '#E5E7EB' }}
                    itemStyle={{ color: '#D1D5DB' }}
                    formatter={(value) => formatTokens(Number(value ?? 0))}
                  />
                  <Area type="monotone" dataKey="inputTokens" stackId="1" stroke="#6366F1" fill="#6366F1" fillOpacity={0.4} name={t('analytics.chart.input')} />
                  <Area type="monotone" dataKey="outputTokens" stackId="1" stroke="#8B5CF6" fill="#8B5CF6" fillOpacity={0.4} name={t('analytics.chart.output')} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* 4. Breakdowns */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Provider Breakdown */}
          {providerBreakdown.length > 0 && (
            <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
              <h3 className="mb-4 text-lg font-semibold text-gray-200">{t('analytics.chart.providerBreakdown')}</h3>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={providerBreakdown}
                      dataKey="tokens"
                      nameKey="provider"
                      cx="50%"
                      cy="50%"
                      outerRadius={60}
                      label={(props: PieLabelRenderProps) => String((props as PieLabelRenderProps & { provider: string }).provider ?? '')}
                    >
                      {providerBreakdown.map((_, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #374151', borderRadius: '8px' }}
                      formatter={(value) => formatTokens(Number(value ?? 0))}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <table className="mt-4 w-full text-xs text-gray-400">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="pb-2 text-left font-medium">{t('analytics.table.provider')}</th>
                    <th className="pb-2 text-right font-medium">{t('analytics.table.calls')}</th>
                    <th className="pb-2 text-right font-medium">{t('analytics.table.tokens')}</th>
                    <th className="pb-2 text-right font-medium">{t('analytics.table.cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {providerBreakdown.map((p) => (
                    <tr key={p.provider} className="border-b border-gray-800/50">
                      <td className="py-1.5 text-gray-300">{p.provider}</td>
                      <td className="py-1.5 text-right">{p.calls}</td>
                      <td className="py-1.5 text-right">{formatTokens(p.tokens)}</td>
                      <td className="py-1.5 text-right">{formatCost(p.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Model Distribution */}
          {modelBreakdown.length > 0 && (
            <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
              <h3 className="mb-4 text-lg font-semibold text-gray-200">{t('analytics.chart.modelDistribution')}</h3>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={modelBreakdown}
                      dataKey="inputTokens"
                      nameKey="model"
                      cx="50%"
                      cy="50%"
                      outerRadius={60}
                      label={(props: PieLabelRenderProps) => {
                        const model = String((props as PieLabelRenderProps & { model: string }).model ?? '');
                        return model.length > 20 ? model.slice(0, 18) + '...' : model;
                      }}
                    >
                      {modelBreakdown.map((_, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #374151', borderRadius: '8px' }}
                      formatter={(value) => formatTokens(Number(value ?? 0))}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <table className="mt-4 w-full text-xs text-gray-400">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="pb-2 text-left font-medium">{t('analytics.table.model')}</th>
                    <th className="pb-2 text-right font-medium">{t('analytics.table.calls')}</th>
                    <th className="pb-2 text-right font-medium">{t('analytics.table.tokens')}</th>
                    <th className="pb-2 text-right font-medium">{t('analytics.table.cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {modelBreakdown.map((m) => (
                    <tr key={m.model} className="border-b border-gray-800/50">
                      <td className="py-1.5 text-gray-300 truncate max-w-[120px]" title={m.model}>{m.model}</td>
                      <td className="py-1.5 text-right">{m.calls}</td>
                      <td className="py-1.5 text-right">{formatTokens(m.inputTokens + m.outputTokens)}</td>
                      <td className="py-1.5 text-right">{formatCost(m.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 5. Pipeline Performance */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Success/Fail Over Time */}
          {timeSeries.length > 0 && (
            <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
              <h3 className="mb-4 text-lg font-semibold text-gray-200">{t('analytics.chart.successFail')}</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={timeSeries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis dataKey="date" tick={{ fill: '#9CA3AF', fontSize: 11 }} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis tick={{ fill: '#9CA3AF', fontSize: 11 }} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #374151', borderRadius: '8px' }}
                      labelStyle={{ color: '#E5E7EB' }}
                    />
                    <Bar dataKey="successCount" stackId="a" fill="#10B981" name={t('analytics.chart.success')} radius={[0, 0, 0, 0]} />
                    <Bar dataKey="failCount" stackId="a" fill="#EF4444" name={t('analytics.chart.fail')} radius={[4, 4, 0, 0]} />
                    <Legend wrapperStyle={{ color: '#9CA3AF', fontSize: 12 }} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Stage Duration */}
          {stageDurationData.length > 0 && (
            <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
              <h3 className="mb-4 text-lg font-semibold text-gray-200">{t('analytics.chart.stageDuration')}</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stageDurationData} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                    <XAxis type="number" tick={{ fill: '#9CA3AF', fontSize: 11 }} tickFormatter={(v: number) => formatDuration(v)} />
                    <YAxis type="category" dataKey="name" tick={{ fill: '#9CA3AF', fontSize: 11 }} width={80} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #374151', borderRadius: '8px' }}
                      formatter={(value) => formatDuration(Number(value ?? 0))}
                    />
                    <Bar dataKey="ms" fill="#6366F1" radius={[0, 4, 4, 0]} name={t('analytics.chart.duration')} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>

        {/* 6. Agent & Critic Stats */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Agent Token Breakdown */}
          {agentBreakdown.length > 0 && (
            <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
              <h3 className="mb-4 text-lg font-semibold text-gray-200">{t('analytics.agent.title')}</h3>
              <table className="w-full text-xs text-gray-400">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="pb-2 text-left font-medium">{t('analytics.agent.agent')}</th>
                    <th className="pb-2 text-right font-medium">{t('analytics.table.calls')}</th>
                    <th className="pb-2 text-right font-medium">{t('analytics.agent.inputTokens')}</th>
                    <th className="pb-2 text-right font-medium">{t('analytics.agent.outputTokens')}</th>
                    <th className="pb-2 text-right font-medium">{t('analytics.agent.avgConfidence')}</th>
                  </tr>
                </thead>
                <tbody>
                  {agentBreakdown.map((a) => (
                    <tr key={a.agent} className="border-b border-gray-800/50">
                      <td className="py-2 capitalize text-gray-300">{a.agent}</td>
                      <td className="py-2 text-right">{a.calls}</td>
                      <td className="py-2 text-right">{formatTokens(a.inputTokens)}</td>
                      <td className="py-2 text-right">{formatTokens(a.outputTokens)}</td>
                      <td className="py-2 text-right">{a.avgConfidence !== null ? a.avgConfidence.toFixed(2) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Critic Dashboard */}
          {criticStats.totalReviews > 0 && (
            <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
              <h3 className="mb-4 text-lg font-semibold text-gray-200">{t('analytics.critic.title')}</h3>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <div>
                  <p className="text-sm text-gray-400">{t('analytics.critic.totalReviews')}</p>
                  <p className="text-2xl font-bold text-white">{criticStats.totalReviews}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{t('analytics.critic.approvalRate')}</p>
                  <p className="text-2xl font-bold text-emerald-400">{criticStats.approvalRate}%</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{t('analytics.critic.avgScore')}</p>
                  <p className="text-2xl font-bold text-white">{criticStats.avgScore || '-'}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{t('analytics.critic.fixLoopRate')}</p>
                  <p className="text-2xl font-bold text-yellow-400">{criticStats.fixLoopTriggerRate}%</p>
                </div>
                <div>
                  <p className="text-sm text-gray-400">{t('analytics.critic.iterateLoops')}</p>
                  <p className="text-2xl font-bold text-white">{criticStats.iterateLoopCount}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 7. Error & Retry Patterns */}
        {(pipelinePerformance.topErrors.length > 0 || Object.keys(pipelinePerformance.retrysByStage).length > 0) && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {pipelinePerformance.topErrors.length > 0 && (
              <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
                <h3 className="mb-4 text-lg font-semibold text-gray-200">{t('analytics.errors.topErrors')}</h3>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={pipelinePerformance.topErrors} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                      <XAxis type="number" tick={{ fill: '#9CA3AF', fontSize: 11 }} />
                      <YAxis type="category" dataKey="code" tick={{ fill: '#9CA3AF', fontSize: 10 }} width={140} />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #374151', borderRadius: '8px' }}
                      />
                      <Bar dataKey="count" fill="#EF4444" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {Object.keys(pipelinePerformance.retrysByStage).length > 0 && (
              <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
                <h3 className="mb-4 text-lg font-semibold text-gray-200">{t('analytics.errors.retryByStage')}</h3>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={Object.entries(pipelinePerformance.retrysByStage).map(([stage, retries]) => ({ stage, retries }))}
                      layout="vertical"
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                      <XAxis type="number" tick={{ fill: '#9CA3AF', fontSize: 11 }} />
                      <YAxis type="category" dataKey="stage" tick={{ fill: '#9CA3AF', fontSize: 10 }} width={140} />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #374151', borderRadius: '8px' }}
                      />
                      <Bar dataKey="retries" fill="#F59E0B" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

function PageHeader({
  period,
  setPeriod,
  onRefresh,
  onBack,
  t,
}: {
  period: Period;
  setPeriod: (p: Period) => void;
  onRefresh: () => void;
  onBack: () => void;
  t: (key: string) => string;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
          aria-label="Back"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
          </svg>
        </button>
        <h1 className="text-2xl font-bold text-white">{t('analytics.title')}</h1>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex rounded-lg border border-gray-700 bg-gray-800 p-0.5">
          {PERIODS.map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                period === p
                  ? 'bg-emerald-600 text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {t(`analytics.period.${p}`)}
            </button>
          ))}
        </div>
        <button
          onClick={onRefresh}
          className="rounded-lg border border-gray-700 bg-gray-800 p-2 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors"
          aria-label={t('analytics.refresh')}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function KPICard({
  label,
  value,
  valueClass = 'text-white',
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
      <p className="text-sm text-gray-400">{label}</p>
      <p className={`mt-1 text-3xl font-bold ${valueClass}`}>{value}</p>
    </div>
  );
}
