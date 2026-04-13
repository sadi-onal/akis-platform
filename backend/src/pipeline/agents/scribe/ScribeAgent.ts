import type {
  ScribeInput,
  ScribeOutput,
  ScribeClarification,
  ScribeMessageType,
} from '../../core/contracts/PipelineTypes.js';
import {
  ScribeOutputSchema,
  ScribeClarificationSchema,
} from '../../core/contracts/PipelineSchemas.js';
import {
  PipelineErrorCode,
  createPipelineError,
  RETRY_CONFIG,
} from '../../core/contracts/PipelineErrors.js';
import type { PipelineError } from '../../core/contracts/PipelineTypes.js';
import { isSpecMinimallyValid } from './SpecContract.js';
import { createActivityEmitter } from '../../core/activityEmitter.js';
import { parseAIJson } from '../../core/json-extract.js';

// ─── Types ────────────────────────────────────────

export interface ScribeAIDeps {
  generateText(systemPrompt: string, userPrompt: string): Promise<string>;
}

export interface ScribeState {
  idea: string;
  context?: string;
  targetStack?: string;
  conversation: ScribeMessageType[];
  clarificationRound: number;
  phase: 'clarifying' | 'generating' | 'done';
  pipelineId?: string;
  pendingQuestionIds: string[];
  answeredQuestionIds: string[];
  /** RAG-injected knowledge context — appended to system prompts */
  knowledgeContext?: string;
}

export type ScribeResult =
  | { type: 'clarification'; data: ScribeClarification }
  | { type: 'spec'; data: ScribeOutput }
  | { type: 'error'; error: PipelineError };

// ─── Constants ────────────────────────────────────

const MAX_CLARIFICATION_ROUNDS = 3;

const CLARIFICATION_SYSTEM_PROMPT = `You are Scribe, a conversational spec writer for a software project pipeline.

Your task is to analyze the user's project idea and determine what additional information is needed to create a comprehensive software specification.

Instructions:
1. Analyze the idea and identify missing REQUIRED information:
   - Core purpose (what will the app do?)
   - Target users (who will use it?)
   - MVP features (first version scope)
   - Technology preference (if any)

2. Identify missing OPTIONAL information:
   - Authentication type
   - Database preference
   - Third-party integrations
   - Deployment target (web, mobile, desktop)

3. If the idea is clear and detailed enough, respond with {"ready": true} to skip directly to spec generation.

4. If clarification is needed, generate 2-4 grouped questions. Each question must include:
   - A unique ID
   - The question text (in Turkish)
   - Why you're asking (brief reason, in Turkish)
   - Optional suggested answers

Output Format - respond ONLY with valid JSON:

If clarification needed:
{"ready": false, "questions": [{"id": "q1", "question": "...", "reason": "...", "suggestions": ["...", "..."]}]}

If ready to generate spec:
{"ready": true}

Rules:
- Questions must be in Turkish
- Do NOT assume the user's technical knowledge level
- Do NOT judge the idea
- Group related questions together
- Maximum 4 questions per round

Partial Answer Handling:
- If the user's answer only addresses some of the previously asked questions, acknowledge what was answered and re-ask ONLY the remaining unanswered questions.
- If the user provides short or incomplete answers, infer what you can and ask follow-up questions only for truly missing critical information.
- Do NOT repeat questions that the user has already answered, even if the answer was brief.
- If the user says something like "hepsini sen belirle" or "sana bırakıyorum", treat it as delegation — make reasonable assumptions and proceed to spec generation.`;

