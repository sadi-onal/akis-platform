import { knowledgeRetrievalService } from './retrieval/KnowledgeRetrievalService.js';
import type { RetrievalResult, RetrievalFilter } from './retrieval/types.js';
import { getPiriRAGService } from '../rag/PiriRAGService.js';
import { logger } from '../../lib/logger.js';

export interface ContextLayer {
  role: 'system' | 'instruction' | 'data';
  label: string;
  content: string;
  provenance?: string;
}

export interface AssembledContext {
  layers: ContextLayer[];
  totalTokens: number;
  retrievedKnowledge: RetrievalResult[];
}

export interface ContextAssemblyOptions {
  agentType: string;
  jobInput?: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  retrievalQuery?: string;
  retrievalFilters?: RetrievalFilter;
  maxKnowledgeTokens?: number;
  includeProposedKnowledge?: boolean;
  piriContextQuery?: string;
  piriAdditionalContext?: string;
}

const PLATFORM_POLICY = `You are an AI agent in the AKIS platform.
- Always provide accurate, evidence-based responses
- Never fabricate information or make unsupported claims
- Cite sources when available using provenance references
- If you lack sufficient information, acknowledge it clearly
- Follow the specific agent contract and guidelines provided`;

const AGENT_IDENTITY_PACKS: Record<string, string> = {
  developer: `You are the Developer Agent, specialized in code generation and software development tasks.
Your outputs must follow the TASK/LOCATION/RULES format suitable for implementation.
You can propose Knowledge Base updates but cannot directly modify approved content.`,
  scribe: `You are the Scribe Agent, specialized in documentation and technical writing.
Your outputs must include provenance references for all facts and claims.
If evidence is insufficient, fail safely with a structured "missing input" outcome.`,
  default: `You are an AKIS Agent, ready to assist with development tasks.
Follow your specific contract guidelines and maintain output quality.`,
};

export class ContextAssemblyService {
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async assembleContext(options: ContextAssemblyOptions): Promise<AssembledContext> {
    const {
      agentType,
      jobInput,
      conversationHistory = [],
      retrievalQuery,
      retrievalFilters = {},
      maxKnowledgeTokens = 2000,
      includeProposedKnowledge = false,
      piriContextQuery,
      piriAdditionalContext,
    } = options;

    const layers: ContextLayer[] = [];
    let totalTokens = 0;

    layers.push({
      role: 'system',
      label: 'Platform Policy',
      content: PLATFORM_POLICY,
    });
    totalTokens += this.estimateTokens(PLATFORM_POLICY);

    const identityPack = AGENT_IDENTITY_PACKS[agentType] || AGENT_IDENTITY_PACKS.default;
    layers.push({
      role: 'instruction',
      label: 'Agent Identity',
      content: identityPack,
    });
    totalTokens += this.estimateTokens(identityPack);

    let retrievedKnowledge: RetrievalResult[] = [];
    if (retrievalQuery) {
      retrievedKnowledge = await knowledgeRetrievalService.search(retrievalQuery, {
        maxTokens: maxKnowledgeTokens,
        maxResults: 5,
        filters: {
          ...retrievalFilters,
          agentType,
        },
        includeProposed: includeProposedKnowledge,
      });

      if (retrievedKnowledge.length > 0) {
        const knowledgeContent = retrievedKnowledge
          .map((r, i) => {
            const provenance = r.provenance.sourcePath 
              ? `[${r.provenance.title}](${r.provenance.sourcePath})`
              : `[${r.provenance.title}]`;
            return `### Knowledge ${i + 1}: ${provenance}\n${r.content}`;
          })
          .join('\n\n');

        layers.push({
          role: 'data',
          label: 'Retrieved Knowledge',
          content: knowledgeContent,
          provenance: retrievedKnowledge.map(r => r.provenance.sourcePath || r.provenance.title).join(', '),
        });
        totalTokens += this.estimateTokens(knowledgeContent);
      }
    }

    // Piri RAG Knowledge layer — automatic RAG query if contextQuery is provided
    if (piriContextQuery) {
      const piriService = getPiriRAGService();
      if (piriService) {
        try {
          const piriResult = await piriService.query(piriContextQuery, 5, 500, 0.3);
          const piriContent = [
            `**Question:** ${piriResult.question}`,
            `**Answer:** ${piriResult.answer}`,
            ...(piriResult.sources.length > 0
              ? ['**Sources:**', ...piriResult.sources.map((s, i) => `  ${i + 1}. [${s.source}] ${s.content.slice(0, 300)}`)]
              : []),
          ].join('\n');

          layers.push({
            role: 'data',
            label: 'Piri RAG Knowledge',
            content: piriContent,
            provenance: 'piri-rag-engine',
          });
          totalTokens += this.estimateTokens(piriContent);
        } catch (piriError) {
          logger.warn(`[ContextAssembly] Piri RAG query failed (non-blocking): ${piriError instanceof Error ? piriError.message : String(piriError)}`);
        }
      }
    }

    // User-provided additional context from Piri sidebar (pre-fetched on frontend)
    if (piriAdditionalContext) {
      layers.push({
        role: 'data',
        label: 'User-Provided Piri Context',
        content: piriAdditionalContext,
        provenance: 'user-piri-sidebar',
      });
      totalTokens += this.estimateTokens(piriAdditionalContext);
    }

    if (jobInput) {
      layers.push({
        role: 'data',
        label: 'Job Input',
        content: jobInput,
      });
      totalTokens += this.estimateTokens(jobInput);
    }

    if (conversationHistory.length > 0) {
      const historyContent = conversationHistory
        .map(m => `${m.role}: ${m.content}`)
        .join('\n\n');
      
      layers.push({
        role: 'data',
        label: 'Conversation History',
        content: historyContent,
      });
      totalTokens += this.estimateTokens(historyContent);
    }

    return {
      layers,
      totalTokens,
      retrievedKnowledge,
    };
  }

  formatForPrompt(assembledContext: AssembledContext): string {
    const systemLayers = assembledContext.layers.filter(l => l.role === 'system');
    const instructionLayers = assembledContext.layers.filter(l => l.role === 'instruction');
    const dataLayers = assembledContext.layers.filter(l => l.role === 'data');

    const parts: string[] = [];

    if (systemLayers.length > 0) {
      parts.push('## SYSTEM INSTRUCTIONS\n' + systemLayers.map(l => l.content).join('\n\n'));
    }

    if (instructionLayers.length > 0) {
      parts.push('## AGENT GUIDELINES\n' + instructionLayers.map(l => l.content).join('\n\n'));
    }

    if (dataLayers.length > 0) {
      parts.push('## CONTEXT DATA\n' + dataLayers.map(l => `### ${l.label}\n${l.content}`).join('\n\n'));
    }

    return parts.join('\n\n---\n\n');
  }
}

export const contextAssemblyService = new ContextAssemblyService();
