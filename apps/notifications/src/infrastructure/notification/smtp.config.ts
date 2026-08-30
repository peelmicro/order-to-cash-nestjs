// Decides which `NotificationSender` adapter `app.module.ts` binds — the
// ONE place this decision is made, read from the process environment (see
// .env.example § SMTP, lines ~195-201; already populated there with
// `replace_me` placeholders and never touched by this feature).
//
// Provider-neutral by design (Mailpit migration, docker-compose.infra.yml's
// `mailpit` service header has the full "why"): this is a plain nodemailer-
// over-SMTP adapter — Mailpit locally, any real SMTP provider (Mailtrap
// included) in another environment, by pointing SMTP_HOST/SMTP_PORT
// elsewhere. Nothing in this file or `smtp-notification-sender.ts` is
// vendor-specific.
//
// Binding rule (stated once, here): the SMTP adapter binds when
// `SMTP_USER` AND `SMTP_PASSWORD` are BOTH present and neither is
// the literal placeholder `replace_me` left by `.env.example`; the console
// adapter binds when BOTH are absent/placeholder (the expected default dev
// state — not a misconfiguration). A PARTIAL pair — one real, one
// absent/placeholder — is refused outright: `CREDIT_FAILURE_RATE`'s
// precedent (`simulator-credit-decision.ts`'s header) is that a silently
// clamped/defaulted value makes a demo irreproducible for reasons invisible
// in the logs, and the same applies here — a half-configured credential
// pair is far more likely to be a copy-paste mistake than an intentional
// choice, so this throws synchronously rather than silently falling back to
// the console adapter.
//
// Never logs, echoes or returns the raw credential values anywhere other
// than inside the returned `SmtpConfig` itself, which the caller passes
// straight to `SmtpNotificationSender` and nowhere else.
export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly fromEmail: string;
}

export type NotificationSenderBinding =
  | { readonly kind: 'console' }
  | { readonly kind: 'smtp'; readonly config: SmtpConfig };

const PLACEHOLDER_VALUE = 'replace_me';

function isConfigured(value: string | undefined): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== PLACEHOLDER_VALUE;
}

export function resolveNotificationSenderBinding(
  env: NodeJS.ProcessEnv = process.env,
): NotificationSenderBinding {
  const userConfigured = isConfigured(env.SMTP_USER);
  const passwordConfigured = isConfigured(env.SMTP_PASSWORD);

  if (!userConfigured && !passwordConfigured) {
    return { kind: 'console' };
  }

  if (userConfigured !== passwordConfigured) {
    throw new Error(
      'SMTP_USER and SMTP_PASSWORD must both be set to real values (or both left unset/"replace_me") — ' +
        'a partially configured SMTP credential pair is refused rather than silently falling back to the console adapter.',
    );
  }

  const host = env.SMTP_HOST?.trim();
  if (!host) {
    throw new Error('SMTP_HOST must be set when SMTP_USER/SMTP_PASSWORD are configured');
  }

  const fromEmail = env.SMTP_FROM_EMAIL?.trim();
  if (!fromEmail) {
    throw new Error('SMTP_FROM_EMAIL must be set when SMTP_USER/SMTP_PASSWORD are configured');
  }

  const portRaw = env.SMTP_PORT?.trim();
  if (!portRaw) {
    throw new Error('SMTP_PORT must be set when SMTP_USER/SMTP_PASSWORD are configured');
  }
  const port = Number(portRaw);
  if (!Number.isFinite(port) || !Number.isInteger(port) || port <= 0) {
    throw new Error(`SMTP_PORT must be a positive integer; got ${JSON.stringify(portRaw)}`);
  }

  return {
    kind: 'smtp',
    config: { host, port, user: env.SMTP_USER!, password: env.SMTP_PASSWORD!, fromEmail },
  };
}
