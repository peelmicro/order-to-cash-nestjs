// DI token for the single, statically-configured operator identity
// (`domain-model.md` §9) — bound in `app.module.ts` from
// `infrastructure/auth/operator.config.ts`. A plain value provider, not a
// "port with an adapter": there is exactly one identity and nothing to
// swap it for.
import type { OperatorIdentity } from '../../domain/auth/operator-credentials';

export const OPERATOR_IDENTITY = Symbol('OperatorIdentity');
export type { OperatorIdentity };
