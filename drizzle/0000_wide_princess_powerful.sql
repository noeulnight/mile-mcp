-- Baseline also adopts the existing SQLite session table without replacing its data.
CREATE TABLE IF NOT EXISTS `session` (
	`id` integer PRIMARY KEY NOT NULL,
	`access_token` text NOT NULL,
	`cookie_jar` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "single_session" CHECK("session"."id" = 1)
);
