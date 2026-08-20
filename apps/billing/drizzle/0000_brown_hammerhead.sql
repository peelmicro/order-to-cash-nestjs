CREATE TABLE `credits` (
	`id` char(36) NOT NULL,
	`code` varchar(30) NOT NULL,
	`retailer_code` varchar(20) NOT NULL,
	`company_code` varchar(20) NOT NULL,
	`credit_limit` int NOT NULL,
	`currency_code` char(3) NOT NULL,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `credits_id` PRIMARY KEY(`id`),
	CONSTRAINT `credits_code_unique` UNIQUE(`code`),
	CONSTRAINT `uq_credits_retailer_company` UNIQUE(`retailer_code`,`company_code`)
);
--> statement-breakpoint
CREATE TABLE `credit_items` (
	`id` char(36) NOT NULL,
	`credit_id` char(36) NOT NULL,
	`order_reference` varchar(20) NOT NULL,
	`amount` int NOT NULL,
	`type` varchar(20) NOT NULL,
	`credit_date` datetime NOT NULL,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `credit_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` char(36) NOT NULL,
	`invoice_reference` varchar(20) NOT NULL,
	`invoice_date` datetime NOT NULL,
	`company_code` varchar(20) NOT NULL,
	`retailer_code` varchar(20) NOT NULL,
	`order_reference` varchar(20) NOT NULL,
	`amount` int NOT NULL,
	`discount` int NOT NULL,
	`total_amount` int NOT NULL,
	`currency_code` char(3) NOT NULL,
	`status` varchar(20) NOT NULL,
	`paid_at` datetime,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `invoices_id` PRIMARY KEY(`id`),
	CONSTRAINT `invoices_invoice_reference_unique` UNIQUE(`invoice_reference`)
);
--> statement-breakpoint
CREATE TABLE `invoice_items` (
	`id` char(36) NOT NULL,
	`invoice_id` char(36) NOT NULL,
	`product_code` varchar(30) NOT NULL,
	`units` int NOT NULL,
	`price` int NOT NULL,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `invoice_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` char(36) NOT NULL,
	`payment_reference` varchar(30) NOT NULL,
	`invoice_id` char(36) NOT NULL,
	`amount` int NOT NULL,
	`currency_code` char(3) NOT NULL,
	`value_date` datetime NOT NULL,
	`source` varchar(20) NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `payments_id` PRIMARY KEY(`id`),
	CONSTRAINT `payments_payment_reference_unique` UNIQUE(`payment_reference`)
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
ALTER TABLE `credit_items` ADD CONSTRAINT `credit_items_credit_id_credits_id_fk` FOREIGN KEY (`credit_id`) REFERENCES `credits`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_items` ADD CONSTRAINT `invoice_items_invoice_id_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payments` ADD CONSTRAINT `payments_invoice_id_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_credit_items_credit_order` ON `credit_items` (`credit_id`,`order_reference`);--> statement-breakpoint
CREATE INDEX `idx_outbox_published_occurred` ON `outbox` (`published_at`,`occurred_at`);