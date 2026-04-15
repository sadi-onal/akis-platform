# TECH 5 — Security Regression Gate

## Scientific Basis
LLMloop (ICSME 2025) — Iterative code generation caused 37.6% increase in critical vulnerabilities after 5 iterations with GPT-4o. A "no regression" gate is essential.

## File Boundary
`backend/src/pipeline/core/security-gate/` (NEW directory only)

## Structure
```
security-gate/
├── SecurityGate.ts              ← Main service
├── SecurityGateTypes.ts         ← Types
└── __tests__/
    └── SecurityGate.test.ts
```

## SecurityGateTypes.ts

```typescript
export interface SecurityScanResult {
  timestamp: Date;
  iteration: number;
  issues: Array<{
    severity: 'critical' | 'high' | 'medium' | 'low';
    category: string; // 'hardcoded-secret' | 'injection' | 'xss' | 'path-traversal' | 'eval'
    file: string;
    line?: number;
    description: string;
  }>;
  counts: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
  };
}

export interface SecurityGateDecision {
  allowed: boolean;
  reason: string;
  currentScan: SecurityScanResult;
  previousScan?: SecurityScanResult;
  regression?: {
    newIssues: number;
    resolvedIssues: number;
    netChange: number;
  };
}
```

## SecurityGate.ts Spec

- `scan(files: Array<{path: string, content: string}>): SecurityScanResult`
- `evaluate(currentScan: SecurityScanResult, previousScan?: SecurityScanResult): SecurityGateDecision`
  - First iteration (no previous): allowed if critical === 0
  - Subsequent: allowed if critical <= previous.critical AND high <= previous.high
  - Regression detected → allowed = false
- `checkRegression(current, previous): boolean` — true if security degraded

## Security Patterns to Detect
- Hardcoded secrets: `/(?:password|secret|api_key|token)\s*[:=]\s*['"][^'"]+['"]/gi`
- SQL injection: `/(?:query|exec|execute)\s*\([^)]*\+/gi`
- XSS: `/innerHTML\s*=|dangerouslySetInnerHTML|document\.write/gi`
- Path traversal: `/\.\.\//g` in file operations
- Eval: `/\beval\s*\(|new\s+Function\s*\(/gi`
- Insecure HTTP: `/http:\/\/(?!localhost)/gi`

## Tests (minimum 8 cases)
1. Clean code passes scan with 0 issues
2. Hardcoded secret detected as critical
3. eval() detected as high
4. Regression blocked (new critical appeared)
5. Improvement allowed (critical decreased)
6. First iteration with criticals → blocked
7. First iteration clean → allowed
8. Scan counts are correct
9. Multiple patterns in same file detected
10. Insecure HTTP detected

## CONSTRAINTS
- Do NOT touch any files outside `backend/src/pipeline/core/security-gate/`
- Do NOT modify .env files
- Run `pnpm -C backend typecheck` after implementation
- Run tests with `pnpm -C backend test:unit -- --testPathPattern security-gate`