const SPEC_GENERATION_SYSTEM_PROMPT = `You are Scribe, a conversational spec writer for a software project pipeline.

Your task is to generate a comprehensive, structured software specification from the user's idea and any clarification answers.

BEFORE generating the StructuredSpec, perform these internal steps silently:

1. SELF-INTERROGATION: Ask yourself 5 clarifying questions about the user's idea.
   For each, assess: CLEAR (explicitly stated), ASSUMED (inferred), or UNKNOWN (not mentioned).

2. ASSUMPTION LOG: List every assumption you're making.
   Mark each as [HIGH-CONFIDENCE] or [LOW-CONFIDENCE].

3. AMBIGUITY SCORE: Rate overall clarity 1-5 across:
   - Problem scope (weight: 0.3)
   - Target user definition (weight: 0.2)
   - Success criteria specificity (weight: 0.3)
   - Technical constraints (weight: 0.2)

4. If ambiguity score < 3.5, include an "assumptions" array in your output
   listing all LOW-CONFIDENCE assumptions for human review.

5. ONLY THEN generate the StructuredSpec.

CRITICAL: All array fields MUST be JSON arrays [], never strings. Follow the exact structure below.

Respond ONLY with valid JSON matching this EXACT structure:
{
  "spec": {
    "title": "Proje Başlığı (3-8 kelime)",
    "problemStatement": "Bu proje şu sorunu çözüyor... (2-4 cümle)",
    "userStories": [
      {"persona": "Son kullanıcı", "action": "Uygulamaya giriş yapabilmeli", "benefit": "Kişiselleştirilmiş deneyim sunulması"},
      {"persona": "Yönetici", "action": "Kullanıcıları yönetebilmeli", "benefit": "Sistem kontrolü sağlanması"}
    ],
    "acceptanceCriteria": [
      {"id": "ac-1", "given": "Kullanıcı giriş sayfasında", "when": "Email ve şifre girip submit ettiğinde", "then": "Dashboard'a yönlendirilir"},
      {"id": "ac-2", "given": "Kullanıcı kayıtlı değilse", "when": "Kayıt formunu doldurduğunda", "then": "Hesap oluşturulur ve doğrulama emaili gönderilir"}
    ],
    "technicalConstraints": {
      "stack": "React + Node.js",
      "integrations": ["GitHub API", "OAuth 2.0"],
      "nonFunctional": ["Response time < 2s", "Mobile responsive"]
    },
    "outOfScope": ["Admin paneli", "Ödeme sistemi", "Mobil uygulama"]
  },
  "plan": {
    "projectName": "Proje Başlığı",
    "summary": "Bu projenin kullanıcı dostu özeti (1-2 cümle)",
    "features": [
      {"name": "Kullanıcı Girişi", "description": "Email ve şifre ile kimlik doğrulama"},
      {"name": "Dashboard", "description": "Ana sayfa istatistikleri ve hızlı erişim"}
    ],
    "techChoices": ["React", "Node.js", "PostgreSQL"],
    "estimatedFiles": 12,
    "requiresTests": true,
    "testRationale": "Yeni proje, iş mantığı içeren özellikler var"
  },
  "rawMarkdown": "# Proje Başlığı\\n\\n## Problem\\n...\\n\\n## User Stories\\n...\\n\\n## Kabul Kriterleri\\n...",
  "confidence": 0.85,
  "clarificationsAsked": 0,
  "reviewNotes": {
    "selfReviewPassed": true,
    "revisionsApplied": ["Made AC-3 more specific", "Removed vague 'should work well' from AC-2"],
    "assumptionsMade": ["Web tarayıcısı hedef platform olarak varsayıldı"]
  },
  "assumptions": ["Web tarayıcısı hedef platform olarak varsayıldı", "Kullanıcı girişi gerekmediği varsayıldı"]
}

PLAN FIELD RULES:
- "plan" is the human-friendly summary shown to the user for approval
- "plan.projectName" = same as "spec.title"
- "plan.features" = summarized from "spec.userStories" (grouped, user-friendly names)
- "plan.techChoices" = extracted from "spec.technicalConstraints.stack" (split by + or , into array)
- "plan.estimatedFiles" = estimate based on features count (typically features * 2 + 4 base files)
- "plan.requiresTests" = true if the project has business logic or UI interactions; false for docs-only, config, or styling changes
- "plan.testRationale" = brief explanation of why tests are or aren't needed (in Turkish)

IMPORTANT RULES:
- "userStories" MUST be a JSON ARRAY of objects with "persona", "action", "benefit" keys
- "acceptanceCriteria" MUST be a JSON ARRAY of objects with "id", "given", "when", "then" keys
- "outOfScope" MUST be a JSON ARRAY of strings
- "integrations" and "nonFunctional" MUST be JSON ARRAYS of strings (or omitted)
- "reviewNotes" MUST be a JSON OBJECT with "selfReviewPassed", "revisionsApplied", "assumptionsMade"
- "assumptions" MUST be a JSON ARRAY of strings (empty [] if ambiguity score >= 3.5)
- Spec content should be in Turkish
- rawMarkdown should be human-readable Turkish
- Be specific and actionable
- Do NOT add features the user didn't mention
- Keep MVP scope tight
- NEVER return string values where arrays are expected

AFTER generating the StructuredSpec, perform a SPEC SELF-REVIEW:

Checklist:
- [ ] Every User Story has at least one Acceptance Criterion
- [ ] No Acceptance Criterion uses vague language ("should work well", "fast enough")
- [ ] Given/When/Then steps are concrete and testable
- [ ] No scope creep beyond the user's stated idea
- [ ] Problem Statement is ≤3 sentences
- [ ] Technical Constraints are specific (not "use modern framework" but "React 18 + Vite")

If any check fails, revise the spec before returning it.
Record all revisions in "reviewNotes.revisionsApplied".

CONFIDENCE CALCULATION RULES:
- If the user answered ALL clarification questions: minimum confidence = 0.80
- If the spec has all 5 sections (Problem Statement, User Stories, Acceptance Criteria, Technical Constraints, Out of Scope): +0.10 bonus
- If every Acceptance Criterion follows Given/When/Then format: +0.05 bonus
- Maximum deduction for minor style or formatting issues: -0.05
- Target confidence range for typical well-defined projects: 0.80-0.95
- Never output confidence below 0.70 unless there are CRITICAL missing sections
- A simple but clearly defined project (like a calculator or todo app) should score at least 0.85`;

