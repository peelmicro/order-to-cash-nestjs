import { describe, expect, it, vi } from 'vitest';
import { MongoOrderReadModelAdapter } from './mongo-order-read-model.adapter';

function fakeCollection(overrides: Partial<Record<'findOne' | 'find' | 'countDocuments', unknown>> = {}) {
  return {
    findOne: vi.fn().mockResolvedValue(null),
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn().mockResolvedValue([]),
    }),
    countDocuments: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

describe('MongoOrderReadModelAdapter — R54 (read model only, never a write model)', () => {
  it('findById issues collection.findOne keyed on _id, excluding projector-internal fields', async () => {
    const collection = fakeCollection();
    const adapter = new MongoOrderReadModelAdapter(collection as never);

    await adapter.findById('order-1');

    expect(collection.findOne).toHaveBeenCalledWith({ _id: 'order-1' }, { projection: { statusRank: 0, processedEventKeys: 0 } });
  });

  it('findByOrderReference issues collection.findOne keyed on orderReference — the correlationId-resolution seam (register-payment.command.ts)', async () => {
    const collection = fakeCollection();
    const adapter = new MongoOrderReadModelAdapter(collection as never);

    await adapter.findByOrderReference('ORD-000042');

    expect(collection.findOne).toHaveBeenCalledWith({ orderReference: 'ORD-000042' }, { projection: { statusRank: 0, processedEventKeys: 0 } });
  });

  it('list() sorts by orderDate descending (openapi.yaml listOrders) and applies status/retailerCode/companyCode/orderReference filters', async () => {
    const cursor = { sort: vi.fn().mockReturnThis(), skip: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), toArray: vi.fn().mockResolvedValue([]) };
    const collection = fakeCollection({ find: vi.fn().mockReturnValue(cursor) });
    const adapter = new MongoOrderReadModelAdapter(collection as never);

    await adapter.list({ status: ['placed', 'confirmed'], retailerCode: 'CarrefourEs', companyCode: 'IBERFOODS', orderReference: 'ORD-000042', page: 2, pageSize: 10 });

    expect(collection.find).toHaveBeenCalledWith(
      {
        status: { $in: ['placed', 'confirmed'] },
        'retailer.code': 'CarrefourEs',
        'company.code': 'IBERFOODS',
        orderReference: 'ORD-000042',
      },
      { projection: { statusRank: 0, processedEventKeys: 0 } },
    );
    expect(cursor.sort).toHaveBeenCalledWith({ orderDate: -1 });
    expect(cursor.skip).toHaveBeenCalledWith(10); // (page 2 - 1) * pageSize 10
    expect(cursor.limit).toHaveBeenCalledWith(10);
  });
});
