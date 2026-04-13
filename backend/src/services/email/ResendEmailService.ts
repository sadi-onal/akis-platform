/**
 * Resend Email Service
 * Real implementation using Resend API (or any compatible REST email provider)
 */

import { BaseEmailService, EmailMessage } from './EmailService.js';
import { logger } from '../../lib/logger.js';

export interface ResendEmailConfig {
  apiKey: string;
  fromEmail: string;
}

export class ResendEmailService extends BaseEmailService {
  private readonly apiKey: string;
  private readonly fromEmail: string;
  private readonly apiUrl = 'https://api.resend.com/emails';

  constructor(config: ResendEmailConfig) {
    super();
    this.apiKey = config.apiKey;
    this.fromEmail = config.fromEmail;
  }

  async sendEmail(message: EmailMessage): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.fromEmail,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`[ResendEmailService] Failed to send email: ${errorText}`);
        
        return {
          success: false,
          error: `Email provider returned ${response.status}: ${errorText}`,
        };
      }

      const result = await response.json();
      
      return {
        success: true,
        messageId: result.id,
      };
    } catch (error) {
      logger.error(`[ResendEmailService] Exception while sending email: ${error}`);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