// ─── AI Response Normalization ───────────────────

/**
 * Normalizes raw AI JSON to fix common output mistakes before Zod validation.
 * Handles: string-instead-of-array, flat string userStories/acceptanceCriteria.
 */
function normalizeSpecResponse(raw: Record<string, unknown>): Record<string, unknown> {
  const spec = (raw.spec ?? raw) as Record<string, unknown>;

  // userStories: should be [{persona, action, benefit}, ...]
  if (typeof spec.userStories === 'string') {
    try {
      const parsed = JSON.parse(spec.userStories as string);
      spec.userStories = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      spec.userStories = [
        { persona: 'Kullanıcı', action: spec.userStories, benefit: 'Belirtilmedi' },
      ];
    }
  }

  // acceptanceCriteria: should be [{id, given, when, then}, ...]
  if (typeof spec.acceptanceCriteria === 'string') {
    try {
      const parsed = JSON.parse(spec.acceptanceCriteria as string);
      spec.acceptanceCriteria = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      spec.acceptanceCriteria = [
        { id: 'ac-1', given: 'Sistem hazır', when: spec.acceptanceCriteria, then: 'Belirtilmedi' },
      ];
    }
  }

  // outOfScope: should be string[]
  if (typeof spec.outOfScope === 'string') {
    try {
      const parsed = JSON.parse(spec.outOfScope as string);
      spec.outOfScope = Array.isArray(parsed) ? parsed : [String(parsed)];
    } catch {
      // Split comma-separated values into individual items
      spec.outOfScope = (spec.outOfScope as string)
        .split(/[,;]/)
        .map((s: string) => s.trim())
        .filter(Boolean);
      if ((spec.outOfScope as string[]).length === 0) {
        spec.outOfScope = [(spec.outOfScope as string)];
      }
    }
  }
  if (!Array.isArray(spec.outOfScope)) {
    spec.outOfScope = [];
  }

  // technicalConstraints nested arrays — split comma/space-separated values
  if (spec.technicalConstraints && typeof spec.technicalConstraints === 'object') {
    const tc = spec.technicalConstraints as Record<string, unknown>;
    if (typeof tc.integrations === 'string') {
      tc.integrations = (tc.integrations as string)
        .split(/[,;]/)
        .map((s: string) => s.trim())
        .filter(Boolean);
    }
    if (typeof tc.nonFunctional === 'string') {
      tc.nonFunctional = (tc.nonFunctional as string)
        .split(/[,;]/)
        .map((s: string) => s.trim())
        .filter(Boolean);
    }
  }

  if (raw.spec) {
    raw.spec = spec;
  }

  // plan: auto-generate from spec if AI didn't produce it
  if (!raw.plan && spec) {
    const techStack = typeof spec.stack === 'string' ? spec.stack : '';
    const tc = spec.technicalConstraints as Record<string, unknown> | undefined;
    const stackStr = (tc?.stack as string) ?? techStack;
    const features = Array.isArray(spec.userStories)
      ? (spec.userStories as Array<Record<string, string>>).map((us, i) => ({
          name: `Özellik ${i + 1}`,
          description: us.action ?? us.benefit ?? '',
        }))
      : [{ name: 'Ana özellik', description: String(spec.title ?? '') }];

    raw.plan = {
      projectName: String(spec.title ?? 'Proje'),
      summary: String(spec.problemStatement ?? ''),
      features,
      techChoices: stackStr ? stackStr.split(/[+,]/).map((s: string) => s.trim()).filter(Boolean) : [],
      estimatedFiles: Math.max(features.length * 2 + 4, 6),
      requiresTests: true,
      testRationale: 'Yeni proje — iş mantığı testleri gerekli',
    };
  }

  return raw;
}

