import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { userAiKeys, users, type UserAiKey } from '../../db/schema.js';
import { decryptSecret, encryptSecret } from '../../utils/crypto.js';

/**
 * Supported AI providers. PR-A removed `'openrouter'`; OpenAI is type-level
 * supported but the runtime client (and modelAllowlist entry) lands in PR-B B5.
 */
export type AIKeyProvider = 'anthropic' | 'openai';

export type AIKeyStatus = {
  provider: AIKeyProvider;
  configured: boolean;
  last4: string | null;
  updatedAt: string | null;
};

export type MultiProviderStatus = {
  /** User's explicitly set active provider, or null if never set */
  activeProvider: AIKeyProvider | null;
  providers: {
    anthropic: Omit<AIKeyStatus, 'provider'>;
    openai: Omit<AIKeyStatus, 'provider'>;
  };
};

/** Trims whitespace from an API key string. */
export function normalizeApiKey(key: string): string {
  return key.trim();
}

function buildScope(userId: string, provider: AIKeyProvider): string {
  return `${userId}:${provider}`;
}

/**
 * Retrieves the AI key status for a user-provider pair.
 * @param userId - The user's ID
 * @param provider - The AI provider (anthropic or openai)
 * @returns Status including whether configured, last 4 chars, and update time
 */
export async function getUserAiKeyStatus(
  userId: string,
  provider: AIKeyProvider
): Promise<AIKeyStatus> {
  const record = await db.query.userAiKeys.findFirst({
    where: and(eq(userAiKeys.userId, userId), eq(userAiKeys.provider, provider)),
  });

  return {
    provider,
    configured: Boolean(record),
    last4: record?.last4 ?? null,
    updatedAt: record?.updatedAt ? record.updatedAt.toISOString() : null,
  };
}

/**
 * Creates or updates an encrypted AI key for a user-provider pair.
 * @param userId - The user's ID
 * @param provider - The AI provider (anthropic or openai)
 * @param apiKey - The raw API key to encrypt and store
 * @returns Updated key status
 */
export async function upsertUserAiKey(
  userId: string,
  provider: AIKeyProvider,
  apiKey: string
): Promise<AIKeyStatus> {
  const normalized = normalizeApiKey(apiKey);
  const last4 = normalized.slice(-4);
  const encrypted = encryptSecret(normalized, buildScope(userId, provider));
  const now = new Date();

  await db
    .insert(userAiKeys)
    .values({
      userId,
      provider,
      encryptedKey: encrypted.cipherText,
      keyIv: encrypted.iv,
      keyTag: encrypted.authTag,
      keyVersion: encrypted.keyVersion,
      last4,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userAiKeys.userId, userAiKeys.provider],
      set: {
        encryptedKey: encrypted.cipherText,
        keyIv: encrypted.iv,
        keyTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
        last4,
        updatedAt: now,
      },
    });

  return {
    provider,
    configured: true,
    last4,
    updatedAt: now.toISOString(),
  };
}

/**
 * Removes an AI key for a user-provider pair.
 * @param userId - The user's ID
 * @param provider - The AI provider to delete the key for
 */
export async function deleteUserAiKey(
  userId: string,
  provider: AIKeyProvider
): Promise<void> {
  await db
    .delete(userAiKeys)
    .where(and(eq(userAiKeys.userId, userId), eq(userAiKeys.provider, provider)));
}

/**
 * Retrieves and decrypts a user's API key from the database.
 * @param userId - The user's ID
 * @param provider - The AI provider
 * @returns Decrypted key and DB record, or null if not found
 */
export async function getDecryptedUserAiKey(
  userId: string,
  provider: AIKeyProvider
): Promise<{ key: string; record: UserAiKey } | null> {
  const record = await db.query.userAiKeys.findFirst({
    where: and(eq(userAiKeys.userId, userId), eq(userAiKeys.provider, provider)),
  });

  if (!record) {
    return null;
  }

  const decrypted = decryptSecret(
    {
      cipherText: record.encryptedKey,
      iv: record.keyIv,
      authTag: record.keyTag,
      keyVersion: record.keyVersion,
    },
    buildScope(userId, provider)
  );

  return { key: decrypted, record };
}

/**
 * Get multi-provider status including active provider for a user
 * Note: activeProvider is null if user has never explicitly set one
 */
export async function getMultiProviderStatus(userId: string): Promise<MultiProviderStatus> {
  // Get user's active provider (may be null if never set)
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { activeAiProvider: true },
  });

  // Do NOT apply hard default here - let orchestrator handle fallback logic
  const activeProvider: AIKeyProvider | null = (user?.activeAiProvider as AIKeyProvider) || null;

  // Get status for all providers
  const [anthropicStatus, openaiStatus] = await Promise.all([
    getUserAiKeyStatus(userId, 'anthropic'),
    getUserAiKeyStatus(userId, 'openai'),
  ]);

  return {
    activeProvider,
    providers: {
      anthropic: {
        configured: anthropicStatus.configured,
        last4: anthropicStatus.last4,
        updatedAt: anthropicStatus.updatedAt,
      },
      openai: {
        configured: openaiStatus.configured,
        last4: openaiStatus.last4,
        updatedAt: openaiStatus.updatedAt,
      },
    },
  };
}

/**
 * Set user's active AI provider
 */
export async function setUserActiveProvider(
  userId: string,
  provider: AIKeyProvider
): Promise<AIKeyProvider> {
  await db
    .update(users)
    .set({ activeAiProvider: provider, updatedAt: new Date() })
    .where(eq(users.id, userId));

  return provider;
}

/**
 * Get user's active AI provider
 * Returns null if user has never explicitly set an active provider
 * (Orchestrator applies deterministic fallback: payload > userActive > env)
 */
export async function getUserActiveProvider(userId: string): Promise<AIKeyProvider | null> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { activeAiProvider: true },
  });

  // Do NOT return hard default - let orchestrator handle fallback
  return (user?.activeAiProvider as AIKeyProvider) || null;
}
