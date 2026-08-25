// Place an order over NATS with `@nestjs/microservices`' own client.
//
// The header used to say a hand-rolled bare-JSON request "does NOT work here".
// That was true when written and is false now. Feature 25 found that
// `apps/orders/src/main.ts` was the ONLY service missing the
// `BareJsonNatsDeserializer`/`BareJsonNatsSerializer` pair that fulfillment and
// billing installed in phase 9 — so a bare-JSON caller (the Gateway, and the
// saga for the other two services) made `orders.create` run to completion and
// then time out with no reply, placing a real order and telling the caller it
// had failed. Orders now installs the pair, so BOTH wires work: bare JSON (see
// scripts/pay-invoice.mjs) and the Nest envelope this script uses. Verified by
// running both against the fixed responder with the pair installed and removed.
//
//   pnpm order:place                 # 2 × PRD-0001 — normal order, runs the happy path
//   pnpm order:place --qty 1         # 1 × PRD-0001 = 24 999 → ends in .99 → simulated compensation
//   pnpm order:over-limit            # 21 × PRD-0001 → exceeds the credit limit → real compensation
//   pnpm order:place --qty 3 --product PRD-0002 --retailer AldiEs --company GERMANFOODS
//   pnpm order:place --qty 2 --discount 300   # per-line discount → invoice total must equal the NET order total (BI21)
//
// Needs: `pnpm dc:up:infra`, plus `pnpm dev:orders`, `dev:fulfillment` and
// `dev:billing` running (each in its own terminal).
import { ClientProxyFactory, Transport } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { timeout } from 'rxjs/operators';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const overLimit = process.argv.includes('--over-limit');
const quantity = Number(arg('--qty', overLimit ? 21 : 2));
const lineDiscount = Number(arg('--discount', 0));

const payload = {
  retailerCode: arg('--retailer', 'CarrefourEs'),
  companyCode: arg('--company', 'IBERFOODS'),
  currency: arg('--currency', 'EUR'),
  lines: [{ productCode: arg('--product', 'PRD-0001'), quantity, ...(lineDiscount > 0 ? { lineDiscount } : {}) }],
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
