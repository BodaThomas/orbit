CREATE TABLE `file_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text NOT NULL,
	`execution_id` text NOT NULL,
	`path` text NOT NULL,
	`kind` text NOT NULL,
	`diff` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `file_changes_mission_idx` ON `file_changes` (`mission_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `execution_id` text;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `tool_call_id` text;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `payload` text;--> statement-breakpoint
ALTER TABLE `mission_executions` ADD `prompt` text;--> statement-breakpoint
ALTER TABLE `mission_executions` ADD `error` text;--> statement-breakpoint
ALTER TABLE `mission_executions` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `mission_executions` ADD `output_tokens` integer;--> statement-breakpoint
ALTER TABLE `mission_executions` ADD `cost_usd` real;--> statement-breakpoint
ALTER TABLE `mission_executions` ADD `cost_kind` text;--> statement-breakpoint
ALTER TABLE `missions` ADD `engine` text;--> statement-breakpoint
ALTER TABLE `missions` ADD `session_id` text;--> statement-breakpoint
ALTER TABLE `missions` ADD `workspace` text;--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `mission_id` text REFERENCES missions(id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `external_id` text;--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `kind` text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `title` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `files` text;--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `exit_code` integer;--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `finished_at` text;--> statement-breakpoint
CREATE INDEX `tool_calls_mission_idx` ON `tool_calls` (`mission_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `tool_calls_external_idx` ON `tool_calls` (`execution_id`,`external_id`);