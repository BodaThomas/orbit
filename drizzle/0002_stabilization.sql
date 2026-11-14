CREATE TABLE `file_inventories` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text NOT NULL,
	`execution_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`method` text NOT NULL,
	`complete` integer NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `file_inventories_mission_idx` ON `file_inventories` (`mission_id`);--> statement-breakpoint
CREATE TABLE `security_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text,
	`mission_id` text,
	`layer` text NOT NULL,
	`action` text NOT NULL,
	`target` text,
	`decision` text NOT NULL,
	`reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `security_audit_created_idx` ON `security_audit_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `subscription_usage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`windows` text NOT NULL,
	`source` text NOT NULL,
	`observed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `subscription_usage_provider_idx` ON `subscription_usage_records` (`provider_id`,`observed_at`);--> statement-breakpoint
ALTER TABLE `agents` ADD `isolation` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `effort` text;--> statement-breakpoint
ALTER TABLE `file_changes` ADD `agent_id` text;--> statement-breakpoint
ALTER TABLE `file_changes` ADD `source` text DEFAULT 'engine' NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_records` ADD `equivalent_usd` real;