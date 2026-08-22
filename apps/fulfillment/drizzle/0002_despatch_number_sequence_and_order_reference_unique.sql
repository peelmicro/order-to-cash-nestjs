-- fulfillment_despatch (feature 18): the DES-###### allocation counter and
-- the F8 uniqueness guarantee on despatches.order_reference.
--
-- Hand-trimmed after `drizzle-kit generate` — see
-- progress/impl_fulfillment_despatch.md § Decisions for the full reasoning.
-- Short version: the raw diff re-derived a stale prior snapshot and would
-- have re-issued statements migration 0001 already applied against the
-- fact-relay table, which a byte-identity guard elsewhere in this monorepo
-- also does not want repeated in this file.
CREATE TABLE `despatch_number_sequences` (
	`id` tinyint NOT NULL,
	`next_value` int NOT NULL,
	CONSTRAINT `despatch_number_sequences_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `despatches` ADD CONSTRAINT `uq_despatches_order_reference` UNIQUE(`order_reference`);
