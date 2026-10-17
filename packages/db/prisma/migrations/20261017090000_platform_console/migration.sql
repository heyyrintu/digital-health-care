-- Platform console (PRD §3.2, §9.3; ADR 0016).
--
-- Platform operators are not clinic users: their own table, their own sessions and their
-- own role, dhc_platform. That role has no grant on any tenant table. Everything it may
-- learn about organisations comes from the SECURITY DEFINER functions below, which return
-- organisation names, counts and doctors' registration details, never patient or clinical
-- rows. Writes into an organisation (verifying a doctor, the first clinic and invite) run
-- as dhc_app under that organisation's row-level security, like any clinic request.

-- When a doctor profile went to the platform team for checking (the verification queue).
-- Set by the API when registration details are saved; null for a profile that only has a
-- signing PIN so far.
ALTER TABLE "doctor_profiles" ADD COLUMN "submitted_at" TIMESTAMPTZ(3);
UPDATE doctor_profiles SET submitted_at = created_at WHERE registration_number IS NOT NULL;

-- CreateTable
CREATE TABLE "platform_operators" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "password_hash" TEXT NOT NULL,
    "mfa_secret" TEXT NOT NULL,
    "mfa_last_used_step" INTEGER,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_operators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_sessions" (
    "id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "previous_refresh_token_hash" TEXT,
    "user_agent" TEXT,
    "ip" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_operators_email_key" ON "platform_operators"("email");

-- CreateIndex
CREATE UNIQUE INDEX "platform_sessions_refresh_token_hash_key" ON "platform_sessions"("refresh_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "platform_sessions_previous_refresh_token_hash_key" ON "platform_sessions"("previous_refresh_token_hash");

-- CreateIndex
CREATE INDEX "platform_sessions_operator_id_idx" ON "platform_sessions"("operator_id");

-- AddForeignKey
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "platform_operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE platform_operators ADD CONSTRAINT platform_operators_email_check
  CHECK (email = lower(email) AND email LIKE '%_@_%');

-- The platform role ------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dhc_platform') THEN
    CREATE ROLE dhc_platform NOLOGIN;
  END IF;
END
$$;

GRANT dhc_platform TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO dhc_platform;

-- Its own identity tables, which no clinic role can reach.
ALTER TABLE platform_operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_sessions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON platform_operators, platform_sessions TO dhc_platform;
CREATE POLICY platform_access ON platform_operators TO dhc_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_access ON platform_sessions TO dhc_platform USING (true) WITH CHECK (true);

-- Platform-level audit entries (sign-in, what was looked at) belong to no organisation.
-- Entries about an organisation are written as dhc_app inside that organisation.
GRANT INSERT ON audit_logs TO dhc_platform;
CREATE POLICY platform_write ON audit_logs FOR INSERT TO dhc_platform
  WITH CHECK (organisation_id IS NULL);

-- Read functions ---------------------------------------------------------------------
-- SECURITY DEFINER: they run as the schema owner (who bypasses row-level security) and
-- return only the columns declared here. EXECUTE is revoked from PUBLIC, so only
-- dhc_platform can call them; dhc_app and dhc_auth cannot.

-- Same as maskIdentifier in apps/api/src/modules/invites/service.ts:
-- `doctor@clinic.test` → `do****@clinic.test`; `+919876543210` → `+91******3210`.
CREATE FUNCTION platform_mask_identifier(p text) RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = public, pg_temp
  AS $$
    SELECT CASE
      WHEN p IS NULL THEN ''
      WHEN strpos(p, '@') > 1 THEN left(p, least(2, strpos(p, '@') - 1)) || '****' || substr(p, strpos(p, '@'))
      WHEN length(p) > 7 THEN left(p, 3) || '******' || right(p, 4)
      ELSE '****'
    END
  $$;

-- Every organisation with its clinics and staff counted by role and status, and its
-- active doctors' verification states.
CREATE FUNCTION platform_organisation_summaries()
  RETURNS TABLE (
    id uuid,
    slug text,
    name text,
    status text,
    created_at timestamptz,
    clinics_active int,
    clinics_total int,
    doctors_active int,
    doctors_invited int,
    doctors_revoked int,
    front_desk_active int,
    front_desk_invited int,
    front_desk_revoked int,
    clinic_admins_active int,
    clinic_admins_invited int,
    clinic_admins_revoked int,
    doctors_pending int,
    doctors_verified int
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT o.id, o.slug, o.name, o.status::text, o.created_at,
           c.active, c.total,
           m.doctors_active, m.doctors_invited, m.doctors_revoked,
           m.front_desk_active, m.front_desk_invited, m.front_desk_revoked,
           m.clinic_admins_active, m.clinic_admins_invited, m.clinic_admins_revoked,
           d.pending, d.verified
    FROM organisations o
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE active)::int AS active, count(*)::int AS total
      FROM clinics WHERE organisation_id = o.id
    ) c
    CROSS JOIN LATERAL (
      SELECT
        count(*) FILTER (WHERE role = 'doctor' AND status = 'active')::int AS doctors_active,
        count(*) FILTER (WHERE role = 'doctor' AND status = 'invited')::int AS doctors_invited,
        count(*) FILTER (WHERE role = 'doctor' AND status = 'revoked')::int AS doctors_revoked,
        count(*) FILTER (WHERE role = 'front_desk' AND status = 'active')::int AS front_desk_active,
        count(*) FILTER (WHERE role = 'front_desk' AND status = 'invited')::int AS front_desk_invited,
        count(*) FILTER (WHERE role = 'front_desk' AND status = 'revoked')::int AS front_desk_revoked,
        count(*) FILTER (WHERE role = 'clinic_admin' AND status = 'active')::int AS clinic_admins_active,
        count(*) FILTER (WHERE role = 'clinic_admin' AND status = 'invited')::int AS clinic_admins_invited,
        count(*) FILTER (WHERE role = 'clinic_admin' AND status = 'revoked')::int AS clinic_admins_revoked
      FROM memberships WHERE organisation_id = o.id
    ) m
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE dp.verification = 'pending')::int AS pending,
             count(*) FILTER (WHERE dp.verification = 'verified')::int AS verified
      FROM doctor_profiles dp
      JOIN memberships dm ON dm.organisation_id = dp.organisation_id AND dm.user_id = dp.user_id
        AND dm.role = 'doctor' AND dm.status = 'active'
      WHERE dp.organisation_id = o.id
    ) d
    ORDER BY o.created_at, o.slug
  $$;

