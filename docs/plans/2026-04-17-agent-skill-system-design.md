# AKIS Agent Skill Sistemi — Tasarim

**Tarih:** 2026-04-17
**Durum:** Tasarim onaylandi, uygulama basladi
**Scope:** Pipeline agent'larina (Scribe/Proto/Trace/Critic) skill-tabanli davranis sistemi eklemek

## Amac

AKIS agent'larini **skill** denilen yeniden kullanilabilir, versiyonlanabilir davranis modulleri uzerinden gucllendirmek. Her skill bir `.md` dosyasidir: frontmatter + icerik. Claude Code'daki skill pattern'inin AKIS-specific karsiligi.

**Cozdugu problem:** Su anda her agent'in system prompt'u tek bir TypeScript const'unda `kod icinde gomulu`. Spec kalitesi, scaffold kurallari, test best-practice'leri tekrar kullanilamiyor, versiyonlanamiyor, per-agent yeniden sekillendirilemiyor.

## Yaklasim (onaylanan: Hibrit)

- **Core skill'ler** → agent'in sistem prompt'una startup'ta enjekte edilir (statik).
- **Optional skill'ler** → agent `useSkill(name)` tool'uyla cagirir (dinamik, sadece AgenticLoop kullananlar: Proto, Trace).

Scribe ve Critic su an `AgenticLoop` kullanmiyor (tek-shot `generateText` cagrisi). Bu plan onlara **sadece core** skill verir. Tool-call destegi Phase 2 islidir.

## Skill listesi (7)

### AKIS-ozel
- `spec-writing` — Scribe'in spec yazim disiplini (effort calibration, self-interrogation, ambiguity score)
- `mvp-scaffolding` — Proto'nun minimal MVP kurallari (8-12 file, <80 satir, Sandpack uyumluluk)
- `playwright-testing` — Trace'in E2E test prensipleri (POM, semantic locator, web-first assertion)

### Cross-cutting
- `code-review` — Kod review disiplini (Critic icin baseline)
- `system-design` — Mimari pattern'ler (SRP, boundary clarity, tradeoff reasoning)
- `testing-strategy` — Ne test edilir, nasil (pyramid, coverage, mocking disiplini)
- `documentation` — README + kod yorumu kurallari

## Agent ↔ Skill matrisi

| Skill | Scribe | Proto | Trace | Critic |
|-------|--------|-------|-------|--------|
| `spec-writing` | **core** | — | — | opt |
| `mvp-scaffolding` | — | **core** | — | opt |
| `playwright-testing` | — | — | **core** | — |
| `code-review` | — | — | — | **core** |
| `system-design` | core | opt | — | opt |
| `testing-strategy` | — | opt | core | opt |
| `documentation` | opt | opt | — | — |

**Not:** Scribe/Critic'in opt'lari bu plan'da **inaktif**. Phase 2'de onlari AgenticLoop'a migrate edince aktive olur.

## Dosya yapisi

```
backend/src/pipeline/agents/skills/
├── spec-writing.md
├── mvp-scaffolding.md
├── playwright-testing.md
├── code-review.md
├── system-design.md
├── testing-strategy.md
├── documentation.md
├── SkillLoader.ts       # .md dosyalarini okur, frontmatter dogrular, cache'ler
├── skill-registry.ts    # agent → skill mapping (core/opt)
├── skill-tool.ts        # useSkill tool (Proto/Trace AgenticLoop icin)
├── types.ts             # SkillFrontmatter, SkillContent, SkillRegistry
└── __tests__/
    ├── SkillLoader.test.ts
    ├── skill-registry.test.ts
    └── skill-tool.test.ts
```

## Skill .md formati

```markdown
---
name: system-design
description: When designing architecture for a feature or evaluating design tradeoffs
agents: [scribe, proto, critic]
tier: core | opt
version: 1
---

# System Design

## Principles
- Single responsibility per module
- Clear boundaries between units
- Communicate via well-defined interfaces

## When to apply
- Introducing a new feature that spans multiple modules
- Evaluating a proposed architecture
- Identifying a design smell

## Anti-patterns
- God objects / god modules
- Circular dependencies
- Implicit coupling via shared global state
```

**Kurallar:**
- Her skill <500 token hedef. Daha uzunu refactor edilir veya birden fazla skill'e bolunur.
- `tier: core` → agent'in prompt'una her cagrida enjekte edilir.
- `tier: opt` → sadece useSkill tool ile cagrilir.

## Runtime akisi

### Startup
```ts
// backend/src/server.ts veya pipeline init
await skillLoader.loadAll()  // fatal if any skill file missing/malformed
```

