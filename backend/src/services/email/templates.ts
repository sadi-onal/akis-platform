/**
 * Email Templates — Turkish
 *
 * Professional HTML + text-fallback templates for AKIS Platform.
 * All user-facing copy is in Turkish per pilot requirements.
 *
 * PUBLIC_LOGO_URL is injected via env so the logo can live on any CDN
 * (or be omitted entirely when the var is empty).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return an <img> tag for the logo, or an <h1> fallback when no URL. */
function logoBlock(publicLogoUrl?: string): string {
  if (publicLogoUrl) {
    return `<img src="${publicLogoUrl}" alt="AKIS Platform" width="140" height="auto" style="display:block;margin:0 auto;" />`;
  }
  return '<h1 style="margin:0;font-size:28px;font-weight:700;">AKIS Platform</h1>';
}

/** Shared email layout wrapper (HTML). */
function layout(body: string, opts: { logoUrl?: string; year?: number } = {}): string {
  const year = opts.year ?? new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AKIS Platform</title>
  <!--[if mso]>
  <style>body{font-family:Arial,sans-serif;}</style>
  <![endif]-->
</head>
<body style="margin:0;padding:0;background:#0D1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0D1117;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
          <!-- Header -->
          <tr>
            <td style="background:#0A1215;padding:28px 32px;text-align:center;border-radius:12px 12px 0 0;border-bottom:2px solid #07D1AF;">
              ${logoBlock(opts.logoUrl)}
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="background:#161B22;padding:36px 32px;color:#E6EDF3;font-size:15px;line-height:1.65;">
              ${body}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#0A1215;padding:20px 32px;text-align:center;border-radius:0 0 12px 12px;">
              <p style="margin:0;font-size:12px;color:#8B949E;">
                &copy; ${year} AKIS Platform &mdash; AI-Powered Development Workflow Engine
              </p>
              <p style="margin:6px 0 0;font-size:11px;color:#484F58;">
                Bu e-posta AKIS Platform tarafından otomatik olarak gönderilmiştir.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Verification Code
// ---------------------------------------------------------------------------

export interface VerificationCodeParams {
  code: string;
  name?: string;
  ttlMinutes?: number;
  logoUrl?: string;
}

export function verificationCodeHtml(params: VerificationCodeParams): string {
  const { code, name, ttlMinutes = 15, logoUrl } = params;
  const greeting = name ? `Merhaba ${name},` : 'Merhaba,';

  const body = `
    <p style="margin:0 0 16px;color:#E6EDF3;">${greeting}</p>
    <p style="margin:0 0 20px;color:#C9D1D9;">
      AKIS Platform hesabınızı doğrulamak için aşağıdaki kodu kullanın:
    </p>
    <div style="text-align:center;margin:24px 0;">
      <div style="display:inline-block;background:#0D1117;border:2px solid #07D1AF;border-radius:12px;padding:18px 36px;">
        <span style="font-size:36px;font-weight:700;letter-spacing:10px;color:#07D1AF;font-family:monospace;">${code}</span>
      </div>
    </div>
    <p style="margin:0 0 8px;color:#C9D1D9;">
      Bu kod <strong style="color:#E6EDF3;">${ttlMinutes} dakika</strong> içinde geçerliliğini yitirecektir.
    </p>
    <p style="margin:0 0 24px;color:#8B949E;font-size:13px;">
      Bu kodu siz talep etmediyseniz bu e-postayı güvenle yok sayabilirsiniz.
    </p>
    <p style="margin:0;color:#C9D1D9;">
      Saygılarımızla,<br/>
      <strong style="color:#E6EDF3;">AKIS Ekibi</strong>
    </p>`;

  return layout(body, { logoUrl });
}

export function verificationCodeText(params: VerificationCodeParams): string {
  const { code, name, ttlMinutes = 15 } = params;
  const greeting = name ? `Merhaba ${name},` : 'Merhaba,';

  return `${greeting}

AKIS Platform hesabınızı doğrulamak için aşağıdaki kodu kullanın:

  ${code}

Bu kod ${ttlMinutes} dakika içinde geçerliliğini yitirecektir.

Bu kodu siz talep etmediyseniz bu e-postayı güvenle yok sayabilirsiniz.

Saygılarımızla,
AKIS Ekibi

© ${new Date().getFullYear()} AKIS Platform`;
}

// ---------------------------------------------------------------------------
// Welcome (post-verification)
// ---------------------------------------------------------------------------

export interface WelcomeParams {
  name?: string;
  loginUrl?: string;
  logoUrl?: string;
}

export function welcomeHtml(params: WelcomeParams): string {
  const { name, loginUrl = 'https://akisflow.com/login', logoUrl } = params;
  const greeting = name ? `Merhaba ${name},` : 'Merhaba,';

  const body = `
    <p style="margin:0 0 16px;color:#E6EDF3;">${greeting}</p>
    <p style="margin:0 0 16px;color:#C9D1D9;">
      AKIS Platform'a hoş geldiniz! Hesabınız başarıyla doğrulandı.
    </p>
    <p style="margin:0 0 20px;color:#C9D1D9;">
      AKIS, yazılım geliştirme süreçlerinizi yapay zekâ destekli ajanlarla hızlandırmanıza yardımcı olur.
      Scribe, Trace ve Proto ajanlarıyla projelerinizi bir üst seviyeye taşıyın.
    </p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${loginUrl}" style="display:inline-block;background:#07D1AF;color:#0A1215;font-weight:600;padding:12px 32px;border-radius:8px;text-decoration:none;font-size:15px;">
        Platforma Giriş Yap
      </a>
    </div>
    <p style="margin:0;color:#C9D1D9;">
      Saygılarımızla,<br/>
      <strong style="color:#E6EDF3;">AKIS Ekibi</strong>
    </p>`;

  return layout(body, { logoUrl });
}

export function welcomeText(params: WelcomeParams): string {
  const { name, loginUrl = 'https://akisflow.com/login' } = params;
  const greeting = name ? `Merhaba ${name},` : 'Merhaba,';

  return `${greeting}

AKIS Platform'a hoş geldiniz! Hesabınız başarıyla doğrulandı.

AKIS, yazılım geliştirme süreçlerinizi yapay zekâ destekli ajanlarla
hızlandırmanıza yardımcı olur. Scribe, Trace ve Proto ajanlarıyla
projelerinizi bir üst seviyeye taşıyın.

Giriş yap: ${loginUrl}

Saygılarımızla,
AKIS Ekibi

© ${new Date().getFullYear()} AKIS Platform`;
}

// ---------------------------------------------------------------------------
// Invite (foundation for WL-1 — stub with final Turkish copy)
// ---------------------------------------------------------------------------

export interface InviteParams {
  inviterName: string;
  recipientEmail: string;
  inviteUrl: string;
  logoUrl?: string;
}

export function inviteHtml(params: InviteParams): string {
  const { inviterName, inviteUrl, logoUrl } = params;

  const body = `
    <p style="margin:0 0 16px;color:#E6EDF3;">Merhaba,</p>
    <p style="margin:0 0 16px;color:#C9D1D9;">
      <strong style="color:#E6EDF3;">${inviterName}</strong> sizi AKIS Platform'a davet etti.
    </p>
    <p style="margin:0 0 20px;color:#C9D1D9;">
      AKIS, yapay zekâ destekli ajanlarla yazılım geliştirme süreçlerinizi otomatikleştirir
      ve hızlandırır. Hemen katılın ve deneyin.
    </p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${inviteUrl}" style="display:inline-block;background:#07D1AF;color:#0A1215;font-weight:600;padding:12px 32px;border-radius:8px;text-decoration:none;font-size:15px;">
        Daveti Kabul Et
      </a>
    </div>
    <p style="margin:0 0 8px;color:#8B949E;font-size:13px;">
      Bu bağlantı 7 gün süreyle geçerlidir.
    </p>
    <p style="margin:0;color:#C9D1D9;">
      Saygılarımızla,<br/>
      <strong style="color:#E6EDF3;">AKIS Ekibi</strong>
    </p>`;

  return layout(body, { logoUrl });
}

export function inviteText(params: InviteParams): string {
  const { inviterName, inviteUrl } = params;

  return `Merhaba,

${inviterName} sizi AKIS Platform'a davet etti.

AKIS, yapay zekâ destekli ajanlarla yazılım geliştirme süreçlerinizi
otomatikleştirir ve hızlandırır. Hemen katılın ve deneyin.

Daveti kabul edin: ${inviteUrl}

Bu bağlantı 7 gün süreyle geçerlidir.

Saygılarımızla,
AKIS Ekibi

© ${new Date().getFullYear()} AKIS Platform`;
}
