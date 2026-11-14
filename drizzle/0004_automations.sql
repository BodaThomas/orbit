CREATE TABLE `automation_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`title` text NOT NULL,
	`prompt` text NOT NULL,
	`recurrence` text,
	`timezone` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`missed_policy` text DEFAULT 'ask' NOT NULL,
	`max_runs_per_day` integer,
	`next_run_at` text,
	`last_run_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `automations_next_idx` ON `automation_definitions` (`status`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`automation_id` text NOT NULL,
	`scheduled_for` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`mission_id` text,
	`constellation_run_id` text,
	`note` text,
	`idempotency_key` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`automation_id`) REFERENCES `automation_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_runs_idem_unique` ON `automation_runs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `automation_runs_auto_idx` ON `automation_runs` (`automation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `automation_triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`automation_id` text NOT NULL,
	`kind` text NOT NULL,
	`source_agent_id` text,
	`source_automation_id` text,
	`status_filter` text,
	`cooldown_sec` integer DEFAULT 300 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`automation_id`) REFERENCES `automation_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `automation_triggers_auto_idx` ON `automation_triggers` (`automation_id`);