### Agent cagrisi (core skill injection)
```ts
// Ornek: Scribe
const coreSkills = skillRegistry.getCore('scribe')
// → ['spec-writing', 'system-design']

const systemPrompt = buildPromptWithSkills(BASE_SCRIBE_PROMPT, coreSkills)
// → base + "\n\n# Skills\n## spec-writing\n[content]\n\n## system-design\n[content]"

await ai.generateText(systemPrompt, userPrompt)
```

### Proto/Trace (useSkill tool)
```ts
// useSkill, PROTO_TOOLS ve TRACE_TOOLS'a eklenir:
{
  name: 'useSkill',
  description: 'Invoke a specialized skill for guidance. Available skills for proto: system-design, testing-strategy, documentation',
  input_schema: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        enum: ['system-design', 'testing-strategy', 'documentation']
      }
    },
    required: ['skill']
  }
}

// Handler:
handlers.useSkill = (input) => skillLoader.getContent(input.skill as string)
```

## Integrasyon degisiklikleri

### Agent dosyalari
- `ScribeAgent.ts`: `CLARIFICATION_SYSTEM_PROMPT` ve `SPEC_GENERATION_SYSTEM_PROMPT` → skill injection'la olusturulur
- `ProtoAgent.ts`: `SCAFFOLD_SYSTEM_PROMPT` → skill injection + useSkill tool registered
- `TraceAgent.ts`: sistem prompt → skill injection + useSkill tool registered
- `CriticAgent.ts`: `SPEC_REVIEW_SYSTEM_PROMPT` + `CODE_REVIEW_SYSTEM_PROMPT` → skill injection

### Mevcut prompt gocu
- Proto'nun mevcut `SCAFFOLD_SYSTEM_PROMPT`'undaki scaffold kurallari → `mvp-scaffolding.md`
- Critic'in mevcut `CODE_REVIEW_SYSTEM_PROMPT`'u → `code-review.md`
- Scribe'in effort calibration + self-interrogation kurallari → `spec-writing.md`
- Trace'in Playwright rules → `playwright-testing.md`

**Davranissal degisiklik yok.** Prompt icerigi olarak aynen tasinir, sadece fiziksel yer degisir.

## Test stratejisi

### Unit tests
- `SkillLoader.test.ts`:
  - Tum skill dosyalari okunur ve parse edilir
  - Eksik dosya → throw
  - Malformed frontmatter → throw
  - `getContent(name)` beklenen icerigi dondurur
- `skill-registry.test.ts`:
  - Her agent icin core/opt listeleri dogru
  - Gecersiz agent adi → throw
- `skill-tool.test.ts`:
  - useSkill handler bilinmeyen skill icin error dondurur
  - Bilinen skill icin content dondurur

### Snapshot tests (prompt regression)
- `ScribeAgent.test.ts`: `buildSystemPrompt('scribe')` cikti snapshot'i
- Ayni sekilde Proto/Trace/Critic icin

### Integration test
- Mock AI ile bir pipeline run'i: skill'lerin cagirildigindan ve content'in prompt'ta oldugundan emin olunur

## Hata yonetimi

- **Startup:** Skill dosyasi yok/bozuk → server baslatilamaz (fatal)
- **useSkill bilinmeyen isimle:** tool error (retryable degil, agent baska yol dener)
- **Skill content 5000+ karakter:** startup lint warning (token budget asabilir)
- **Agent skill listesi bos:** warning (agent'a hic core skill atanmamis — kasitli olabilir)

## Token butcesi

Her skill ≤500 token hedef. Ortalamalar:
- Scribe core (spec-writing + system-design) → ~800 token overhead
- Proto core (mvp-scaffolding) → ~400 token
- Trace core (playwright-testing + testing-strategy) → ~800 token
- Critic core (code-review) → ~400 token

Mevcut agent promptlari zaten 500-800 token. Toplam artis ~%15-20. Opt skill tool-call ile gelince dinamik, deger goruldugunde odenen maliyet.

## Out of scope (bu plan disinda)

- Scribe/Critic'i AgenticLoop'a migrate etmek (Phase 2)
- Skill'leri DB'de versionalamak (Phase 3 — suan dosya tabanli yeterli)
- Kullanici tarafindan ozel skill yuklemek (admin API, Phase 4)
- Skill A/B testing (Phase 5)
- Skill RAG injection (mevcut RepoDocsIngester ile entegre, Phase 3)

## Kabul kriterleri

1. 7 skill .md dosyasi mevcut, frontmatter dogrulanmis, her biri <500 token
2. `SkillLoader`, `skill-registry`, `skill-tool` modulleri test coverage >90%
3. 4 agent da core skill injection'dan faydalaniyor, mevcut testler gecio
4. Proto ve Trace'te `useSkill` tool aktif, mock senaryoda cagrilabiliyor
5. `pnpm -C backend typecheck && lint && test:unit && build` → yesil
6. Mevcut pipeline davranisi unchanged (regression yok — snapshot testler gecti)
