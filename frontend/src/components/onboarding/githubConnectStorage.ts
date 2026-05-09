/**
 * SessionStorage key for the JIT GitHub gate's pending idea.
 * Set by GithubConnectGate before redirecting to OAuth, read by ChatPage's
 * OAuth-return effect to auto-resume the pipeline send.
 */
export const PENDING_GITHUB_IDEA_KEY = 'akis-pending-idea';
