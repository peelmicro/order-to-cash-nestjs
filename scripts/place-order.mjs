// Place an order the way the future Gateway will: over NATS, using the same
// `@nestjs/microservices` client the Orders service's `@MessagePattern`
// expects. (A hand-rolled bare-JSON request does NOT work here — Nest treats
// an id-less packet as a fire-and-forget event and never replies, which is
// exactly the wire finding recorded in specs/fulfillment_stock/.)
//
//   pnpm order:place                 # 2 × PRD-0001 — normal order, runs the happy path
//   pnpm order:place --qty 1         # 1 × PRD-0001 = 24 999 → ends in .99 → simulated compensation
//   pnpm order:over-limit            # 21 × PRD-0001 → exceeds the credit limit → real compensation
//   pnpm order:place --qty 3 --product PRD-0002 --retailer AldiEs --company GERMANFOODS
//
// Needs: `pnpm dc:up:infra`, plus `pnpm dev:orders`, `dev:fulfillment` and
// `dev:billing` running (each in its own terminal).
import { ClientProxyFactory, Transport } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { timeout } from 'rxjs/operators';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const overLimit = process.argv.includes('--over-limit');
const quantity = Number(arg('--qty', overLimit ? 21 : 2));

const payload = {
  retailerCode: arg('--retailer', 'CarrefourEs'),
  companyCode: arg('--company', 'IBERFOODS'),
  currency: arg('--currency', 'EUR'),
  lines: [{ productCode: arg('--product', 'PRD-0001'), quantity }],
};

const client = ClientProxyFactory.create({
  transport: Transport.NATS,
  options: { servers: [process.env.NATS_URL ?? 'nats://localhost:4222'] },
});

console.log(`→ orders.create   ${payload.retailerCode} / ${payload.companyCode}   ${quantity} × ${payload.lines[0].productCode}`);
try {
  await client.connect();
  const reply = await firstValueFrom(client.send('orders.create', payload).pipe(timeout(15_000)));
  console.log('← reply:', JSON.stringify(reply, null, 2));

  if (reply?.orderReference) {
    const total = reply.totalAmount;
    const cents = typeof total === 'number' ? total % 100 : null;
    console.log(`\n  total ${total} minor units${cents === 99 ? '  → ends in .99, the simulator will reject this one' : ''}`);
    console.log(`\n  The saga runs asynchronously. Give it a second, then:\n    pnpm saga:watch`);
  }
} catch (e) {
  console.error('✗ failed:', e?.message ?? e);
  console.error('  Check: pnpm dc:up:infra, and dev:orders / dev:fulfillment / dev:billing all running.');
  process.exitCode = 1;
} finally {
  await client.close();
}
