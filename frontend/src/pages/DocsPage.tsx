import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '../utils/cn';
import { LOGO_MARK_SVG } from '../theme/brand';
import { useI18n } from '../i18n/useI18n';

const SECTION_IDS = ['getting-started', 'pipeline', 'providers', 'settings', 'faq'] as const;

type SectionId = (typeof SECTION_IDS)[number];

interface Section {
  id: SectionId;
  title: string;
  content: string;
}

const SECTION_KEY_MAP: Record<SectionId, { title: string; content: string }> = {
  'getting-started': {
    title: 'docsPage.sections.gettingStarted.title',
    content: 'docsPage.sections.gettingStarted.content',
  },
  pipeline: {
    title: 'docsPage.sections.pipeline.title',
    content: 'docsPage.sections.pipeline.content',
  },
  providers: {
    title: 'docsPage.sections.providers.title',
    content: 'docsPage.sections.providers.content',
  },
  settings: {
    title: 'docsPage.sections.settings.title',
    content: 'docsPage.sections.settings.content',
  },
  faq: {
    title: 'docsPage.sections.faq.title',
    content: 'docsPage.sections.faq.content',
  },
};

function useSections(): Section[] {
  const { t } = useI18n();
  return useMemo(
    () =>
      SECTION_IDS.map((id) => ({
        id,
        title: t(SECTION_KEY_MAP[id].title),
        content: t(SECTION_KEY_MAP[id].content),
      })),
    [t],
  );
}

/** Render inline markdown: **bold**, `code`, [link](url) */
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Regex matches **bold**, `code`, or [text](url) — in order of priority
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (match[1] != null) {
      parts.push(<strong key={`b${key++}`} className="font-semibold text-white">{match[1]}</strong>);
    } else if (match[2] != null) {
      parts.push(<code key={`c${key++}`} className="rounded bg-ak-surface-2 px-1.5 py-0.5 text-xs font-mono text-[#07D1AF]">{match[2]}</code>);
    } else if (match[3] != null && match[4] != null) {
      parts.push(<a key={`a${key++}`} href={match[4]} className="text-[#07D1AF] underline hover:brightness-125" target="_blank" rel="noopener noreferrer">{match[3]}</a>);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? parts : [text];
}

function renderMarkdown(md: string) {
  const lines = md.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block: ```...``` collect all lines until closing ```
    if (line.startsWith('```')) {
      const codeLines: string[] = [];
      i++; // skip opening ```
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre key={`code-${i}`} className="my-3 rounded-lg bg-ak-surface-2 px-4 py-3 text-xs font-mono text-[#07D1AF] overflow-x-auto">
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      continue;
    }
    if (line.startsWith('### ')) { elements.push(<h3 key={i} className="mt-5 mb-2 text-base font-semibold text-white">{renderInline(line.slice(4))}</h3>); }
    else if (line.startsWith('## ')) { elements.push(<h2 key={i} className="mt-6 mb-3 text-xl font-bold text-white">{renderInline(line.slice(3))}</h2>); }
    else if (line.startsWith('- ')) { elements.push(<li key={i} className="ml-4 text-sm text-gray-300 leading-relaxed list-disc">{renderInline(line.slice(2))}</li>); }
    else if (/^\d+\. /.test(line)) { elements.push(<li key={i} className="ml-4 text-sm text-gray-300 leading-relaxed list-decimal">{renderInline(line.replace(/^\d+\. /, ''))}</li>); }
    else if (line.trim() === '') { elements.push(<div key={i} className="h-2" />); }
    else if (line.startsWith('`') && line.endsWith('`') && line.length > 2) { elements.push(<code key={i} className="block rounded bg-ak-surface-2 px-3 py-1.5 text-xs font-mono text-[#07D1AF]">{line.slice(1, -1)}</code>); }
    else { elements.push(<p key={i} className="text-sm text-gray-300 leading-relaxed">{renderInline(line)}</p>); }
    i++;
  }
  return elements;
}

export default function DocsPage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const sections = useSections();
  const [activeSection, setActiveSection] = useState<SectionId>('getting-started');

  return (
    <div className="min-h-screen bg-[#0A1215] text-white">
      {/* Nav */}
      <nav className="flex items-center justify-between border-b border-gray-800 px-6 py-3">
        <button onClick={() => navigate('/')} className="flex items-center gap-2 hover:opacity-80 transition">
          <img src={LOGO_MARK_SVG} alt="AKIS" className="h-7 w-7" />
          <span className="text-base font-extrabold tracking-tight text-[#07D1AF]">AKIS</span>
          <span className="text-xs text-ak-text-secondary ml-1">{t('docsPage.nav.docsLabel')}</span>
        </button>
        <button
          onClick={() => navigate('/login')}
          className="rounded-lg bg-[#07D1AF]/10 px-4 py-1.5 text-xs font-medium text-[#07D1AF] hover:bg-[#07D1AF]/20 transition"
        >
          {t('docsPage.nav.login')}
        </button>
      </nav>

      <div className="mx-auto max-w-5xl flex">
        {/* Sidebar */}
        <aside className="hidden md:block w-56 flex-shrink-0 border-r border-gray-800 py-6 pr-4 pl-4">
          <nav aria-label="Dokümantasyon bölümleri" className="sticky top-6 space-y-1">
            {sections.map((s) => (
              <button
                key={s.id}
                onClick={() => setActiveSection(s.id)}
                aria-current={activeSection === s.id ? 'page' : undefined}
                className={cn(
                  'block w-full rounded-lg px-3 py-2 text-left text-sm transition-colors',
                  activeSection === s.id
                    ? 'bg-[#07D1AF]/10 text-[#07D1AF] font-medium'
                    : 'text-ak-text-tertiary hover:text-white hover:bg-ak-surface-2/50',
                )}
              >
                {s.title}
              </button>
            ))}
          </nav>
        </aside>

        {/* Content */}
        <main className="flex-1 px-6 py-8 min-w-0">
          {/* Mobile section select */}
          <select
            value={activeSection}
            onChange={(e) => setActiveSection(e.target.value as SectionId)}
            aria-label="Bolum sec"
            className="mb-6 block w-full rounded-lg border border-ak-border bg-ak-surface px-3 py-2 text-sm text-white md:hidden"
          >
            {sections.map((s) => (
              <option key={s.id} value={s.id}>{s.title}</option>
            ))}
          </select>

          <div className="prose prose-invert max-w-none">
            {renderMarkdown(sections.find((s) => s.id === activeSection)?.content ?? '')}
          </div>
        </main>
      </div>
    </div>
  );
}
