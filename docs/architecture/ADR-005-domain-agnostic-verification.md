# ADR-005: Domain-Agnostic Verification Architecture

## Status: Proposed (Horizon 3)

## Date: 2026-04-15

## Context

AKIS currently verifies software development outputs only. The same Produce > Review > Approve pattern applies to legal, financial, marketing, and other domains. The verification chain (Scribe > CriticSpec > Human Gate > Proto > CriticCode > Trace > FixLoop) is domain-specific in its implementation but domain-agnostic in its structure.

**Scientific basis:**
- TRiSM Framework (Gartner/ScienceDirect, 2026) identifies Trust, Risk, and Security Management as universal AI governance needs
- METR 2025 shows verification gaps exist across all AI-assisted workflows
- The adversarial review pattern (ASDLC.io) generalizes beyond code

## Decision

Design the verification chain as a pluggable system:

1. **Agent interface is domain-agnostic:** Input > Output with typed contracts
2. **Critic rules are domain-specific plugins:** `CriticRuleSet` interface
3. **Validation is domain-specific:** `ValidatorPlugin` interface
4. **Human gate is universal:** Always present, cannot be removed

## Proposed Interfaces

```typescript
/** Domain-specific critic ruleset */
interface CriticRuleSet {
  domain: string;
  rules: CriticRule[];
  scoringWeights: Record<string, number>;
}

interface CriticRule {
  id: string;
  name: string;
  category: string;
  evaluate(artifact: unknown): CriticFinding[];
}

/** Domain-specific validator plugin */
interface ValidatorPlugin {
  domain: string;
  validate(output: unknown): ValidationResult;
}

/** Domain configuration — everything needed to run a verification chain */
interface DomainConfig {
  name: string;
  stages: StageDefinition[];
  criticRules: CriticRuleSet;
  validator: ValidatorPlugin;
  humanGateConfig: {
    autoApproveThreshold?: number;
    requiredApprovers?: number;
  };
}

/** Generic stage definition */
interface StageDefinition {
  name: string;
  type: 'produce' | 'review' | 'validate' | 'human-gate' | 'fix-loop';
  config: Record<string, unknown>;
}
```

## Domain Examples

### Software Development (Current)
- Produce: Scribe + Proto (spec generation + code generation)
- Review: CriticSpec + CriticCode (adversarial LLM review)
- Validate: DeterministicValidator (AST, imports, security)
- Fix: FixLoop (Proto + Trace iteration)

### Legal Document Review (Future)
- Produce: DocumentDrafter (contract generation)
- Review: LegalCritic (clause compliance, risk assessment)
- Validate: RegulatoryValidator (jurisdiction checks, mandatory clauses)
- Fix: RevisionLoop (drafter + reviewer iteration)

### Financial Report (Future)
- Produce: ReportGenerator (financial analysis)
- Review: AuditCritic (GAAP compliance, ratio validation)
- Validate: NumberValidator (arithmetic consistency, source verification)
- Fix: CorrectionLoop (generator + auditor iteration)

## Consequences

### Positive
- New domains can be added without modifying core pipeline logic
- Critic rules and validators are independently testable
- Human gate remains universal safety net
- Existing software verification is the reference implementation

### Negative
- Increased abstraction complexity
- Plugin discovery and registration system needed
- Performance overhead from generic interfaces
- Testing surface area grows per domain

### Risks
- Over-abstraction before having real domain requirements
- Plugin compatibility issues across versions
- Security implications of running untrusted domain plugins

## Implementation Roadmap

1. **Phase 1 (Horizon 2):** Extract current software verification into the plugin format
2. **Phase 2 (Horizon 2):** Build plugin registry and discovery
3. **Phase 3 (Horizon 3):** First non-software domain (likely documentation)
4. **Phase 4 (Horizon 3):** ACP protocol for cross-domain agent communication
