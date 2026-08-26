ALTER TABLE `orders` ADD `request_id` char(36);--> statement-breakpoint
ALTER TABLE `saga_commands` ADD `triggering_event_envelope` json;--> statement-breakpoint
ALTER TABLE `saga_commands` ADD `triggering_event_topic` varchar(64);--> statement-breakpoint
ALTER TABLE `saga_commands` ADD `dead_lettered_at` datetime;--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `uq_orders_request_id` UNIQUE(`request_id`);