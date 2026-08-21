CREATE TABLE `saga_commands` (
	`id` char(36) NOT NULL,
	`order_id` char(36) NOT NULL,
	`order_reference` varchar(20) NOT NULL,
	`command` varchar(30) NOT NULL,
	`payload` json NOT NULL,
	`triggering_event_id` char(36) NOT NULL,
	`status` varchar(10) NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`last_error` text,
	`next_attempt_at` datetime,
	`created_at` datetime NOT NULL,
	`updated_at` datetime NOT NULL,
	`sent_at` datetime,
	CONSTRAINT `saga_commands_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_saga_commands_order_command` UNIQUE(`order_id`,`command`)
);
--> statement-breakpoint
CREATE TABLE `saga_ignored_facts` (
	`id` char(36) NOT NULL,
	`event_id` char(36) NOT NULL,
	`event_type` varchar(60) NOT NULL,
	`order_id` char(36),
	`correlation_id` char(36) NOT NULL,
	`observed_status` varchar(20),
	`expected_status` varchar(20),
	`marker` varchar(20) NOT NULL,
	`recorded_at` datetime NOT NULL,
	CONSTRAINT `saga_ignored_facts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_saga_commands_status_created` ON `saga_commands` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_saga_commands_status_next_attempt` ON `saga_commands` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_saga_ignored_facts_correlation` ON `saga_ignored_facts` (`correlation_id`);