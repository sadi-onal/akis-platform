# S1 — Analytics Dashboard (`/analytics`)

## Problem

Settings page has basic Usage + Pipeline Stats tabs but they're flat — no drill-down, no provider/model breakdown, no cache savings visibility, no historical trends. The rich per-call data in `job_ai_calls` is only surfaced in per-pipeline AI Logs, never aggregated.

## Decision

New standalone page at `/analytics` with scrollable sections and top-level time-range filter. Settings keeps existing tabs as-is (lightweight summary for quick glance). The analytics page is the deep-dive.

## Data Sources

| Table | What we pull |
|---|---|
| `job_ai_calls` | Per-call: provider, model, purpose, tokens (input/output/cache), cost, success, duration |
| `pipelines` | Stage, metrics JSONB (aggregate tokens, cost, per-stage timestamps), error, attemptCount |
| `pipeline_activities` | Stage transitions, retry counts, error events, timing |
| `agent_activities` | Per-agent tokens, confidence, tests passed/failed, spec compliance, model |

## Backend

### New endpoint: `GET /api/analytics`

Query params:
- `period`: `7d | 14d | 30d | 90d` (default `30d`)
- `groupBy`: `day | week` (auto: day for ≤30d, week for 90d)

Response shape:
```typescript
interface AnalyticsResponse {
  period: string;
  summary: {
    totalPipelines: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    cacheSavingsPercent: number;   // cacheRead / (cacheRead + input) * 100
    successRate: number;           // completed / (completed + failed) * 100
    avgDurationMs: number;
    estimatedCostUsd: number;      // role-aware (admin = wholesale, user = retail)
  };
  timeSeries: Array<{
    date: string;                  // ISO date
    pipelines: number;
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    successCount: number;
    failCount: number;
  }>;
  providerBreakdown: Array<{
    provider: string;
    calls: number;
    tokens: number;
    cost: number;
    avgDurationMs: number;
  }>;
  modelBreakdown: Array<{
    model: string;
    provider: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }>;
  agentBreakdown: Array<{
    agent: string;                 // scribe | proto | trace | critic
    calls: number;
    inputTokens: number;
    outputTokens: number;
    avgConfidence: number | null;
  }>;
  purposeBreakdown: Array<{
    purpose: string;               // plan | generate | reflect | validate | repair:*
    calls: number;
    tokens: number;
    cost: number;
  }>;
  pipelinePerformance: {
    avgScribeDurationMs: number;
    avgProtoDurationMs: number;
    avgTraceDurationMs: number;
    avgTotalDurationMs: number;
    topErrors: Array<{ code: string; count: number }>;
    retrysByStage: Record<string, number>;
  };
  criticStats: {
    totalReviews: number;
    approvalRate: number;          // approved / total * 100
    avgScore: number;
    fixLoopTriggerRate: number;    // iterations with critical findings / total
    iterateLoopCount: number;
  };
}
```

Implementation: single SQL query per section, aggregating from `job_ai_calls` (JOIN `pipelines` for user filter). Cache savings computed from `cacheCreationInputTokens` + `cacheReadInputTokens` columns. Cost uses `CostCalculator` for role-aware display.

### Migration: none needed

All data already exists in `job_ai_calls`, `pipelines`, `pipeline_activities`, `agent_activities`. No schema changes.

## Frontend

### New dependency: `recharts`

Tree-shakeable React charting library. Used for area charts, bar charts, donut charts.

### Route: `/analytics`

Add to router alongside existing `/settings`, `/conversations` routes. Sidebar navigation item with chart icon.

### Page layout (top to bottom)

#### 1. Header + Time Range Filter
- Page title "Analitik" (i18n: TR + EN)
- Segmented control: 7g / 14g / 30g / 90g
- Last-updated indicator + refresh button

#### 2. Hero KPI Cards (5 columns, responsive → 2-3 on mobile)
| Card | Value | Subtitle |
|---|---|---|
| Akışlar | `47` | period count |
| Token Kullanımı | `2.3M` | formatted with K/M suffix |
| Başarı Oranı | `89%` | green/yellow/red coloring at 90/70 thresholds |
| Ort. Süre | `4d 12s` | formatted duration |
| Önbellek Tasarrufu | `34%` | cache read ratio — unique to AKIS, shows prompt caching ROI |

#### 3. Token Usage Over Time (area chart)
- Stacked area: input tokens (blue) + output tokens (purple) + cache read (green dashed)
- X: date, Y: token count
- Toggle: "by provider" / "by model" / "by agent" — changes the stacking dimension
- Hover tooltip: date, breakdown values, cost

#### 4. Breakdowns (2-column grid)
**Left: Provider Breakdown**
- Horizontal stacked bar or donut chart
- Table below: provider, calls, tokens, cost, avg latency

**Right: Model Distribution**
- Donut chart with legend
- Table below: model, provider, calls, input/output tokens, cost

#### 5. Pipeline Performance
**Left: Success/Fail over time**
- Stacked bar chart: success (green) + partial (yellow) + failed (red)

**Right: Stage Duration**
- Grouped horizontal bar: Scribe | Proto | Trace | Total
- Shows average with min/max whiskers

#### 6. Agent & Critic Stats
**Left: Agent Token Breakdown**
- Table: agent, input tokens, output tokens, avg confidence, calls

**Right: Critic Dashboard**
- Approval rate donut
- Avg score gauge (0-100)
- Fix-loop trigger rate
- Iterate loop count

#### 7. Error & Retry Patterns
- Top errors bar chart (error code vs count)
- Retry heatmap by stage (color-coded cells)

### Tailwind styling
- Background: `bg-gray-950` (dark mode default)
- Cards: `bg-gray-900 border border-gray-800 rounded-xl p-5`
- KPI value: `text-3xl font-bold text-white`
- KPI label: `text-sm text-gray-400`
- Chart containers: `h-64` (area/bar), `h-48` (donut)
- Section headers: `text-lg font-semibold text-gray-200 mb-4`
- Grid gaps: `gap-4` (cards), `gap-6` (sections)

### i18n keys
All user-visible strings go through `frontend/src/i18n/` catalogue. Key prefix: `analytics.*`. Both TR and EN translations required.

## Acceptance Criteria

- [ ] `/analytics` route accessible from sidebar navigation
- [ ] Time range filter (7d/14d/30d/90d) changes all data
- [ ] 5 hero KPI cards with correct values
- [ ] Token usage area chart with provider/model/agent toggle
- [ ] Provider breakdown table + chart
- [ ] Model distribution donut + table
- [ ] Pipeline success/fail stacked bar
- [ ] Stage duration comparison
- [ ] Agent token breakdown table
- [ ] Critic approval rate + score + fix-loop stats
- [ ] Error frequency + retry heatmap
- [ ] Cache savings percentage visible
- [ ] Admin sees wholesale cost, user sees retail
- [ ] Responsive layout (mobile-friendly at 2-col)
- [ ] Empty state when no data
- [ ] Loading skeletons during fetch
- [ ] Auto-refresh on window focus (like current Usage tab)

## Out of Scope

- Real-time streaming (polling on focus is sufficient)
- Data export / CSV download (future)
- Custom date range picker (future — predefined periods cover 95% of needs)
- Per-pipeline drill-down from analytics (user goes to pipeline detail for that)
- Removing existing Settings Usage/Pipeline Stats tabs (they stay for quick glance)
