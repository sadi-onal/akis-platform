# TECH 1 — Deterministic Validator (AST + Lint + Type Check)

## Scientific Basis
arXiv:2601.19106 — AST analysis achieves 100% precision, 87.6% recall for detecting hallucinated API calls and wrong function signatures in LLM-generated code.

## File Boundary
`backend/src/pipeline/core/validator/` (NEW directory only)

## Structure
```
validator/
├── DeterministicValidator.ts    ← Main service
├── ValidatorTypes.ts            ← Types
├── checks/
│   ├── syntax-check.ts          ← Parse code, check for syntax errors
│   ├── import-check.ts          ← Verify all imports resolve to real packages
│   ├── type-consistency.ts      ← Check type annotations are internally consistent
│   └── security-check.ts        ← OWASP basic checks (hardcoded secrets, path traversal)
└── __tests__/
    └── DeterministicValidator.test.ts
```

## ValidatorTypes.ts

```typescript
export interface ValidationInput {
  files: Array<{
    path: string;
    content: string;
    language: string; // 'typescript' | 'javascript' | 'json' | 'html' | 'css'
  }>;
  spec?: unknown; // StructuredSpec for compliance checking
}

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  category: 'syntax' | 'import' | 'type' | 'security' | 'structure';
  file: string;
  line?: number;
  message: string;
  rule: string;
}

export interface ValidationResult {
  passed: boolean;
  score: number; // 0-100
  issues: ValidationIssue[];
  summary: {
    errors: number;
    warnings: number;
    infos: number;
    filesChecked: number;
    checksRun: string[];
  };
}
```

## DeterministicValidator.ts Spec

- `validate(input: ValidationInput): ValidationResult`
- NO LLM calls — purely deterministic
- **Syntax check:** Try to parse each file. For TS/JS use regex-based heuristics (matching braces, valid structure). Check valid JSON, valid HTML.
- **Import check:** Extract import statements, verify against a top-500 npm packages hardcoded list. Flag unknown packages as warnings. Flag relative imports to non-existent files as errors.
- **Security check:** Regex patterns for hardcoded secrets (API keys, passwords, tokens in code), SQL injection, eval(), innerHTML without sanitization.
- **Structure check:** Every file must have content. Package.json must be valid JSON. Entry point file must exist.
- **Score:** 100 - (errors * 10) - (warnings * 3) - (infos * 1), minimum 0
- **passed:** score >= 60 AND errors === 0

## Tests (minimum 10 cases)
1. Clean code passes with score 100
2. Syntax errors caught (mismatched braces)
3. Invalid JSON caught
4. Hardcoded secrets detected
5. Invalid/unknown imports flagged as warnings
6. Relative imports to nonexistent files flagged as errors
7. eval() usage detected
8. innerHTML usage detected
9. Score calculation correct (multiple issues)
10. passed=false when errors > 0 even if score >= 60
11. Empty file content flagged
12. SQL injection patterns detected

## CONSTRAINTS
- Do NOT touch any files outside `backend/src/pipeline/core/validator/`
- Do NOT modify .env files
- Run `pnpm -C backend typecheck` after implementation
- Run tests with `pnpm -C backend test:unit -- --testPathPattern validator`
