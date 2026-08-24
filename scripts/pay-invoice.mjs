// Register a remittance against an issued invoice, over NATS.
//
// Billing's responders are called by the saga with the RAW `nats` client and
// bare JSON, carrying `x-correlation-id`/`x-request-id` headers (BC1) — NOT the
// `@nestjs/microservices` envelope `orders.create` expects. This script speaks
// the same wire as the real caller (`apps/orders/.../nats-saga-commands.adapter.ts`).
//
//   pnpm invoice:list                                  # what is payable right now
//   pnpm invoice:pay --invoice INV-000012              # pays the invoice's exact total
//   pnpm invoice:pay --invoice INV-000012 --ref PAY-MINE-1
//   pnpm invoice:pay --invoice INV-000012 --amount 1   # wrong amount → R49 rejection
//   pnpm invoice:pay --invoice INV-000012 --correlation <order-uuid>
//
// IMPORTANT — `x-correlation-id` MUST be the ORDER'S UUID. `specs/shared/saga.md`
// makes `correlationId = orderId` a saga invariant, and Orders resolves the
// order with `findById(correlationId)`. Register a payment under any other
// correlation id and the payment IS recorded and the invoice DOES become paid,
// but Orders files the resulting fact as `unknown_order` in `saga_ignored_facts`
// and the order never leaves `invoiced`. Nothing in the payment contract carries
// the order id, and Orders exposes no lookup by reference — so pass it with
// `--correlation`, read from `otc_orders.orders.id`. See the note in
// `progress/current.md` (owner: feature 25, the Gateway).
//
// R47 pays only when amount AND currency equal the invoice's total. R48 makes a
// repeat of the same --ref idempotent. R49 rejects a mismatch, emitting no fact.
//
// Needs: `pnpm dc:up:infra`, plus `pnpm dev:orders`, `dev:fulfillment` and
// `dev:billing` running (each in its own terminal).
import { connect, headers as natsHeaders, JSONCodec } from 'nats';
import { randomUUID } from 'node:crypto';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const listOnly = process.argv.includes('--list');
const codec = JSONCodec();

const nc = await connect({ servers: process.env.NATS_URL ?? 'nats://localhost:4222' });

const correlation = arg('--correlation', null);

const rpcHeaders = () => {
  const h = natsHeaders();
  h.set('x-correlation-id', correlation ?? randomUUID());
  h.set('x-request-id', randomUUID());
  return h;
};

const send = async (subject, payload) => {
  const msg = await nc.request(subject, codec.encode(payload), { timeout: 15_000, headers: rpcHeaders() });
  return codec.decode(msg.data);
};

try {
  const issued = await send('billing.invoice.list', { status: 'issued', page: 1, pageSize: 200 });
  const items = issued?.items ?? [];

  if (listOnly) {
    console.log(`${items.length} invoice(s) currently issued and payable:\n`);
    for (const i of items) {
      console.log(`  ${i.invoiceReference}  ${i.orderReference}  ${i.totalAmount} ${i.currency}`);
    }
    process.exit(0);
  }

  const wanted = arg('--invoice', items[0]?.invoiceReference);
  if (!wanted) {
    console.error('✗ no issued invoices left to pay. Place an order first: pnpm order:place');
    process.exit(1);
  }

  // A named invoice is looked up across ALL statuses, not just `issued` —
  // re-registering against an already-paid invoice is exactly how R48's
  // idempotency and the N11 cross-invoice conflict are demonstrated.
  let invoice = items.find((i) => i.invoiceReference === wanted);
  if (!invoice) {
    const all = await send('billing.invoice.list', { page: 1, pageSize: 200 });
    invoice = (all?.items ?? []).find((i) => i.invoiceReference === wanted);
  }
  if (!invoice) {
    console.error(`✗ no invoice ${wanted} exists. Run: pnpm invoice:list`);
    process.exit(1);
  }
  if (invoice.status === 'paid') {
    console.log(`  (${wanted} is already paid — expecting an idempotent or conflicting answer, not a new payment)`);
  }

  const total = invoice.totalAmount;
  const amount = Number(arg('--amount', total));
  const paymentReference = arg('--ref', `PAY-${wanted.replace('INV-', '')}`);

  const payload = {
    invoiceReference: wanted,
    paymentReference,
    amount: { amount, currency: invoice.currency },
    valueDate: new Date().toISOString(),
    source: 'operator',
  };

  console.log(`→ billing.payment.register   ${wanted}   ${amount} ${invoice.currency}   ref ${paymentReference}`);
  if (amount !== total) {
    console.log(`  (invoice total is ${total} — a mismatch, so R49 must reject this and emit no fact)`);
  }

  const reply = await send('billing.payment.register', payload);
  console.log('← reply:', JSON.stringify(reply, null, 2));

  // Only meaningful once a payment was actually ACCEPTED — a rejection or a
  // conflict pays nothing, so warning about the order's status there is noise.
  if (reply?.outcome === 'accepted' && !correlation) {
    console.log('\n  ⚠ paid, but no --correlation was given, so the ORDER stays `invoiced`.');
    console.log('    Orders resolves the order by correlationId = orderId. To complete it:');
    console.log(`      docker exec otc-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N -B -e "SELECT id FROM otc_orders.orders WHERE order_reference=\\"${invoice.orderReference}\\";"'`);
    console.log('    then re-run with --correlation <that id> against the NEXT invoice.');
  } else if (reply?.outcome === 'accepted') {
    console.log(`\n  Watch the order reach its final status:\n    pnpm saga:watch`);
  }
} catch (e) {
  // NATS answers 503 NO_RESPONDERS when nothing is subscribed to the subject.
  // Bare "503" is useless to a human, so name the actual cause.
  const code = String(e?.code ?? e?.message ?? e);
  if (code.includes('503') || /no responder/i.test(code)) {
    console.error('✗ no NATS responder — the Billing service is not running.');
    console.error('');
    console.error('  Start all three, each in its OWN terminal, and wait for "listening on port":');
    console.error('    pnpm dev:orders        # port 3002');
    console.error('    pnpm dev:fulfillment   # port 3003');
    console.error('    pnpm dev:billing       # port 3004   <- this one answers billing.*');
    console.error('');
    console.error('  Then re-run this command in a fourth terminal.');
  } else {
    console.error('✗ failed:', e?.message ?? e);
    console.error('  Check: pnpm dc:up:infra, and dev:orders / dev:fulfillment / dev:billing all running.');
  }
  process.exitCode = 1;
} finally {
  await nc.drain();
}
