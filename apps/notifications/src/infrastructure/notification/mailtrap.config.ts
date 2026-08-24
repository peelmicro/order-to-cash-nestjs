// Decides which `NotificationSender` adapter `app.module.ts` binds — the
// ONE place this decision is made, read from the process environment (see
// .env.example § Mailtrap, lines ~195-201; already populated there with
// `replace_me` placeholders and never touched by this feature).
//
// Binding rule (stated once, here): the Mailtrap adapter binds when
// `MAILTRAP_USER` AND `MAILTRAP_PASSWORD` are BOTH present and neither is
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
// than inside the returned `MailtrapConfig` itself, which the caller passes
// straight to `MailtrapNotificationSender` and nowhere else.
export interface MailtrapConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly fromEmail: string;
}

export type NotificationSenderBinding =
  | { readonly kind: 'console' }
  | { readonly kind: 'mailtrap'; readonly config: MailtrapConfig };

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
  const userConfigured = isConfigured(env.MAILTRAP_USER);
  const passwordConfigured = isConfigured(env.MAILTRAP_PASSWORD);

  if (!userConfigured && !passwordConfigured) {
    return { kind: 'console' };
  }

  if (userConfigured !== passwordConfigured) {
    throw new Error(
      'MAILTRAP_USER and MAILTRAP_PASSWORD must both be set to real values (or both left unset/"replace_me") — ' +
        'a partially configured Mailtrap credential pair is refused rather than silently falling back to the console adapter.',
    );
  }

  const host = env.MAILTRAP_HOST?.trim();
  if (!host) {
    throw new Error('MAILTRAP_HOST must be set when MAILTRAP_USER/MAILTRAP_PASSWORD are configured');
  }

  const fromEmail = env.MAILTRAP_FROM_EMAIL?.trim();
  if (!fromEmail) {
    throw new Error('MAILTRAP_FROM_EMAIL must be set when MAILTRAP_USER/MAILTRAP_PASSWORD are configured');
  }

  const portRaw = env.MAILTRAP_PORT?.trim();
  if (!portRaw) {
    throw new Error('MAILTRAP_PORT must be set when MAILTRAP_USER/MAILTRAP_PASSWORD are configured');
  }
  const port = Number(portRaw);
  if (!Number.isFinite(port) || !Number.isInteger(port) || port <= 0) {
    throw new Error(`MAILTRAP_PORT must be a positive integer; got ${JSON.stringify(portRaw)}`);
  }

  return {
    kind: 'mailtrap',
    config: { host, port, user: env.MAILTRAP_USER!, password: env.MAILTRAP_PASSWORD!, fromEmail },
  };
}
