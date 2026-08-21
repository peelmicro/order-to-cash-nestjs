CREATE TABLE `order_number_sequences` (
	`id` tinyint NOT NULL,
	`next_value` int NOT NULL,
	CONSTRAINT `order_number_sequences_id` PRIMARY KEY(`id`)
);
