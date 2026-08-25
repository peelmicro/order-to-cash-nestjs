import type { OrderTimelineDocumentLike } from '../domain/projection/order-read-model-mapper';
import type { OrderListFilter, OrderListResult, OrderReadModel } from '../application/ports/order-read-model.port';

export class FakeOrderReadModel implements OrderReadModel {
  readonly documents: OrderTimelineDocumentLike[] = [];

  async findById(orderId: string): Promise<OrderTimelineDocumentLike | null> {
    return this.documents.find((doc) => doc.orderId === orderId) ?? null;
  }

  async findByOrderReference(orderReference: string): Promise<OrderTimelineDocumentLike | null> {
    return this.documents.find((doc) => doc.orderReference === orderReference) ?? null;
  }

  async list(_filter: OrderListFilter): Promise<OrderListResult> {
    return { items: this.documents, total: this.documents.length };
  }
}