// ─── ScribeAgent ──────────────────────────────────

export class ScribeAgent {
  private ai: ScribeAIDeps;

  constructor(ai: ScribeAIDeps) {
    this.ai = ai;
  }

  createInitialState(input: ScribeInput): ScribeState {
    return {
      idea: input.idea,
      context: input.context,
      targetStack: input.targetStack,
      conversation: [{ type: 'user_idea', content: input.idea }],
      clarificationRound: 0,
      phase: 'clarifying',
      pendingQuestionIds: [],
      answeredQuestionIds: [],
    };
  }

  async analyzIdea(state: ScribeState): Promise<ScribeResult> {
    const emit = state.pipelineId
      ? createActivityEmitter(state.pipelineId, 'scribe')
      : undefined;

    if (state.clarificationRound >= MAX_CLARIFICATION_ROUNDS) {
      return this.generateSpec(state);
    }

    const userPrompt = this.buildClarificationUserPrompt(state);

    emit?.('ai_call', 'Claude AI ile fikir analiz ediliyor...', 25);
    let responseText: string;
    try {
      const systemPrompt = state.knowledgeContext
        ? `${CLARIFICATION_SYSTEM_PROMPT}\n\n--- RETRIEVED KNOWLEDGE ---\n${state.knowledgeContext}\n--- END KNOWLEDGE ---`
        : CLARIFICATION_SYSTEM_PROMPT;
      responseText = await this.ai.generateText(systemPrompt, userPrompt);
    } catch {
      emit?.('error', 'AI çağrısı başarısız oldu', 0);
      return {
        type: 'error',
        error: createPipelineError(PipelineErrorCode.AI_PROVIDER_ERROR, 'Clarification AI call failed'),
      };
    }

    emit?.('parsing', 'AI yanıtı ayrıştırılıyor...', 65);
    let parsed: { ready: boolean; questions?: ScribeClarification['questions'] };
    try {
      parsed = parseAIJson(responseText);
    } catch {
      emit?.('error', 'AI yanıtı geçersiz JSON', 0);
      return {
        type: 'error',
        error: createPipelineError(PipelineErrorCode.AI_INVALID_RESPONSE, 'Invalid JSON from clarification'),
      };
    }

    if (parsed.ready) {
      return this.generateSpec(state);
    }

    const clarificationResult = ScribeClarificationSchema.safeParse({
      questions: parsed.questions,
    });

    if (!clarificationResult.success) {
      return this.generateSpec(state);
    }

    const clarification = clarificationResult.data;
    state.conversation.push({ type: 'clarification', content: clarification });
    state.clarificationRound++;

    // Track newly asked question IDs as pending
    const newQuestionIds = clarification.questions.map((q) => q.id);
    state.pendingQuestionIds = newQuestionIds;

    return { type: 'clarification', data: clarification };
  }

