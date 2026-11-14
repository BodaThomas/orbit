CREATE TABLE `permission_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`workspace` text NOT NULL,
	`scope` text NOT NULL,
	`mission_id` text,
	`kind` text NOT NULL,
	`operation_key` text NOT NULL,
	`label` text NOT NULL,
	`category` text,
	`uses` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	`revoked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `permission_grants_lookup_idx` ON `permission_grants` (`agent_id`,`operation_key`);