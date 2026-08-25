// JWT configuration (`.env.example` § JWT — `JWT_SECRET`, `JWT_EXPIRES_IN`,
// `JWT_ISSUER`, already present, per feature 25's own brief). Same
// env-driven-with-defaults shape every other `*.config.ts` in this repo
// uses.
export interface JwtConfig {
  readonly secret: string;
  readonly expiresIn: string;
  readonly issuer: string;
}

export function loadJwtConfig(env: NodeJS.ProcessEnv = process.env): JwtConfig {
  return {
    secret: env.JWT_SECRET ?? 'otc_dev_jwt_secret_change_me',
    expiresIn: env.JWT_EXPIRES_IN ?? '1h',
    issuer: env.JWT_ISSUER ?? 'order-to-cash',
  };
}
