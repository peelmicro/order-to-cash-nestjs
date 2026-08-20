ALTER TABLE `outbox` MODIFY COLUMN `occurred_at` datetime(3) NOT NULL;--> statement-breakpoint
ALTER TABLE `outbox` ADD `causation_id` char(36) NOT NULL;--> statement-breakpoint
ALTER TABLE `outbox` ADD `trace_parent` varchar(64);--> statement-breakpoint
ALTER TABLE `outbox` ADD `seq` bigint unsigned AUTO_INCREMENT UNIQUE;--> statement-breakpoint
CREATE INDEX `idx_outbox_unpublished_seq` ON `outbox` (`published_at`,`seq`);