// A5 (observability_reliability design.md §4.3/§6): OTel bootstrap FIRST,
// before every other import — see apps/orders/src/infrastructure/observability/tracing.ts's header comment for why.
import './infrastructure/observability/tracing';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { AppModule, MONGO_DB } from './app.module';
import { loadKafkaConfig } from './infrastructure/messaging/kafka.config';
import { ensureReadModelIndexes } from './infrastructure/persistence/read-model-indexes';
import { backfillLegacyDocuments } from './infrastructure/persistence/legacy-document-backfill';
import { migrateTimelineOrder } from './infrastructure/persistence/timeline-order-migration';
import type { MongoHandle } from './infrastructure/persistence/mongo-client';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // `onApplicationShutdown` only ever fires from `app.close()`, and only
  // `enableShutdownHooks()` wires process signals (SIGTERM/SIGINT) to that
  // call — same finding as every other service's main.ts in this repo.
  app.enableShutdownHooks();

  // design.md §11 / PR22 / PR29 — BOTH run BEFORE any Kafka consumption
  // starts, against the SAME Mongo connection the DI container already
  // opened (`app.get`, not a second client): the read model's indexes must
  // exist before the very first upsert, and every pre-existing document
  // (everything apps/seed has ever written) must be backfilled before the
  // very first replayed fact — a fresh `projector` consumer group replays
  // EVERY fact `fromBeginning: true` (PR5), so skipping either step here
  // is not "run it later", it is a live R51/R52 violation on the first
  // boot (progress/spec_projector_read_model.md, open point 9).
  const { db } = await app.get<MongoHandle>(MONGO_DB);
  await ensureReadModelIndexes(db);
  const backfilled = await backfillLegacyDocuments(db);
  console.log(`[projector] legacy-document-backfill: ${backfilled} document(s) backfilled`);

  // Amendment A1 (PR32, PR35) — a SEPARATE, version-stamped migration from
  // the one above: every document written before A1 (and every document
  // written by an already-superseded rule) has its `events` order
  // frozen behind a stale `timelineOrderVersion`, and a terminal order
  // never receives another fact to self-heal it. Selected by comparing
  // the STORED version against the CURRENT one — never by field presence,
  // which is what let the rejected first attempt silently skip documents
  // it had already rewritten once its own rank table was corrected.
  const timelineOrderMigration = await migrateTimelineOrder(db);
  console.log(
    `[projector] timeline-order-migration: ${timelineOrderMigration.migrated} document(s) migrated, ` +
      `${timelineOrderMigration.stillEdgeless} of them still holding an entry with no causationId (PR35 — ordered by the eventId fallback, not causally repaired)`,
  );

  // Hybrid app: the HTTP port stays for health; ONE Kafka microservice
  // transport consumes all three fact topics
  // (presentation/projector-facts.controller.ts) — NO NATS microservice
  // transport (this service answers no RPC; its own outbound NATS
  // connection, opened by app.module.ts, is publish-only and never
  // registered as a `connectMicroservice` responder).
  //
  // `fromBeginning: true` (PR5) — DELIBERATELY the opposite of
  // Notifications' `false` (apps/notifications/src/main.ts's own N3
  // comment). Notifications' effect is an EXTERNAL side effect (an email);
  // replaying history there means emailing counterparties about
  // months-old orders. The projector's effect is INTERNAL and idempotent
  // (PR6/PR15); replaying history is how the read model is BUILT, and it
  // is the mechanism behind feature_list.json's own acceptance bullet
  // "replaying a topic reproduces an identical document".
  const kafkaConfig = loadKafkaConfig();
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: { clientId: kafkaConfig.clientId, brokers: [...kafkaConfig.brokers] },
      consumer: { groupId: kafkaConfig.groupId, sessionTimeout: 30000 },
      subscribe: { fromBeginning: true },
      run: { partitionsConsumedConcurrently: 1 },
    },
  });

  await app.startAllMicroservices();

  const port = Number(process.env.PROJECTOR_PORT ?? 3006);
  await app.listen(port);
  console.log(
    `[projector] listening on port ${port} (HTTP) and Kafka (${kafkaConfig.brokers.join(', ')})`,
  );
}

void bootstrap();
