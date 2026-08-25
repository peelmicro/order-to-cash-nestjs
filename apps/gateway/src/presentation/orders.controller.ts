// `POST /orders`, `GET /orders`, `GET /orders/{id}`, `POST /orders/{id}/cancel`
// (openapi.yaml `orders` tag).
import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import type { Response } from 'express';
import { UniqueId } from '@otc/shared-kernel';
import type { PlaceOrderResponse } from '@otc/contracts';
import { CancelOrderCommand } from '../application/commands/cancel-order.command';
import { PlaceOrderCommand } from '../application/commands/place-order.command';
import type { CancelOrderResponse, OrderSummaryPage } from '../application/contracts-aliases';
import { GetOrderQuery, type GetOrderResult } from '../application/queries/get-order.query';
import { ListOrdersQuery } from '../application/queries/list-orders.query';
import type { OrderDetailLike } from '../domain/projection/order-read-model-mapper';
import { CancelOrderRequestDto } from './dto/cancel-order.dto';
import { PlaceOrderRequestDto } from './dto/place-order.dto';
import { parsePageParams, toStringArray } from './pagination';

const PROJECTION_PENDING_RETRY_AFTER_SECONDS = 2;

function parseOrderId(id: string): string {
  try {
    return UniqueId.from(id).value;
  } catch {
    throw new BadRequestException({ field: 'id', message: `"${id}" is not a valid order id` });
  }
}

@Controller('orders')
export class OrdersController {
  constructor(
    @Inject(CommandBus) private readonly commands: CommandBus,
    @Inject(QueryBus) private readonly queries: QueryBus,
  ) {}

  @Post()
  @HttpCode(201)
  async placeOrder(
    @Body() dto: PlaceOrderRequestDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PlaceOrderResponse> {
    const result = await this.commands.execute<PlaceOrderCommand, PlaceOrderResponse>(
      new PlaceOrderCommand(dto, idempotencyKey),
    );
    res.setHeader('Location', `/orders/${result.orderId}`);
    res.setHeader('X-Correlation-Id', result.orderId);
    return result;
  }

  @Get()
  async listOrders(
    @Query('status') status: string | string[] | undefined,
    @Query('retailerCode') retailerCode: string | undefined,
    @Query('companyCode') companyCode: string | undefined,
    @Query('orderReference') orderReference: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
  ): Promise<OrderSummaryPage> {
    const { page: parsedPage, pageSize: parsedPageSize } = parsePageParams({ page, pageSize });
    return this.queries.execute<ListOrdersQuery, OrderSummaryPage>(
      new ListOrdersQuery({
        status: toStringArray(status),
        retailerCode,
        companyCode,
        orderReference,
        page: parsedPage,
        pageSize: parsedPageSize,
      }),
    );
  }

  @Get(':id')
  async getOrder(@Param('id') id: string, @Res({ passthrough: true }) res: Response): Promise<OrderDetailLike | Record<string, unknown>> {
    const orderId = parseOrderId(id);
    const result = await this.queries.execute<GetOrderQuery, GetOrderResult>(new GetOrderQuery(orderId));

    if (result.kind === 'found') {
      return result.detail;
    }

    if (result.kind === 'pending') {
      // R55 — "an order identifier that the caller has just been given":
      // `GetOrderHandler` only reaches this branch when `IssuedOrderWindow`
      // confirms THIS gateway itself handed out `orderId` recently
      // (`PlaceOrderHandler.execute` records it). An explicit "projection
      // pending" indication, never a bare 404, for exactly that case.
      res.status(202);
      res.setHeader('Retry-After', String(PROJECTION_PENDING_RETRY_AFTER_SECONDS));
      return {
        orderId,
        status: 'projection_pending',
        message: 'The order was accepted and is not projected yet. Subscribe to /orders/stream or retry.',
        retryAfterMs: PROJECTION_PENDING_RETRY_AFTER_SECONDS * 1000,
      };
    }

    // `result.kind === 'unknown'` — openapi.yaml's own words: "A genuine
    // 404 means the identifier is unknown to the system." This id was
    // never handed out by this gateway (or the recency window on it has
    // long since expired), so there is no honest "still catching up"
    // story left to tell.
    throw new NotFoundException({ orderId, message: `no order for id "${orderId}"` });
  }

  @Post(':id/cancel')
  @HttpCode(202)
  async cancelOrder(@Param('id') id: string, @Body() dto: CancelOrderRequestDto): Promise<CancelOrderResponse> {
    const orderId = parseOrderId(id);
    return this.commands.execute<CancelOrderCommand, CancelOrderResponse>(new CancelOrderCommand(orderId, dto?.note));
  }
}
