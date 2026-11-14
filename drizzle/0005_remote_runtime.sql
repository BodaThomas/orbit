CREATE TABLE `remote_missions` (
	`id` text PRIMARY KEY NOT NULL,
	`machine_id` text NOT NULL,
	`mission_id` text,
	`status` text NOT NULL,
	`result` text,
	`error` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `runtime_machines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `remote_missions_machine_idx` ON `remote_missions` (`machine_id`);--> statement-breakpoint
CREATE TABLE `runtime_events` (
	`machine_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`mission_id` text,
	`data` text,
	`at` text NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `runtime_machines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_events_pk` ON `runtime_events` (`machine_id`,`seq`);--> statement-breakpoint
CREATE TABLE `runtime_machines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`host` text,
	`user` text,
	`port` integer DEFAULT 22 NOT NULL,
	`runtime_home` text NOT NULL,
	`host_key` text,
	`host_key_fingerprint` text,
	`status` text DEFAULT 'new' NOT NULL,
	`last_error` text,
	`last_heartbeat_at` text,
	`runtime_version` text,
	`protocol` integer,
	`info` text,
	`engines` text,
	`cursor` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
