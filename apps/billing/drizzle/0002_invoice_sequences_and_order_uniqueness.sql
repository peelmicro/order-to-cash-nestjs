-- billing_invoicing (feature 21): the INV-###### allocation counter and the
-- B7 uniqueness guarantee on invoices.order_reference, plus the read-side
-- index BI15's status + issuedBeforeMinutes filter needs.
--
-- Hand-trimmed after `drizzle-kit generate` — same precedent as
-- apps/fulfillment/drizzle/0002_despatch_number_sequence_and_order_reference_unique.sql:
-- meta/0001_snapshot.json was never updated to reflect 0001's outbox
-- changes (causation_id/seq/trace_parent), so the raw diff re-derived that
-- stale snapshot and re-issued the outbox ALTER statements migration 0001
-- already applied. Removed here so this migration touches only the
-- invoice-related tables it is named for; meta/0002_snapshot.json (the
-- input to the NEXT `drizzle-kit generate`) already carries the correct,
-- complete current schema, outbox included.
CREATE TABLE `invoice_number_sequences` (
	`id` tinyint NOT NULL,
	`next_value` int NOT NULL,
	CONSTRAINT `invoice_number_sequences_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `invoices` ADD CONSTRAINT `uq_invoices_order_reference` UNIQUE(`order_reference`);--> statement-breakpoint
CREATE INDEX `idx_invoices_status_invoice_date` ON `invoices` (`status`,`invoice_date`);
