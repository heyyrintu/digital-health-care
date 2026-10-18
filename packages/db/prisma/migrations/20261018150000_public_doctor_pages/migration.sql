-- Public doctor pages (Build Plan §5.1 `/doctor/[slug]`; ADR 0017; API guide §3u).
--
-- A doctor may opt in to a public page: a platform-unique address, a short "about" text and
-- the languages they consult in. Nothing is public until the doctor lists the page AND the
-- platform team has verified the registration; the organisation and the doctor's
-- membership must be active too.
--
-- The page is read without any sign-in and across organisations, so it cannot run under one
-- organisation's row-level security. As for the platform console (ADR 0016), the read goes
-- through SECURITY DEFINER functions that return exactly the public columns. They are
-- executable only by dhc_app, which the API uses with no organisation set (`withPublic` in
-- @dhc/db): in that state dhc_app sees no row of any tenant table, so the functions are
-- the whole surface.

ALTER TABLE "doctor_profiles"
  ADD COLUMN "public_slug" TEXT,
  ADD COLUMN "listed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "about" TEXT,
  ADD COLUMN "languages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- When the public fields last changed (the sitemap's lastmod); created_at until then. Never
  -- updated_at, which also moves with signing PIN attempts and would make those visible.
  ADD COLUMN "public_updated_at" TIMESTAMPTZ(3);

-- Unique across every organisation: the address is the platform's, not the clinic's.
CREATE UNIQUE INDEX "doctor_profiles_public_slug_key" ON "doctor_profiles"("public_slug");

-- The language list, as the API also checks it (DoctorLanguages in @dhc/contracts): up to 8
-- names of 1–40 characters, each once whatever the case, with no whitespace at either end.
-- "Whitespace" is spelled out as the characters JavaScript's trim() removes (and its \s
-- matches), not Postgres's locale-dependent [[:space:]], so the API's trimmed values always
-- pass. Immutable, so a CHECK may call it (a CHECK cannot hold the subquery).
CREATE FUNCTION doctor_languages_valid(p_languages text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT coalesce(cardinality(p_languages), 0) <= 8 AND (
      SELECT coalesce(bool_and(
               l IS NOT NULL AND length(l) BETWEEN 1 AND 40
               AND l !~ '^[ \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
               AND l !~ '[ \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$'
             ), true)
         AND count(DISTINCT lower(l)) = count(*)
      FROM unnest(p_languages) AS l
    )
  $$;

ALTER TABLE doctor_profiles
  -- Lowercase letters, digits and single hyphens between them, 3–60 characters.
  ADD CONSTRAINT doctor_profiles_public_slug_check
    CHECK (public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(public_slug) BETWEEN 3 AND 60),
  ADD CONSTRAINT doctor_profiles_about_check
    CHECK (length(about) BETWEEN 1 AND 1000),
  ADD CONSTRAINT doctor_profiles_languages_check
    CHECK (doctor_languages_valid(languages)),
  -- A listed page needs an address.
  ADD CONSTRAINT doctor_profiles_listed_slug_check
    CHECK (NOT listed OR public_slug IS NOT NULL);

-- Read functions ---------------------------------------------------------------------
-- SECURITY DEFINER: they run as the schema owner (who bypasses row-level security) and
-- return only the columns declared here: what the doctor chose to publish, their
-- registration as the platform team verified it, the organisation's name and slug (for
-- booking), and the clinics and consultation types they are scheduled for. Never a
-- patient, an appointment, contact details or any internal ID. EXECUTE is revoked from
-- PUBLIC and granted to dhc_app only.
--
-- A page is shown when all of these hold, the same in both functions:
--   the profile is listed and verified, the doctor's membership in the organisation is an
--   active doctor membership, their account is active, and the organisation is active.
--
-- Clinics and consultation types: the active ones the doctor has a schedule for that is in
-- force today (IST) or starts later and has sessions (a stopped schedule is a version with
-- no days).

