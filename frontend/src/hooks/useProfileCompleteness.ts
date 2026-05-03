import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';

export interface ProfileCompleteness {
  isComplete: boolean;
  completedSteps: number;
  totalSteps: number;
  missingSteps: string[];
  loading: boolean;
  hasName: boolean;
  hasGitHub: boolean;
  hasAiKey: boolean;
}

export function useProfileCompleteness(): ProfileCompleteness {
  const { user } = useAuth();
  const [githubConnected, setGithubConnected] = useState(false);
  const [aiKeyConfigured, setAiKeyConfigured] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const [ghRes, aiRes] = await Promise.all([
          fetch('/api/integrations/github/status', { credentials: 'include' }).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch('/api/settings/ai-keys/status', { credentials: 'include' }).then(r => r.ok ? r.json() : null).catch(() => null),
        ]);
        if (cancelled) return;
        setGithubConnected(ghRes?.connected === true);
        setAiKeyConfigured(aiRes?.activeProvider != null);
      } catch {
        // silently fail
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    check();
    return () => { cancelled = true; };
  }, []);

  const hasName = Boolean(user?.name?.trim());
  const hasGitHub = githubConnected;
  const hasAiKey = aiKeyConfigured;

  const missing: string[] = [];
  if (!hasName) missing.push('profile');
  if (!hasGitHub) missing.push('github');
  if (!hasAiKey) missing.push('ai-provider');

  const totalSteps = 3;
  const completedSteps = [hasName, hasGitHub, hasAiKey].filter(Boolean).length;

  return {
    isComplete: completedSteps === totalSteps,
    completedSteps,
    totalSteps,
    missingSteps: missing,
    loading,
    hasName,
    hasGitHub,
    hasAiKey,
  };
}
