-- Platform console: system health (PRD §9.3; ADR 0016).
--
-- The console reports which migration the database is on. Prisma's own
-- `_prisma_migrations` table stays out of dhc_platform's reach, like every other table:
-- this SECURITY DEFINER function returns only the name of the last migration applied
-- (finished and not rolled back), and only dhc_platform may call it.
--
-- plpgsql, not sql: a sql body is checked when the function is created, and Prisma's
-- shadow database (`prisma migrate dev`) has no `_prisma_migrations` table. A plpgsql body
-- is resolved only when it runs.

CREATE FUNCTION platform_latest_migration() RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    RETURN (
      SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY migration_name DESC
      LIMIT 1
    );
  END
  $$;

REVOKE ALL ON FUNCTION platform_latest_migration() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_latest_migration() TO dhc_platform;
