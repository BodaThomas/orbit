CREATE TABLE `remote_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`machine_id` text NOT NULL,
	`mission_id` text,
	`agent_id` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`status` text NOT NULL,
	`local_path` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `runtime_machines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `remote_artifacts_mission_idx` ON `remote_artifacts` (`mission_id`);--> statement-breakpoint
CREATE TABLE `remote_commands` (
	`request_id` text PRIMARY KEY NOT NULL,
	`machine_id` text NOT NULL,
	`method` text NOT NULL,
	`params` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`entity_kind` text,
	`entity_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `runtime_machines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `remote_commands_machine_idx` ON `remote_commands` (`machine_id`,`status`);--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `machine_id` text;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `operation_hash` text;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `expires_at` text;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `resolved_by` text;--> statement-breakpoint
ALTER TABLE `automation_definitions` ADD `scheduler_owner` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE `automation_definitions` ADD `owner_state` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `automation_definitions` ADD `pending_owner` text;--> statement-breakpoint
ALTER TABLE `automation_definitions` ADD `config_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `automation_definitions` ADD `max_duration_min` integer;--> statement-breakpoint
ALTER TABLE `automation_definitions` ADD `budget_usd` real;--> statement-breakpoint
ALTER TABLE `automation_definitions` ADD `failure_policy` text DEFAULT 'notify' NOT NULL;--> statement-breakpoint
ALTER TABLE `automation_runs` ADD `machine_id` text;--> statement-breakpoint
ALTER TABLE `constellation_runs` ADD `machine_id` text;--> statement-breakpoint
ALTER TABLE `missions` ADD `remote_machine_id` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `dedupe_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_dedupe_unique` ON `notifications` (`dedupe_key`);--> statement-breakpoint
ALTER TABLE `runtime_machines` ADD `runtime_id` text;--> statement-breakpoint
ALTER TABLE `runtime_machines` ADD `runtime_key` text;--> statement-breakpoint
ALTER TABLE `runtime_machines` ADD `runtime_key_fingerprint` text;--> statement-breakpoint
ALTER TABLE `runtime_machines` ADD `client_id` text;--> statement-breakpoint
ALTER TABLE `runtime_machines` ADD `paired_at` text;--> statement-breakpoint
ALTER TABLE `runtime_machines` ADD `schema_version` text;--> statement-breakpoint
ALTER TABLE `runtime_machines` ADD `health` text;--> statement-breakpoint
ALTER TABLE `runtime_machines` ADD `metrics` text;--> statement-breakpoint
ALTER TABLE `runtime_machines` ADD `last_synced_at` text;--> statement-breakpoint
ALTER TABLE `runtime_machines` ADD `sync_error` text;--> statement-breakpoint
ALTER TABLE `runtime_machines` ADD `limits` text;--> statement-breakpoint
ALTER TABLE `runtime_machines` ADD `ssh_identity_file` text;--> statement-breakpoint
ALTER TABLE `usage_records` ADD `machine_id` text;