CREATE FUNCTION public_doctor_profile(p_slug text)
  RETURNS TABLE (
    slug text,
    display_name text,
    qualifications text,
    specialty text,
    registration_number text,
    council text,
    about text,
    languages text[],
    organisation_slug text,
    organisation_name text,
    clinics jsonb,
    consultation_types jsonb,
    updated_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH doctor AS (
      SELECT dp.*, o.slug AS org_slug, o.name AS org_name, u.display_name AS name
      FROM doctor_profiles dp
      JOIN organisations o ON o.id = dp.organisation_id AND o.status = 'active'
      JOIN users u ON u.id = dp.user_id AND u.status = 'active'
      WHERE dp.public_slug = p_slug
        AND dp.listed
        AND dp.verification = 'verified'
        AND EXISTS (
          SELECT 1 FROM memberships m
          WHERE m.organisation_id = dp.organisation_id AND m.user_id = dp.user_id
            AND m.role = 'doctor' AND m.status = 'active'
        )
    ),
    schedules AS (
      SELECT DISTINCT av.clinic_id, av.consultation_type_id
      FROM doctor d
      JOIN availability_versions av
        ON av.organisation_id = d.organisation_id AND av.doctor_user_id = d.user_id
      WHERE av.weekly <> '{}'::jsonb
        -- In force today or later: no other version of the same schedule took over between
        -- its start and today.
        AND NOT EXISTS (
          SELECT 1 FROM availability_versions later
          WHERE later.organisation_id = av.organisation_id
            AND later.doctor_user_id = av.doctor_user_id
            AND later.clinic_id = av.clinic_id
            AND later.consultation_type_id = av.consultation_type_id
            AND later.effective_from > av.effective_from
            AND later.effective_from <= (now() AT TIME ZONE 'Asia/Kolkata')::date
        )
    )
    SELECT d.public_slug, d.name, d.qualifications, d.specialty,
           d.registration_number, d.council, d.about, d.languages,
           d.org_slug, d.org_name,
           coalesce((
             SELECT jsonb_agg(jsonb_build_object('name', c.name, 'address', c.address)
                              ORDER BY c.name)
             FROM clinics c
             WHERE c.organisation_id = d.organisation_id AND c.active
               AND c.id IN (SELECT clinic_id FROM schedules)
           ), '[]'::jsonb),
           coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                      'name', t.name,
                      'mode', t.mode::text,
                      'durationMin', t.default_duration_min,
                      'feePaise', t.fee_paise
                    ) ORDER BY t.fee_paise, t.name)
             FROM consultation_types t
             WHERE t.organisation_id = d.organisation_id AND t.active
               AND t.id IN (
                 SELECT s.consultation_type_id FROM schedules s
                 JOIN clinics c ON c.id = s.clinic_id AND c.active
               )
           ), '[]'::jsonb),
           coalesce(d.public_updated_at, d.created_at)
    FROM doctor d
  $$;

-- Every page shown, for a sitemap: its address and when it last changed. At most 50,000
-- (one sitemap file).
CREATE FUNCTION public_doctor_slugs()
  RETURNS TABLE (slug text, updated_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT dp.public_slug, coalesce(dp.public_updated_at, dp.created_at)
    FROM doctor_profiles dp
    JOIN organisations o ON o.id = dp.organisation_id AND o.status = 'active'
    JOIN users u ON u.id = dp.user_id AND u.status = 'active'
    WHERE dp.listed
      AND dp.verification = 'verified'
      AND dp.public_slug IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM memberships m
        WHERE m.organisation_id = dp.organisation_id AND m.user_id = dp.user_id
          AND m.role = 'doctor' AND m.status = 'active'
      )
    ORDER BY dp.public_slug
    LIMIT 50000
  $$;

REVOKE ALL ON FUNCTION public_doctor_profile(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_doctor_slugs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_doctor_profile(text) TO dhc_app;
GRANT EXECUTE ON FUNCTION public_doctor_slugs() TO dhc_app;
