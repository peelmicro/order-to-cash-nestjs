// Place an order by sending a raw NATS request to `orders.create`.
// There is no Gateway until feature 25, so this stands in for it.
//
//   node scripts/place-order.mjs                 # normal order (should complete the happy path)
//   node scripts/place-order.mjs --over-limit    # exceeds the credit limit -> genuine compensation
//   node scripts/place-order.mjs --qty 21        # any quantity you like
//
// Requires the compose stack up and orders/fulfillment/billing running.
import { connect, StringCodec } from 'nats';
import { randomUUID } from 'node:crypto';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const overLimit = process.argv.includes('--over-limit');
const quantity = Number(arg('--qty', overLimit ? 21 : 2));

const request = {
  retailerCode: arg('--retailer', 'CarrefourEs'),
  companyCode:  arg('--company',  'IBERFOODS'),
  currency:     'EUR',
  lines: [{ productCode: arg('--product', 'PRD-0001'), quantity, lineDiscount: 0 }],
};

const nc = await connect({ servers: process.env.NATS_URL ?? 'nats://localhost:4222' });
const sc = StringCodec();
const headers = { 'x-correlation-id': randomUUID(), 'x-request-id': randomUUID() };

console.log(`→ orders.create  ${request.retailerCode}/${request.companyCode}  ${quantity} × ${request.lines[0].productCode}`);
try {
  const reply = await nc.request('orders.create', sc.encode(JSON.stringify({ ...request, headers })), { timeout: 10_000 });
  const body = JSON.parse(sc.decode(reply.data));
  console.log('← reply:', JSON.stringify(body, null, 2));
  if (body.orderReference) {
    console.log(`\nWatch it move:\n  docker exec otc-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "SELECT order_reference,status,cancellation_reason,total_amount FROM otc_orders.orders WHERE order_reference=\\"${body.orderReference}\\""'`);
  }
} catch (e) {
  console.error('✗ request failed:', e.message);
  console.error('  (is `pnpm dev:orders` running? is the compose stack up?)');
  process.exitCode = 1;
} finally {
  await nc.drain();
}
