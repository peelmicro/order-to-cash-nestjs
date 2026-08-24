// The two NATS responders (design.md §4.1) — `@MessagePattern(subject,
// Transport.NATS)`, dispatching on the `CommandBus` (issue) and the
// `QueryBus` (list). Subjects are the AsyncAPI addresses, guarded by
// `invoice.controller.spec.ts`'s read-the-spec-as-text assertion. Every
// `Transport.NATS` is explicit (CLAUDE.md non-negotiable + ESLint guard).
// A SEPARATE controller class from `CreditController`, not two more
// methods on it: they answer different aggregates and have different
// DTOs. This controller NEVER throws: validate → dispatch → `try/catch` →
// `toRpcError` — every outcome resolves the method with a plain object.
//
// **`billing.invoice.issue` has NO business rejection at all (`BI6`).**
// `domain-model.md` §7.2's fact catalogue has thirteen facts and none of
// them is an invoice refusal — unlike `billing.credit.hold`, there is no
// `invoice.rejected.v1` to distinguish from an `RpcError`. Therefore
// EVERY non-success on this subject is an `RpcError`, and the only two
// successful replies are `created: true` (a new invoice) and
// `created: false` (the idempotent repeat, `BI9`). A later reader should
// not go looking for a missing rejection branch — there isn't one.
import { Controller, Inject } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { Ctx, MessagePattern, Payload, Transport, type NatsContext } from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { InvoiceIssueReplyPayload, InvoiceListReplyPayload, PaymentRegisterReplyPayload, RpcError } from '@otc/contracts';
import { IssueInvoiceCommand } from '../application/commands/invoice.commands';
import { RegisterPaymentCommand } from '../application/commands/payment.commands';
import { ListInvoicesQuery } from '../application/queries/invoice.queries';
import { InvoiceIssueRequestDto, InvoiceListRequestDto } from './dto/invoice.dto';
import { PaymentRegisterRequestDto } from './dto/payment.dto';
import { missingHeadersRpcError, parseRpcMeta } from './rpc-meta';
import { toRpcError, validationRpcError } from './rpc-error-mapper';

export const INVOICE_ISSUE_SUBJECT = 'billing.invoice.issue';
export const INVOICE_LIST_SUBJECT = 'billing.invoice.list';
/**
 * `billing.payment.register` (feature 22, R47-R49). Lives on `InvoiceController`
 * rather than a third controller class: unlike `CreditController`'s split
 * from `InvoiceController` (a genuinely different aggregate, `BuyerCredit`),
 * this subject's primary written aggregate IS `Invoice` — the same one
 * `billing.invoice.issue` answers for.
 */
export const PAYMENT_REGISTER_SUBJECT = 'billing.payment.register';

@Controller()
export class InvoiceController {
  constructor(
    @Inject(QueryBus) private readonly queries: QueryBus,
    @Inject(CommandBus) private readonly commands: CommandBus,
  ) {}

  @MessagePattern(INVOICE_ISSUE_SUBJECT, Transport.NATS)
  async issue(@Payload() payload: unknown, @Ctx() ctx: NatsContext): Promise<InvoiceIssueReplyPayload | RpcError> {
    const dto = plainToInstance(InvoiceIssueRequestDto, payload ?? {});
    const violations = await validate(dto, { whitelist: true });
    if (violations.length > 0) {
      return validationRpcError(violations);
    }

    const meta = parseRpcMeta(ctx);
    if (!meta) {
      return missingHeadersRpcError();
    }

    try {
      return await this.commands.execute<IssueInvoiceCommand, InvoiceIssueReplyPayload>(
        new IssueInvoiceCommand(dto, meta.correlationId, meta.requestId),
      );
    } catch (error) {
      return toRpcError(error);
    }
  }

  /** `list` reads no headers, exactly as `credit.list` does not. */
  @MessagePattern(INVOICE_LIST_SUBJECT, Transport.NATS)
  async list(@Payload() payload: unknown): Promise<InvoiceListReplyPayload | RpcError> {
    const dto = plainToInstance(InvoiceListRequestDto, payload ?? {});
    const violations = await validate(dto, { whitelist: true });
    if (violations.length > 0) {
      return validationRpcError(violations);
    }

    try {
      return await this.queries.execute<ListInvoicesQuery, InvoiceListReplyPayload>(new ListInvoicesQuery(dto));
    } catch (error) {
      return toRpcError(error);
    }
  }

  /**
   * `billing.payment.register` (feature 22, R47-R49) — the only way an
   * invoice becomes `paid`. NO internal timer anywhere: this responder is
   * the sole trigger, reachable only by an incoming request.
   */
  @MessagePattern(PAYMENT_REGISTER_SUBJECT, Transport.NATS)
  async registerPayment(@Payload() payload: unknown, @Ctx() ctx: NatsContext): Promise<PaymentRegisterReplyPayload | RpcError> {
    const dto = plainToInstance(PaymentRegisterRequestDto, payload ?? {});
    const violations = await validate(dto, { whitelist: true });
    if (violations.length > 0) {
      return validationRpcError(violations);
    }

    const meta = parseRpcMeta(ctx);
    if (!meta) {
      return missingHeadersRpcError();
    }

    try {
      return await this.commands.execute<RegisterPaymentCommand, PaymentRegisterReplyPayload>(
        new RegisterPaymentCommand(dto, meta.correlationId, meta.requestId),
      );
    } catch (error) {
      return toRpcError(error);
    }
  }
}
