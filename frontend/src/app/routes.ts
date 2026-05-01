/**
 * Canonical route paths.
 *
 * The chat-centric pivot replaced the legacy /dashboard tree with /chat as
 * the only authenticated landing page. Anywhere we used to write
 * `/dashboard` for "send the user home after auth", import POST_AUTH_PATH
 * instead so the surface stays consistent.
 */
export const POST_AUTH_PATH = '/chat';
