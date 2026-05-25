/* ─── Human-Friendly Plan (Layer 1) ─────────────── */

export interface UserFriendlyPlan {
  projectName: string;
  summary: string;
  features: PlanFeature[];
  techChoices: string[];
  estimatedFiles: number;
  requiresTests: boolean;
  testRationale?: string;
}

export interface PlanFeature {
  name: string;
  description: string;
}

/* ─── Change Plan (for subsequent requests) ─────── */

export interface ChangePlan {
  changeName: string;
  summary: string;
  modifiedFiles: FileChange[];
  newFiles: string[];
  requiresTests: boolean;
  testRationale?: string;
}

export interface FileChange {
  path: string;
  description: string;
}

/* ─── Plan Card State ───────────────────────────── */

export type PlanStatus = 'active' | 'edited' | 'reviewing' | 'approved' | 'rejected' | 'cancelled';

export interface PlanCardData {
  id: string;
  version: number;
  plan: UserFriendlyPlan | ChangePlan;
  status: PlanStatus;
  isChangeRequest: boolean;
}
