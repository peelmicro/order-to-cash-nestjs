CREATE TABLE `currencies` (
	`id` char(36) NOT NULL,
	`code` varchar(3) NOT NULL,
	`iso_number` varchar(3) NOT NULL,
	`symbol` varchar(5) NOT NULL,
	`decimal_points` int NOT NULL,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `currencies_id` PRIMARY KEY(`id`),
	CONSTRAINT `currencies_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` char(36) NOT NULL,
	`code` varchar(30) NOT NULL,
	`ean` varchar(13) NOT NULL,
	`name` varchar(100) NOT NULL,
	`description` varchar(255) NOT NULL,
	`price` int NOT NULL,
	`currency_id` char(36) NOT NULL,
	`disabled_at` datetime,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `products_id` PRIMARY KEY(`id`),
	CONSTRAINT `products_code_unique` UNIQUE(`code`),
	CONSTRAINT `products_ean_unique` UNIQUE(`ean`)
);
--> statement-breakpoint
CREATE TABLE `retailers` (
	`id` char(36) NOT NULL,
	`code` varchar(20) NOT NULL,
	`name` varchar(100) NOT NULL,
	`country` char(2) NOT NULL,
	`vat` varchar(15) NOT NULL,
	`gln` varchar(13) NOT NULL,
	`currency_id` char(36) NOT NULL,
	`disabled_at` datetime,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `retailers_id` PRIMARY KEY(`id`),
	CONSTRAINT `retailers_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `companies` (
	`id` char(36) NOT NULL,
	`code` varchar(20) NOT NULL,
	`name` varchar(100) NOT NULL,
	`country` char(2) NOT NULL,
	`vat` varchar(15) NOT NULL,
	`gln` varchar(13) NOT NULL,
	`currency_id` char(36) NOT NULL,
	`disabled_at` datetime,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `companies_id` PRIMARY KEY(`id`),
	CONSTRAINT `companies_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` char(36) NOT NULL,
	`order_reference` varchar(20) NOT NULL,
	`order_date` datetime NOT NULL,
	`company_id` char(36) NOT NULL,
	`retailer_id` char(36) NOT NULL,
	`currency_id` char(36) NOT NULL,
	`initial_amount` int NOT NULL,
	`initial_discount` int NOT NULL,
	`total_amount` int NOT NULL,
	`status` varchar(20) NOT NULL,
	`cancellation_reason` varchar(100),
	`notes` text,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `orders_order_reference_unique` UNIQUE(`order_reference`)
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` char(36) NOT NULL,
	`order_id` char(36) NOT NULL,
	`product_id` char(36) NOT NULL,
	`price` int NOT NULL,
	`quantity` int NOT NULL,
	`discount` int NOT NULL,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `order_items_id` PRIMARY KEY(`id`)
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
ALTER TABLE `products` ADD CONSTRAINT `products_currency_id_currencies_id_fk` FOREIGN KEY (`currency_id`) REFERENCES `currencies`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `retailers` ADD CONSTRAINT `retailers_currency_id_currencies_id_fk` FOREIGN KEY (`currency_id`) REFERENCES `currencies`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `companies` ADD CONSTRAINT `companies_currency_id_currencies_id_fk` FOREIGN KEY (`currency_id`) REFERENCES `currencies`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_company_id_companies_id_fk` FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_retailer_id_retailers_id_fk` FOREIGN KEY (`retailer_id`) REFERENCES `retailers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_currency_id_currencies_id_fk` FOREIGN KEY (`currency_id`) REFERENCES `currencies`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_order_id_orders_id_fk` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_orders_retailer_status` ON `orders` (`retailer_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_orders_status_order_date` ON `orders` (`status`,`order_date`);--> statement-breakpoint
CREATE INDEX `idx_outbox_published_occurred` ON `outbox` (`published_at`,`occurred_at`);