-- Active doctors' registration details for the verification queue: pending or verified,
-- or one profile by ID, oldest submission first, after a (submitted_at, id) cursor.
-- Profiles without registration details yet are left out. Contact details come back masked.
CREATE FUNCTION platform_doctor_profiles(
    p_verification text,
    p_profile_id uuid,
    p_limit int,
    p_after_submitted timestamptz,
    p_after_id uuid
  )
  RETURNS TABLE (
    profile_id uuid,
    organisation_id uuid,
    organisation_slug text,
    organisation_name text,
    user_id uuid,
    display_name text,
    identifier text,
    registration_number text,
    council text,
    qualifications text,
    specialty text,
    verification text,
    submitted_at timestamptz,
    verified_at timestamptz,
    verified_by text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT dp.id, o.id, o.slug, o.name, u.id, u.display_name,
           platform_mask_identifier(coalesce(u.email, u.phone)),
           dp.registration_number, dp.council, dp.qualifications, dp.specialty,
           dp.verification::text, dp.submitted_at, dp.verified_at, dp.verified_by
    FROM doctor_profiles dp
    JOIN organisations o ON o.id = dp.organisation_id
    JOIN users u ON u.id = dp.user_id
    WHERE dp.registration_number IS NOT NULL
      AND dp.submitted_at IS NOT NULL
      AND (p_verification IS NULL OR dp.verification::text = p_verification)
      AND (p_profile_id IS NULL OR dp.id = p_profile_id)
      AND (p_after_submitted IS NULL OR (dp.submitted_at, dp.id) > (p_after_submitted, p_after_id))
      AND EXISTS (
        SELECT 1 FROM memberships m
        WHERE m.organisation_id = dp.organisation_id AND m.user_id = dp.user_id
          AND m.role = 'doctor' AND m.status = 'active'
      )
    ORDER BY dp.submitted_at, dp.id
    LIMIT least(greatest(coalesce(p_limit, 200), 1), 501)
  $$;

-- Usage per organisation over IST days p_from to p_to: visits (as the clinic dashboard
-- counts them: every visit on those days except ones moved to another slot), prescriptions
-- first signed and not voided, and counter payments received. Counts only.
CREATE FUNCTION platform_usage(p_from date, p_to date)
  RETURNS TABLE (
    organisation_id uuid,
    slug text,
    name text,
    status text,
    appointments int,
    prescriptions int,
    payments int,
    payments_paise bigint
  )
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  #variable_conflict use_column
  DECLARE
    v_start timestamptz := p_from::timestamp AT TIME ZONE 'Asia/Kolkata';
    v_end timestamptz := (p_to + 1)::timestamp AT TIME ZONE 'Asia/Kolkata';
  BEGIN
    IF p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > 366 THEN
      RAISE EXCEPTION 'platform_usage: invalid range';
    END IF;
    RETURN QUERY
      SELECT o.id, o.slug, o.name, o.status::text,
             (SELECT count(*)::int FROM appointments a
               WHERE a.organisation_id = o.id AND a.date BETWEEN p_from AND p_to
                 AND a.status <> 'rescheduled'),
             (SELECT count(*)::int FROM prescriptions p
               WHERE p.organisation_id = o.id AND p.signed_at >= v_start AND p.signed_at < v_end
                 AND p.amends_prescription_id IS NULL AND p.voided_at IS NULL),
             pay.n, pay.paise
      FROM organisations o
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS n, coalesce(sum(pm.amount_paise), 0)::bigint AS paise
        FROM payments pm
        WHERE pm.organisation_id = o.id AND pm.received_at >= v_start AND pm.received_at < v_end
      ) pay
      ORDER BY o.created_at, o.slug;
  END
  $$;

