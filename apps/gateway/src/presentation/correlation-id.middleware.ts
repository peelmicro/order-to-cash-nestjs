// R58's "every line" guarantee needs ONE id, stamped once per inbound
// request, that every log line and response about that request can share
// — including the error path, which `problem-json.filter.ts` used to mint
// a FRESH `UniqueId.generate()` for instead (design.md §4.4's named
// defect, `observability_reliability` task A6b). This middleware is that
// one stamping point: mounted before every route (`app.module.ts`'s
// `configure(...)`), it runs before Nest's exception filters, guards and
// controllers alike, so `req.correlationId` is already set by the time
// ANYTHING downstream — including a thrown exception — needs it.
//
// Deliberately NOT the same value as a controller's own DOMAIN
// correlationId (an order id, an invoice/payment correlationId) — those
// are R12's aggregate-correlation convention and stay exactly as they
// are, set by each controller's own successful-response header. This is
// the one id available BEFORE any of that domain logic has run, so the
// error path — which by definition never reaches a domain correlationId
// — has something of its own to log and report consistently.
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { UniqueId } from '@otc/shared-kernel';

export interface RequestWithCorrelationId extends Request {
  correlationId?: string;
}

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: RequestWithCorrelationId, res: Response, next: NextFunction): void {
    const correlationId = UniqueId.generate().value;
    req.correlationId = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);
    next();
  }
}
