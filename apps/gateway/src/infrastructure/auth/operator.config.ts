// The single operator identity (openapi.yaml `/auth/login`, `domain-model.md`
// §9 — "a single operator identity is assumed"). Review finding F5: the
// original submission left these as invisible defaults (`.env.example`
// carried no `GATEWAY_OPERATOR_*` key at all), so a deployer had no
// visible knob to override a credential-shaped value. `.env.example` now
// declares `GATEWAY_OPERATOR_USERNAME`/`GATEWAY_OPERATOR_PASSWORD`/
// `GATEWAY_OPERATOR_DISPLAY_NAME` explicitly, with the SAME
// `_change_me`-suffixed placeholder framing `JWT_SECRET` already uses —
// the fallback below is byte-identical to `.env.example`'s own value, the
// same "env var with a sensible dev default, visible in the template"
// shape every other `*.config.ts` in this repo uses (e.g.
// `mongo.config.ts`'s `MONGO_INITDB_ROOT_USERNAME`).
import type { OperatorIdentity } from '../../domain/auth/operator-credentials';

export function loadOperatorIdentity(env: NodeJS.ProcessEnv = process.env): OperatorIdentity {
  return {
    username: env.GATEWAY_OPERATOR_USERNAME ?? 'operator',
    password: env.GATEWAY_OPERATOR_PASSWORD ?? 'otc_operator_dev_password_change_me',
    displayName: env.GATEWAY_OPERATOR_DISPLAY_NAME ?? 'Order-To-Cash Operator',
    roles: ['operator'],
  };
}