  processUserAnswer(state: ScribeState, answer: string): void {
    state.conversation.push({ type: 'user_answer', content: answer });

    if (state.pendingQuestionIds.length === 0) return;

    // Delegation phrases — user defers all decisions to the agent
    const delegationPhrases = [
      'hepsini sen belirle',
      'sana bırakıyorum',
      'sen karar ver',
      'sana bırakıyorum',
      'sen seç',
      'hepsini sana bırakıyorum',
    ];
    const lowerAnswer = answer.toLowerCase();
    const isDelegation = delegationPhrases.some((phrase) => lowerAnswer.includes(phrase));

    if (isDelegation) {
      // Mark all pending as answered
      state.answeredQuestionIds.push(...state.pendingQuestionIds);
      state.pendingQuestionIds = [];
      return;
    }

    // Check which question IDs are explicitly mentioned (e.g. "q1", "q2")
    const mentionedIds = state.pendingQuestionIds.filter((id) =>
      new RegExp(`\\b${id}\\b`, 'i').test(answer),
    );

    if (mentionedIds.length > 0) {
      state.answeredQuestionIds.push(...mentionedIds);
      state.pendingQuestionIds = state.pendingQuestionIds.filter(
        (id) => !mentionedIds.includes(id),
      );
    } else {
      // Default: mark all pending as answered (conservative — avoids re-asking)
      state.answeredQuestionIds.push(...state.pendingQuestionIds);
      state.pendingQuestionIds = [];
    }
  }

  async continueAfterAnswer(state: ScribeState): Promise<ScribeResult> {
    return this.analyzIdea(state);
  }

  async generateSpec(state: ScribeState): Promise<ScribeResult> {
    const emit = state.pipelineId
      ? createActivityEmitter(state.pipelineId, 'scribe')
      : undefined;

    state.phase = 'generating';
    const userPrompt = this.buildSpecGenerationUserPrompt(state);
    emit?.('ai_call', 'Yapılandırılmış spec oluşturuluyor...', 30);

    for (let attempt = 0; attempt <= RETRY_CONFIG.specValidationMaxRetries; attempt++) {
      let responseText: string;
      try {
        const specSystemPrompt = state.knowledgeContext
          ? `${SPEC_GENERATION_SYSTEM_PROMPT}\n\n--- RETRIEVED KNOWLEDGE ---\n${state.knowledgeContext}\n--- END KNOWLEDGE ---`
          : SPEC_GENERATION_SYSTEM_PROMPT;
        responseText = await this.ai.generateText(specSystemPrompt, userPrompt);
      } catch {
        if (attempt < RETRY_CONFIG.specValidationMaxRetries) continue;
        emit?.('error', 'Spec üretimi AI çağrısı başarısız', 0);
        return {
          type: 'error',
          error: createPipelineError(PipelineErrorCode.AI_PROVIDER_ERROR, 'Spec generation AI call failed'),
        };
      }

      emit?.('parsing', 'AI yanıtı yapılandırılmış formata ayrıştırılıyor...', 65);
      let rawParsed: unknown;
      try {
        rawParsed = parseAIJson(responseText);
      } catch {
        if (attempt < RETRY_CONFIG.specValidationMaxRetries) continue;
        return {
          type: 'error',
          error: createPipelineError(PipelineErrorCode.AI_INVALID_RESPONSE, 'Invalid JSON from spec generation'),
        };
      }

      // Normalize AI response before validation (fix string-instead-of-array etc.)
      if (rawParsed && typeof rawParsed === 'object') {
        rawParsed = normalizeSpecResponse(rawParsed as Record<string, unknown>);
      }

      const outputResult = ScribeOutputSchema.safeParse(rawParsed);
      if (!outputResult.success) {
        if (attempt < RETRY_CONFIG.specValidationMaxRetries) continue;
        return {
          type: 'error',
          error: createPipelineError(
            PipelineErrorCode.SCRIBE_SPEC_VALIDATION_FAILED,
            `Schema validation failed: ${outputResult.error.issues.map((i: { message: string }) => i.message).join(', ')}`
          ),
        };
      }

      const scribeOutput = outputResult.data;
      scribeOutput.clarificationsAsked = state.clarificationRound;

      const specCheck = isSpecMinimallyValid(scribeOutput.spec);
      if (!specCheck.valid) {
        if (attempt < RETRY_CONFIG.specValidationMaxRetries) continue;
        return {
          type: 'error',
          error: createPipelineError(
            PipelineErrorCode.SCRIBE_SPEC_VALIDATION_FAILED,
            `Minimum requirements not met: ${specCheck.issues.join(', ')}`
          ),
        };
      }

      emit?.('validation', `Spec oluşturuldu: ${scribeOutput.spec.userStories?.length || 0} user story, ${scribeOutput.spec.acceptanceCriteria?.length || 0} kabul kriteri`, 90);

      state.phase = 'done';
      state.conversation.push({ type: 'spec_draft', content: scribeOutput });
      emit?.('complete', 'Spec inceleme için hazır', 100);
      return { type: 'spec', data: scribeOutput };
    }

    return {
      type: 'error',
      error: createPipelineError(PipelineErrorCode.SCRIBE_SPEC_VALIDATION_FAILED, 'All retries exhausted'),
    };
  }

