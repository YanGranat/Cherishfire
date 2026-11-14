CREATE TABLE `day_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`habit_id` integer NOT NULL,
	`date` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`habit_id`) REFERENCES `habits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_records_habit_date` ON `day_records` (`habit_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_records_date` ON `day_records` (`date`);--> statement-breakpoint
CREATE TABLE `habits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`description_visible` integer DEFAULT true NOT NULL,
	`repeat_type` text NOT NULL,
	`repeat_config` text NOT NULL,
	`start_date` text NOT NULL,
	`reminder_enabled` integer DEFAULT false NOT NULL,
	`reminder_time` text,
	`display_order` integer NOT NULL,
	`is_archived` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	`archive_history` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_habits_archived` ON `habits` (`is_archived`);--> statement-breakpoint
CREATE INDEX `idx_habits_order` ON `habits` (`display_order`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`habit_id` integer NOT NULL,
	`date` text NOT NULL,
	`text` text NOT NULL,
	`is_failure_reason` integer DEFAULT false NOT NULL,
	`reason_type` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`habit_id`) REFERENCES `habits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_notes_habit_date` ON `notes` (`habit_id`,`date`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
