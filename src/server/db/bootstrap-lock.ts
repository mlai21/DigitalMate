export const DATABASE_BOOTSTRAP_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(1146050617::bigint)";