  async regenerateSpec(state: ScribeState, feedback: string): Promise<ScribeResult> {
    state.conversation.push({ type: 'spec_rejected', content: { feedback } });
    state.phase = 'generating';
    return this.generateSpec(state);
  }

  // ─── Private Helpers ──────────────────────────────

  private buildClarificationUserPrompt(state: ScribeState): string {
    const parts: string[] = [
      `Kullanıcının fikri: "${state.idea}"`,
    ];

    if (state.context) {
      parts.push(`\nÖNCEKİ PROJE BAĞLAMI (kullanıcı daha önce tamamlanmış bir projeden devam ediyor):\n${state.context}\n\nKullanıcının yeni mesajını bu bağlam çerçevesinde değerlendir. Daha önce belirlenmiş kararları tekrar sormaktan kaçın.`);
    }
    if (state.targetStack) {
      parts.push(`Teknoloji tercihi: ${state.targetStack}`);
    }

    parts.push(`Mevcut tur: ${state.clarificationRound + 1} / ${MAX_CLARIFICATION_ROUNDS}`);

    const previousQA = this.extractPreviousQA(state.conversation);
    if (previousQA.length > 0) {
      parts.push(`\nÖnceki sorular ve cevaplar:\n${previousQA}`);
    }

    if (state.pendingQuestionIds.length > 0) {
      parts.push(
        `\nHenüz cevaplanmamış soru ID'leri: ${state.pendingQuestionIds.join(', ')}` +
        `\nSADECE bu soruları tekrar sor, cevaplanmış olanları TEKRARLAMA.`,
      );
    }

    return parts.join('\n');
  }

  private buildSpecGenerationUserPrompt(state: ScribeState): string {
    const parts: string[] = [
      `Kullanıcının fikri: "${state.idea}"`,
      `Tamamlanan soru turları: ${state.clarificationRound}`,
    ];

    if (state.context) {
      parts.push(`\nÖNCEKİ PROJE BAĞLAMI (kullanıcı daha önce tamamlanmış bir projeden devam ediyor):\n${state.context}\n\nBu yeni spec'i oluştururken önceki projenin bağlamını göz önünde bulundur. Kullanıcı mevcut projeyi geliştirmek veya değiştirmek istiyor olabilir.`);
    }
    if (state.targetStack) {
      parts.push(`Teknoloji tercihi: ${state.targetStack}`);
    }

    const previousQA = this.extractPreviousQA(state.conversation);
    if (previousQA.length > 0) {
      parts.push(`\nTüm konuşma geçmişi:\n${previousQA}`);
    }

    return parts.join('\n');
  }

  private extractPreviousQA(conversation: ScribeMessageType[]): string {
    const lines: string[] = [];
    for (const msg of conversation) {
      if (msg.type === 'clarification') {
        for (const q of msg.content.questions) {
          lines.push(`S: ${q.question} (Neden: ${q.reason})`);
        }
      } else if (msg.type === 'user_answer') {
        lines.push(`C: ${msg.content}`);
      } else if (msg.type === 'spec_rejected') {
        const feedback = typeof msg.content === 'object' && msg.content !== null
          ? (msg.content as Record<string, unknown>).feedback
          : msg.content;
        lines.push(`[KULLANICI REDDETTİ — Geri bildirim: ${feedback}]`);
      }
    }
    return lines.join('\n');
  }

  // JSON extraction is now in shared utility:
  // import { parseAIJson, extractJsonSafe } from '../../core/json-extract.js';
}
