import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { SerializedCookieJar } from "tough-cookie";

export const sessions = sqliteTable(
  "session",
  {
    id: integer("id").primaryKey(),
    accessToken: text("access_token").notNull(),
    cookieJar: text("cookie_jar", { mode: "json" }).$type<SerializedCookieJar>().notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [check("single_session", sql`${table.id} = 1`)],
);
