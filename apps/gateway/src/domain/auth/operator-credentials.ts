// The gateway's "single operator identity, deliberately not multi-tenant"
// (openapi.yaml `/auth/login`, `domain-model.md` §9). Pure comparison — no
// framework, no I/O, no hashing library: the credential PAIR itself lives
// in configuration (infrastructure/auth/operator.config.ts), this file only
// decides whether a submitted pair matches it. Kept in `domain/` because it
// is a rule, not a mechanism, and the ESLint domain-purity guard (CLAUDE.md
// non-negotiable) forbids this file from importing anything framework- or
// I/O-shaped anyway.

export interface OperatorIdentity {
  readonly username: string;
  readonly password: string;
  readonly displayName: string;
  readonly roles: readonly string[];
}

export interface OperatorCredentials {
  readonly username: string;
  readonly password: string;
}

/**
 * Constant-length comparison is deliberately NOT attempted here — this is a
 * single, statically-configured demo identity, not a multi-user credential
 * store, and a timing side-channel against one's own `.env` is not a
 * threat this system defends against (`domain-model.md` §9's own framing).
 * Kept simple and pure instead.
 */
export function matchesOperator(submitted: OperatorCredentials, configured: OperatorIdentity): boolean {
  return submitted.username === configured.username && submitted.password === configured.password;
}
