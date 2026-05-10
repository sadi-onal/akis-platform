import {
  ScribeInputSchema,
  StructuredSpecSchema,
  ScribeOutputSchema,
  ScribeClarificationSchema,
} from '../../core/contracts/PipelineSchemas.js';
import type {
  ScribeInput,
  StructuredSpec,
  ScribeOutput,
  ScribeClarification,
} from '../../core/contracts/PipelineTypes.js';

export function validateScribeInput(input: unknown): ScribeInput {
  return ScribeInputSchema.parse(input);
}

export function validateStructuredSpec(spec: unknown): StructuredSpec {
  return StructuredSpecSchema.parse(spec);
}

export function validateScribeOutput(output: unknown): ScribeOutput {
  return ScribeOutputSchema.parse(output);
}

export function validateClarification(data: unknown): ScribeClarification {
  return ScribeClarificationSchema.parse(data);
}

export function isSpecMinimallyValid(spec: StructuredSpec): {
  valid: boolean;
  issues: string[];
} {
  const issues: string[] = [];

  if (spec.userStories.length === 0) {
    issues.push('En az 1 user story gerekli');
  }
  if (spec.acceptanceCriteria.length === 0) {
    issues.push('En az 1 acceptance criteria gerekli');
  }
  if (spec.title.length < 3) {
    issues.push('Başlık en az 3 karakter olmalı'); // allow:push
  }
  if (spec.problemStatement.length < 10) {
    issues.push('Problem tanımı en az 10 karakter olmalı'); // allow:push
  }

  return { valid: issues.length === 0, issues };
}
