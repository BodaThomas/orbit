CREATE TABLE `agent_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`path` text NOT NULL,
	`kind` text NOT NULL,
	`branch` text,
	`base_ref` text,
	`status` text DEFAULT 'active' NOT NULL,
	`diff_stat` text,
	`conflict_with` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `constellation_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_workspaces_run_idx` ON `agent_workspaces` (`run_id`);--> statement-breakpoint
CREATE TABLE `constellation_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`objective` text DEFAULT '' NOT NULL,
	`coordinator_agent_id` text NOT NULL,
	`workspace` text,
	`workspace_mode` text DEFAULT 'shared' NOT NULL,
	`permissions` text NOT NULL,
	`limits` text NOT NULL,
	`is_template` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `constellation_members` (
	`constellation_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`role` text DEFAULT '' NOT NULL,
	`responsibilities` text DEFAULT '' NOT NULL,
	`can_delegate` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`constellation_id`) REFERENCES `constellation_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `constellation_members_pk` ON `constellation_members` (`constellation_id`,`agent_id`);--> statement-breakpoint
CREATE TABLE `constellation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`constellation_id` text NOT NULL,
	`goal` text NOT NULL,
	`status` text NOT NULL,
	`coordinator_agent_id` text NOT NULL,
	`coordinator_mission_id` text,
	`round` integer DEFAULT 0 NOT NULL,
	`workspace` text,
	`limits` text NOT NULL,
	`synthesis` text,
	`error` text,
	`origin` text DEFAULT 'user' NOT NULL,
	`idempotency_key` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`constellation_id`) REFERENCES `constellation_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `constellation_runs_def_idx` ON `constellation_runs` (`constellation_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `constellation_runs_idem_unique` ON `constellation_runs` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `execution_handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`from_agent_id` text NOT NULL,
	`to_agent_id` text NOT NULL,
	`mission_id` text,
	`summary` text NOT NULL,
	`payload` text NOT NULL,
	`redactions` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `constellation_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `handoffs_run_idx` ON `execution_handoffs` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `mission_dependencies` (
	`mission_id` text NOT NULL,
	`depends_on_mission_id` text NOT NULL,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mission_dependencies_pk` ON `mission_dependencies` (`mission_id`,`depends_on_mission_id`);--> statement-breakpoint
ALTER TABLE `missions` ADD `constellation_run_id` text;--> statement-breakpoint
ALTER TABLE `missions` ADD `depth` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `missions` ADD `subtask` text;--> statement-breakpoint
ALTER TABLE `missions` ADD `permissions_override` text;--> statement-breakpoint
ALTER TABLE `missions` ADD `result_data` text;