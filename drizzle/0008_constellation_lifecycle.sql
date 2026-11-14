ALTER TABLE `constellation_runs` ADD `phase` text;--> statement-breakpoint
ALTER TABLE `constellation_runs` ADD `active_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `constellation_runs` ADD `last_ingested_execution_id` text;--> statement-breakpoint
ALTER TABLE `constellation_runs` ADD `version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `constellation_definitions` ADD `plan_approval` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
UPDATE `constellation_runs` SET `status` = 'completed' WHERE `status` = 'done';--> statement-breakpoint
UPDATE `constellation_runs` SET `status` = 'paused' WHERE `status` = 'interrupted';--> statement-breakpoint
CREATE TABLE `constellation_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`version` integer NOT NULL,
	`round` integer NOT NULL,
	`status` text NOT NULL,
	`hash` text NOT NULL,
	`tasks` text NOT NULL,
	`questions` text NOT NULL,
	`note` text,
	`errors` text NOT NULL,
	`source` text NOT NULL,
	`source_execution_id` text,
	`approval_reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`decided_at` text,
	`decided_by` text,
	FOREIGN KEY (`run_id`) REFERENCES `constellation_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `constellation_plans_version_unique` ON `constellation_plans` (`run_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `constellation_plans_source_unique` ON `constellation_plans` (`run_id`,`source_execution_id`);--> statement-breakpoint
CREATE TABLE `constellation_run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`message` text NOT NULL,
	`data` text,
	`actor` text DEFAULT 'orbit' NOT NULL,
	`idempotency_key` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `constellation_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `constellation_run_events_run_idx` ON `constellation_run_events` (`run_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `constellation_run_events_idem_unique` ON `constellation_run_events` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `missions_run_subtask_key_unique` ON `missions` (`constellation_run_id`, json_extract(`subtask`, '$.key')) WHERE `subtask` IS NOT NULL AND `constellation_run_id` IS NOT NULL;
