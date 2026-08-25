// Shared `page`/`pageSize` query-parameter parsing (openapi.yaml
// `components.parameters.Page`/`PageSize` — `page >= 1`, `1 <= pageSize <=
// 200`, defaults 1/25) — every list endpoint (`GET /orders`, `GET /stock`,
// `GET /invoices`, `GET /credits`) uses the SAME rule, so it lives once.
import { BadRequestException } from '@nestjs/common';

export interface PageParams {
  readonly page: number;
  readonly pageSize: number;
}

function parsePositiveInt(raw: string | undefined, field: string, fallback: number, min: number, max: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BadRequestException({ field, message: `"${raw}" is not a valid ${field} (expected an integer between ${min} and ${max})` });
  }
  return value;
}

export function parsePageParams(query: { page?: string; pageSize?: string }): PageParams {
  return {
    page: parsePositiveInt(query.page, 'page', 1, 1, Number.MAX_SAFE_INTEGER),
    pageSize: parsePositiveInt(query.pageSize, 'pageSize', 25, 1, 200),
  };
}

/** `status=a&status=b` (openapi `style: form, explode: true`) — Express/Nest already gives an array for a repeated query key, a single string for one occurrence. Normalises both to an array, `undefined` when the parameter was omitted entirely. */
export function toStringArray(raw: string | string[] | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return Array.isArray(raw) ? raw : [raw];
}
