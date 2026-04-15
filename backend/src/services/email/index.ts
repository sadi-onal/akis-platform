/**
 * Email Service Factory
 * Creates appropriate email service based on configuration
 */

import { EmailService } from './EmailService.js';
import { logger } from '../../lib/logger.js';
import { MockEmailService } from './MockEmailService.js';
import { ResendEmailService } from './ResendEmailService.js';
import { SmtpEmailService, isSmtpConfigured } from './SmtpEmailService.js';

export * from './EmailService.js';
export * from './MockEmailService.js';
export * from './ResendEmailService.js';
export * from './SmtpEmailService.js';
export * from './templates.js';

export type EmailProvider = 'mock' | 'resend' | 'smtp';

export interface EmailServiceFactoryConfig {
  provider: EmailProvider;
  // Resend
  apiKey?: string;
  fromEmail?: string;
  // SMTP
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  smtpFromName?: string;
  smtpFromEmail?: string;
  smtpReplyTo?: string;
  // Shared
  publicLogoUrl?: string;
  ttlMinutes?: number;
}

/**
 * Returns true when ANY real email provider is fully configured.
 * Safe for readiness probes — never throws.
 */
export function isEmailConfigured(provider: string): boolean {
  if (provider === 'smtp') return isSmtpConfigured();
  if (provider === 'resend') return !!(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
  // mock is always "configured"
  return provider === 'mock';
}

export function createEmailService(config: EmailServiceFactoryConfig): EmailService {
  // Always use mock in test environment
  if (process.env.NODE_ENV === 'test') {
    logger.info('[EmailService] Using MockEmailService (test environment)');
    return new MockEmailService();
  }

  // Use mock if explicitly requested
  if (config.provider === 'mock') {
    logger.info('[EmailService] Using MockEmailService (configured)');
    return new MockEmailService();
  }

  // SMTP provider (nodemailer)
  if (config.provider === 'smtp') {
    if (!config.smtpHost || !config.smtpUser || !config.smtpPass || !config.smtpFromEmail) {
      throw new Error(
        'EMAIL_PROVIDER is set to "smtp" but one or more SMTP_* vars are missing. ' +
        'Required: SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM_EMAIL. ' +
        'Use EMAIL_PROVIDER=mock for development.',
      );
    }

    logger.info(`[EmailService] Using SmtpEmailService (host=${config.smtpHost}, port=${config.smtpPort ?? 587})`);
    const service = new SmtpEmailService({
      host: config.smtpHost,
      port: config.smtpPort ?? 587,
      secure: config.smtpSecure ?? false,
      user: config.smtpUser,
      pass: config.smtpPass,
      fromName: config.smtpFromName ?? 'AKIS Platform',
      fromEmail: config.smtpFromEmail,
      replyTo: config.smtpReplyTo,
    });

    // Inject shared template options
    (service as unknown as { logoUrl: string | undefined }).logoUrl = config.publicLogoUrl;
    if (config.ttlMinutes) {
      (service as unknown as { ttlMinutes: number }).ttlMinutes = config.ttlMinutes;
    }

    return service;
  }

  // Resend provider
  if (config.provider === 'resend') {
    if (!config.apiKey || !config.fromEmail) {
      throw new Error(
        'EMAIL_PROVIDER is set to "resend" but RESEND_API_KEY or RESEND_FROM_EMAIL is missing. ' +
        'Please set these environment variables or use EMAIL_PROVIDER=mock for development.',
      );
    }

    logger.info('[EmailService] Using ResendEmailService');
    return new ResendEmailService({
      apiKey: config.apiKey,
      fromEmail: config.fromEmail,
    });
  }

  throw new Error(`Unknown email provider: ${config.provider}`);
}
