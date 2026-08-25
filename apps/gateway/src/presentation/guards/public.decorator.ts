// Marks a route unauthenticated (openapi.yaml's own list: `POST /auth/login`,
// `GET /health/live`, `GET /health/ready`, `GET /docs`). `JwtAuthGuard`
// (a global `APP_GUARD`) checks this metadata via `Reflector` before
// requiring a bearer token — the idiomatic Nest "deny by default, opt out
// per-route" shape.
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = (): ReturnType<typeof SetMetadata> => SetMetadata(IS_PUBLIC_KEY, true);
