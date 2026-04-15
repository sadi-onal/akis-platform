/**
 * SecurityGateTypes — Types for the Security Regression Gate.
 *
 * Based on LLMloop (ICSME 2025) finding that iterative code generation
 * can cause 37.6% increase in critical vulnerabilities after 5 iterations.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type IssueCategory =
  | 'hardcoded-secret'
  | 'injection'
  | 'xss'
  | 'path-traversal'
  | 'eval'
  | 'insecure-http';

export interface SecurityIssue {
  severity: Severity;
  category: IssueCategory;
  file: string;
  line?: number;
  description: string;
}

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
}

export interface SecurityScanResult {
  timestamp: Date;
  iteration: number;
  issues: SecurityIssue[];
  counts: SeverityCounts;
}

export interface RegressionInfo {
  newIssues: number;
  resolvedIssues: number;
  netChange: number;
}

export interface SecurityGateDecision {
  allowed: boolean;
  reason: string;
  currentScan: SecurityScanResult;
  previousScan?: SecurityScanResult;
  regression?: RegressionInfo;
}

export interface FileInput {
  path: string;
  content: string;
}
