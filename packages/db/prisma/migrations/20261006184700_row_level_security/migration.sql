-- Row-level security and least-privilege roles (ADR 0014).
--
-- dhc_app  — every tenant-scoped request. Sees only rows of the organisation set with
--            set_config('app.organisation_id', ...) in the same transaction; with no
--            organisation set it sees nothing.
-- dhc_auth — sign-in only: users, sessions, OTP challenges, organisation lookup,
--            membership checks and audit inserts. No access to clinical tables.
--
-- The API connects as the owner but always switches with SET LOCAL ROLE inside a
-- transaction, so policies apply to every query it runs. New tenant tables must
-- enable RLS and add a tenant policy; an integration test fails if one is missing.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dhc_app') THEN
    CREATE ROLE dhc_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dhc_auth') THEN
    CREATE ROLE dhc_auth NOLOGIN;
  END IF;
END
$$;

-- Lets the connecting (owner) role switch into the restricted roles.
GRANT dhc_app, dhc_auth TO CURRENT_USER;

GRANT USAGE ON SCHEMA public TO dhc_app, dhc_auth;

CREATE FUNCTION app_current_organisation_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.organisation_id', true), '')::uuid $$;

GRANT EXECUTE ON FUNCTION app_current_organisation_id() TO dhc_app, dhc_auth;

-- organisations ------------------------------------------------------------------
ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON organisations TO dhc_app, dhc_auth;
CREATE POLICY tenant_isolation ON organisations TO dhc_app
  USING (id = app_current_organisation_id());
CREATE POLICY auth_lookup ON organisations FOR SELECT TO dhc_auth USING (true);

-- memberships --------------------------------------------------------------------
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON memberships TO dhc_app;
GRANT SELECT, INSERT ON memberships TO dhc_auth;
CREATE POLICY tenant_isolation ON memberships TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());
CREATE POLICY auth_lookup ON memberships FOR SELECT TO dhc_auth USING (true);
-- Sign-in may only ever create patient memberships; staff are invited by an admin.
CREATE POLICY auth_patient_signup ON memberships FOR INSERT TO dhc_auth
  WITH CHECK (role = 'patient');

-- patients (clinical: never deletable, no auth access) ---------------------------
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON patients TO dhc_app;
CREATE POLICY tenant_isolation ON patients TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

-- audit_logs (append-only) -------------------------------------------------------
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON audit_logs TO dhc_app;
GRANT INSERT ON audit_logs TO dhc_auth;
CREATE POLICY tenant_read ON audit_logs FOR SELECT TO dhc_app
  USING (organisation_id = app_current_organisation_id());
CREATE POLICY tenant_write ON audit_logs FOR INSERT TO dhc_app
  WITH CHECK (organisation_id = app_current_organisation_id());
CREATE POLICY auth_write ON audit_logs FOR INSERT TO dhc_auth WITH CHECK (true);

CREATE FUNCTION audit_logs_append_only() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION 'audit_logs is append-only'; END $$;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only();

-- Platform-level identity tables: auth role only --------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_challenges ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON users, sessions, otp_challenges TO dhc_auth;
CREATE POLICY auth_access ON users TO dhc_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_access ON sessions TO dhc_auth USING (true) WITH CHECK (true);
CREATE POLICY auth_access ON otp_challenges TO dhc_auth USING (true) WITH CHECK (true);
