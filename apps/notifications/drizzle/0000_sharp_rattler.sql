CREATE TABLE `processed_events` (
	`id` char(36) NOT NULL,
	`event_id` char(36) NOT NULL,
	`consumer` varchar(50) NOT NULL,
	`processed_at` datetime NOT NULL,
	`created_at` datetime NOT NULL,
	CONSTRAINT `processed_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_processed_events_event_consumer` UNIQUE(`event_id`,`consumer`)
);