-- Whether a slug is taken, so onboarding can refuse before creating anything.
CREATE FUNCTION platform_organisation_slug_taken(p_slug text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$ SELECT EXISTS (SELECT 1 FROM organisations WHERE slug = p_slug) $$;

-- Write function ---------------------------------------------------------------------
-- Creates an organisation (onboarding step 1) and returns its ID, or NULL when the slug is
-- taken. The rest of onboarding (first clinic, invite) runs as dhc_app inside it.
CREATE FUNCTION platform_create_organisation(p_slug text, p_name text, p_now timestamptz)
  RETURNS uuid
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    INSERT INTO organisations (id, slug, name, status, created_at, updated_at)
    VALUES (gen_random_uuid(), p_slug, p_name, 'active', p_now, p_now)
    ON CONFLICT (slug) DO NOTHING
    RETURNING id
  $$;

REVOKE ALL ON FUNCTION platform_mask_identifier(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_organisation_summaries() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_doctor_profiles(text, uuid, int, timestamptz, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_usage(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_create_organisation(text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_organisation_slug_taken(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_organisation_slug_taken(text) TO dhc_platform;
GRANT EXECUTE ON FUNCTION platform_mask_identifier(text) TO dhc_platform;
GRANT EXECUTE ON FUNCTION platform_organisation_summaries() TO dhc_platform;
GRANT EXECUTE ON FUNCTION platform_doctor_profiles(text, uuid, int, timestamptz, uuid) TO dhc_platform;
GRANT EXECUTE ON FUNCTION platform_usage(date, date) TO dhc_platform;
GRANT EXECUTE ON FUNCTION platform_create_organisation(text, text, timestamptz) TO dhc_platform;

-- Existing functions anyone could call ------------------------------------------------
-- Functions are executable by PUBLIC unless revoked, and dhc_platform is part of PUBLIC.
-- queue_notify sends the live-queue notifications the API relays to clinic screens, so
-- only the clinic roles (whose triggers call it) keep it. push_devices_match_session is
-- a SECURITY DEFINER trigger function: triggers fire without EXECUTE, so nobody needs it.
REVOKE ALL ON FUNCTION queue_notify(uuid, uuid, date, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION queue_notify(uuid, uuid, date, uuid) TO dhc_app, dhc_auth;
REVOKE ALL ON FUNCTION push_devices_match_session() FROM PUBLIC;
