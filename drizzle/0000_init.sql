CREATE TABLE `activity_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`level` text NOT NULL,
	`agent_id` text,
	`mission_id` text,
	`conversation_id` text,
	`title` text NOT NULL,
	`detail` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_created_idx` ON `activity_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `activity_agent_idx` ON `activity_events` (`agent_id`);--> statement-breakpoint
CREATE TABLE `agent_appearances` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`appearance` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`include_in_context` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memories_agent_idx` ON `agent_memories` (`agent_id`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`provider_id` text NOT NULL,
	`model` text NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`autonomy` text DEFAULT 'supervised' NOT NULL,
	`permissions` text NOT NULL,
	`working_directory` text,
	`runtime` text DEFAULT 'local' NOT NULL,
	`machine_id` text,
	`daily_budget_usd` real,
	`enabled` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`status_text` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agents_sort_idx` ON `agents` (`sort_order`);--> statement-breakpoint
CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`mission_id` text,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`detail` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `approvals_status_idx` ON `approval_requests` (`status`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`agent_id` text,
	`action` text NOT NULL,
	`target` text,
	`allowed` integer NOT NULL,
	`reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`title` text NOT NULL,
	`provider_session_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversations_agent_idx` ON `conversations` (`agent_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `execution_events` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text NOT NULL,
	`execution_id` text NOT NULL,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`data` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `exec_events_mission_idx` ON `execution_events` (`mission_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `machines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`platform` text NOT NULL,
	`status` text NOT NULL,
	`last_heartbeat_at` text,
	`details` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`model` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost_usd` real,
	`cost_kind` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_idx` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `mission_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `executions_idem_unique` ON `mission_executions` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `missions` (
	`id` text PRIMARY KEY NOT NULL,
	`short_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`agent_id` text NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`result` text,
	`error` text,
	`cost_usd` real,
	`cost_kind` text,
	`workflow_id` text,
	`parent_mission_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `missions_status_idx` ON `missions` (`status`);--> statement-breakpoint
CREATE INDEX `missions_agent_idx` ON `missions` (`agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `missions_short_id_unique` ON `missions` (`short_id`);--> statement-breakpoint
CREATE TABLE `model_configurations` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`model` text NOT NULL,
	`input_price_per_mtok` real,
	`output_price_per_mtok` real,
	`pricing_date` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_cfg_unique` ON `model_configurations` (`provider_id`,`model`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`route` text,
	`read` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifications_created_idx` ON `notifications` (`created_at`);--> statement-breakpoint
CREATE TABLE `provider_connections` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`encrypted_secret` text,
	`secret_hint` text,
	`last_validated_at` text,
	`last_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_health_records` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`level` text NOT NULL,
	`payload` text NOT NULL,
	`checked_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `health_provider_idx` ON `provider_health_records` (`provider_id`,`checked_at`);--> statement-breakpoint
CREATE TABLE `scheduled_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`title` text NOT NULL,
	`prompt` text NOT NULL,
	`recurrence` text NOT NULL,
	`next_run_at` text,
	`last_run_key` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`execution_id` text,
	`conversation_id` text,
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`input` text,
	`output` text,
	`status` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text,
	`provider_id` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`cost_kind` text NOT NULL,
	`pricing_version` text,
	`source` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_created_idx` ON `usage_records` (`created_at`);--> statement-breakpoint
CREATE INDEX `usage_agent_idx` ON `usage_records` (`agent_id`);--> statement-breakpoint
CREATE TABLE `workflow_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`mission_id` text,
	`depends_on` text NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`coordinator_agent_id` text NOT NULL,
	`mission_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
