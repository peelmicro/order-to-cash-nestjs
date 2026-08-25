// `GET /invoices`, `POST /invoices/{id}/payments` (openapi.yaml `billing` tag).
import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import type { Response } from 'express';
import { UniqueId } from '@otc/shared-kernel';
import type { PaymentRegisterReplyPayload } from '@otc/contracts';
import { RegisterPaymentCommand } from '../application/commands/register-payment.command';
import type { InvoicePage } from '../application/contracts-aliases';
import { ListInvoicesQuery } from '../application/queries/list-invoices.query';
import { RegisterPaymentRequestDto } from './dto/register-payment.dto';
import { parsePageParams } from './pagination';

function parseInvoiceId(id: string): string {
  try {
    return UniqueId.from(id).value;
  } catch {
    throw new BadRequestException({ field: 'id', message: `"${id}" is not a valid invoice id` });
  }
}

@Controller()
export class InvoicesController {
  constructor(
    @Inject(CommandBus) private readonly commands: CommandBus,
    @Inject(QueryBus) private readonly queries: QueryBus,
  ) {}

  @Get('invoices')
  async listInvoices(
    @Query('status') status: string | undefined,
    @Query('retailerCode') retailerCode: string | undefined,
    @Query('companyCode') companyCode: string | undefined,
    @Query('orderReference') orderReference: string | undefined,
    @Query('issuedBeforeMinutes') issuedBeforeMinutes: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
  ): Promise<InvoicePage> {
    const { page: parsedPage, pageSize: parsedPageSize } = parsePageParams({ page, pageSize });
    return this.queries.execute<ListInvoicesQuery, InvoicePage>(
      new ListInvoicesQuery({
        ...(status ? { status: status as 'issued' | 'paid' } : {}),
        retailerCode,
        companyCode,
        orderReference,
        ...(issuedBeforeMinutes !== undefined ? { issuedBeforeMinutes: Number(issuedBeforeMinutes) } : {}),
        page: parsedPage,
        pageSize: parsedPageSize,
      }),
    );
  }

  @Post('invoices/:id/payments')
  @HttpCode(201)
  async registerPayment(
    @Param('id') id: string,
    @Body() dto: RegisterPaymentRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const invoiceId = parseInvoiceId(id);
    const { reply, correlationId } = await this.commands.execute<RegisterPaymentCommand, { reply: PaymentRegisterReplyPayload; correlationId: string }>(
      new RegisterPaymentCommand(invoiceId, dto),
    );
    res.setHeader('X-Correlation-Id', correlationId);
    if (reply.outcome === 'duplicate') {
      res.status(200);
      res.setHeader('Idempotent-Replay', 'true');
    } else {
      res.status(201);
    }
    return reply as unknown as Record<string, unknown>;
  }
}
