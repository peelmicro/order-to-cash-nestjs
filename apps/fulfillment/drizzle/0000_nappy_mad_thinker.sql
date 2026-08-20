CREATE TABLE `stock` (
	`id` char(36) NOT NULL,
	`company_code` varchar(20) NOT NULL,
	`product_code` varchar(30) NOT NULL,
	`units` int NOT NULL,
	`reserved_units` int NOT NULL,
	`low_stock_threshold` int NOT NULL,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `stock_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_stock_company_product` UNIQUE(`company_code`,`product_code`)
);
--> statement-breakpoint
CREATE TABLE `reservations` (
	`id` char(36) NOT NULL,
	`stock_id` char(36) NOT NULL,
	`company_code` varchar(20) NOT NULL,
	`retailer_code` varchar(20) NOT NULL,
	`product_code` varchar(30) NOT NULL,
	`order_reference` varchar(20) NOT NULL,
	`units` int NOT NULL,
	`status` varchar(20) NOT NULL,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `reservations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `despatches` (
	`id` char(36) NOT NULL,
	`despatch_reference` varchar(20) NOT NULL,
	`despatch_date` datetime NOT NULL,
	`company_code` varchar(20) NOT NULL,
	`retailer_code` varchar(20) NOT NULL,
	`order_reference` varchar(20) NOT NULL,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `despatches_id` PRIMARY KEY(`id`),
	CONSTRAINT `despatches_despatch_reference_unique` UNIQUE(`despatch_reference`)
);
--> statement-breakpoint
CREATE TABLE `despatch_items` (
	`id` char(36) NOT NULL,
	`despatch_id` char(36) NOT NULL,
	`product_code` varchar(30) NOT NULL,
	`units` int NOT NULL,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `despatch_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` char(36) NOT NULL,
	`event_id` char(36) NOT NULL,
	`event_type` varchar(60) NOT NULL,
	`aggregate_id` char(36) NOT NULL,
	`correlation_id` char(36) NOT NULL,
	`payload` json NOT NULL,
	`occurred_at` datetime NOT NULL,
	`published_at` datetime,
	`created_at` datetime NOT NULL,
	CONSTRAINT `outbox_id` PRIMARY KEY(`id`),
	CONSTRAINT `outbox_event_id_unique` UNIQUE(`event_id`)
);
--> statement-breakpoint
CREATE TABLE `processed_events` (
	`id` char(36) NOT NULL,
	`event_id` char(36) NOT NULL,
	`consumer` varchar(50) NOT NULL,
	`processed_at` datetime NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `processed_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_processed_events_event_consumer` UNIQUE(`event_id`,`consumer`)
);
--> statement-breakpoint
ALTER TABLE `reservations` ADD CONSTRAINT `reservations_stock_id_stock_id_fk` FOREIGN KEY (`stock_id`) REFERENCES `stock`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `despatch_items` ADD CONSTRAINT `despatch_items_despatch_id_despatches_id_fk` FOREIGN KEY (`despatch_id`) REFERENCES `despatches`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_reservations_order_status` ON `reservations` (`order_reference`,`status`);--> statement-breakpoint
CREATE INDEX `idx_outbox_published_occurred` ON `outbox` (`published_at`,`occurred_at`);