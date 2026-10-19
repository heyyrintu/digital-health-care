-- Per-organisation branding (Build Plan §5.1 "per-organisation branding", §6.7 "theme, logo
-- and text load at request time"; ADR 0017 addendum 2; API guide §3v).
--
-- A clinic admin may give the organisation a display name, an accent colour, a short
-- tagline and a logo. They show on its doctors' public pages, on its cards in the home
-- page's directory and on the patient portal's sign-in (`/app/login?clinic=<slug>`) and
-- frame. Nothing is public until an admin saves branding (no row: the platform look), and
-- only while the organisation is active.
--
-- Its own table rather than more columns on organisation_settings: those settings are
-- internal (chart model, safety tuning, upload limits) and every staff role reads them,
-- while this row is published through definer functions to anonymous visitors. Keeping the
-- published columns in their own table means a definer function never reads a row that
-- also holds internal settings, and a future internal setting cannot become public by a
-- careless `SELECT *`. It also keeps the logo's file metadata next to the text it brands.
--
-- The logo file lives in the private file store (FileStore, like test results), never in
-- the database; the row keeps its key, media type, size and SHA-256. The public logo route
-- looks a logo up by that hash, so the address names no organisation and changes whenever
-- the file does (caches keep it at most five minutes, so a suspended organisation's logo
-- stops soon after).

CREATE TABLE "organisation_branding" (
    "organisation_id" UUID NOT NULL,
    "display_name" TEXT,
    -- #rrggbb, lowercase. The API also refuses a colour with less than 4.5:1 contrast with
    -- white text (WCAG AA, it is the colour of buttons with white labels); that rule lives
    -- in @dhc/contracts (`isReadableAccent`), not in a CHECK, so the two can never disagree
    -- on rounding at the boundary.
    "accent_colour" TEXT,
    "tagline" TEXT,
    "logo_key" TEXT,
    "logo_media_type" TEXT,
    "logo_size_bytes" INTEGER,
    "logo_sha256" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organisation_branding_pkey" PRIMARY KEY ("organisation_id")
);

ALTER TABLE "organisation_branding" ADD CONSTRAINT "organisation_branding_organisation_id_fkey"
  FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The public logo route finds a logo by its hash.
CREATE INDEX "organisation_branding_logo_sha256_idx" ON "organisation_branding"("logo_sha256");

-- The formats the API checks (OrganisationBranding in @dhc/contracts). Text: 1–80 (name) or
-- 1–120 (tagline) characters, no spaces at either end (the API trims), and no control,
-- bidirectional (marks, embeddings, overrides, isolates, the Arabic letter mark) or invisible
-- characters (zero-width spaces and joiners, the word joiner, the byte-order mark), which
-- could make a name read as something else or hide text in it.
ALTER TABLE organisation_branding
  ADD CONSTRAINT organisation_branding_display_name_check
    CHECK (length(display_name) BETWEEN 1 AND 80
           AND btrim(display_name) = display_name
           AND display_name !~ '[\x01-\x1f\x7f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]'),
  ADD CONSTRAINT organisation_branding_tagline_check
    CHECK (length(tagline) BETWEEN 1 AND 120
           AND btrim(tagline) = tagline
           AND tagline !~ '[\x01-\x1f\x7f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]'),
  ADD CONSTRAINT organisation_branding_accent_colour_check
    CHECK (accent_colour ~ '^#[0-9a-f]{6}$'),
  -- A logo is all of its fields or none of them.
  ADD CONSTRAINT organisation_branding_logo_complete_check
    CHECK ((logo_key IS NULL) = (logo_media_type IS NULL)
           AND (logo_key IS NULL) = (logo_size_bytes IS NULL)
           AND (logo_key IS NULL) = (logo_sha256 IS NULL)),
  -- PNG, JPEG or WebP only: never SVG (it can carry script), and never anything else.
  ADD CONSTRAINT organisation_branding_logo_media_type_check
    CHECK (logo_media_type IN ('image/png', 'image/jpeg', 'image/webp')),
  -- 512 KB at most.
  ADD CONSTRAINT organisation_branding_logo_size_check
    CHECK (logo_size_bytes BETWEEN 1 AND 524288),
  ADD CONSTRAINT organisation_branding_logo_sha256_check
    CHECK (logo_sha256 ~ '^[0-9a-f]{64}$'),
  -- The file is the organisation's own: its key starts with the organisation's folder, so a
  -- row can never point at another organisation's files (or a test result).
  ADD CONSTRAINT organisation_branding_logo_key_check
    CHECK (logo_key ~ ('^organisations/' || organisation_id::text
                       || '/branding/logo-[0-9a-f]{12}\.(png|jpg|webp)$'));

ALTER TABLE organisation_branding ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON organisation_branding TO dhc_app;
CREATE POLICY tenant_isolation ON organisation_branding TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

-- Read functions ---------------------------------------------------------------------
-- As ADR 0017: owner, SECURITY DEFINER, search_path pinned, EXECUTE revoked from PUBLIC and
-- granted to dhc_app only, which calls them with no organisation set (`withPublic`).
-- Branding is shown when the organisation is active and an admin has saved a branding row.

-- An organisation's branding by its slug: what the portal's sign-in and frame show, and the
-- doctor page's header. Its slug and name (both already public through the doctor pages
-- and clinic links), the branding text, the colour and the logo's hash (its address).
CREATE FUNCTION public_organisation_branding(p_slug text)
  RETURNS TABLE (
    organisation_slug text,
    organisation_name text,
    display_name text,
    accent_colour text,
    tagline text,
    logo_sha256 text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT o.slug, o.name, b.display_name, b.accent_colour, b.tagline, b.logo_sha256
    FROM organisations o
    JOIN organisation_branding b ON b.organisation_id = o.id
    WHERE o.slug = p_slug AND o.status = 'active'
  $$;

-- A logo by its hash, for the public logo route: where the API finds the file, and its
-- type and size. The file key names the organisation's folder; it goes to the API only,
-- which reads the file with it and never sends it on. Active organisations only, so a
-- suspended organisation's logo stops at once in the API (and within five minutes in
-- caches). Several organisations may hold the same bytes: every copy is returned (newest
-- first, at most 8), and the API serves the first one whose file is still there and still
-- passes its checks, so one organisation's missing or damaged file never takes another's
-- logo down.
CREATE FUNCTION public_organisation_logo(p_sha256 text)
  RETURNS TABLE (file_key text, media_type text, size_bytes integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT b.logo_key, b.logo_media_type, b.logo_size_bytes
    FROM organisation_branding b
    JOIN organisations o ON o.id = b.organisation_id AND o.status = 'active'
    WHERE p_sha256 ~ '^[0-9a-f]{64}$' AND b.logo_sha256 = p_sha256
    ORDER BY b.updated_at DESC, b.organisation_id
    LIMIT 8
  $$;

REVOKE ALL ON FUNCTION public_organisation_branding(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_organisation_logo(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_organisation_branding(text) TO dhc_app;
GRANT EXECUTE ON FUNCTION public_organisation_logo(text) TO dhc_app;

-- The directory, version 2 ----------------------------------------------------------------
-- `public_doctor_directory()` (migration 20261018180000) gains each card's organisation
-- display name: the only branding the platform's home page shows (it stays unbranded, with
-- no colour or logo, so neither is published in the list). A function's output
-- columns cannot change with CREATE OR REPLACE, so it is dropped and created again in this
-- one transaction; the body is the previous one with only the branding join and
-- column added (same "shown" rule, clinics, fee, order and cap). The doctor page itself is not
-- changed: the API reads its header's branding with public_organisation_branding() above,
-- by the organisation slug the page already returns, in the same read-only transaction.

DROP FUNCTION public_doctor_directory();

CREATE FUNCTION public_doctor_directory()
  RETURNS TABLE (
    slug text,
    display_name text,
    qualifications text,
    specialty text,
    organisation_name text,
    clinics jsonb,
    languages text[],
    fee_from_paise integer,
    organisation_display_name text
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH shown AS (
      SELECT dp.organisation_id, dp.user_id, dp.public_slug, u.display_name,
             dp.qualifications, dp.specialty, dp.languages, o.name AS org_name
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
    ),
    schedules AS (
      SELECT DISTINCT av.organisation_id, av.doctor_user_id, av.clinic_id, av.consultation_type_id
      FROM shown s
      JOIN availability_versions av
        ON av.organisation_id = s.organisation_id AND av.doctor_user_id = s.user_id
      WHERE av.weekly <> '{}'::jsonb
        -- In force today or later, as in public_doctor_profile.
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
    SELECT s.public_slug, s.display_name, s.qualifications, s.specialty, s.org_name,
           coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                      'name', c.name,
                      'addressLine', CASE
                        WHEN length(a.line) <= 120 THEN a.line
                        -- 119 characters and the ellipsis; a word cut in two is dropped.
                        WHEN substr(a.line, 120, 1) ~ '\s' THEN rtrim(left(a.line, 119), E' \t') || '…'
                        ELSE coalesce(
                          nullif(rtrim(regexp_replace(left(a.line, 119), '\S*$', ''), E' \t'), ''),
                          left(a.line, 119)
                        ) || '…'
                      END
                    ) ORDER BY c.name)
             FROM clinics c
             CROSS JOIN LATERAL (
               SELECT nullif(btrim(split_part(replace(c.address, E'\r', ''), E'\n', 1), E' \t'), '')
                 AS line
             ) a
             WHERE c.organisation_id = s.organisation_id AND c.active
               AND c.id IN (
                 SELECT sc.clinic_id FROM schedules sc
                 WHERE sc.organisation_id = s.organisation_id AND sc.doctor_user_id = s.user_id
               )
           ), '[]'::jsonb),
           s.languages,
           (
             SELECT min(t.fee_paise)
             FROM schedules sc
             JOIN consultation_types t
               ON t.id = sc.consultation_type_id AND t.organisation_id = s.organisation_id
               AND t.active
             JOIN clinics c
               ON c.id = sc.clinic_id AND c.organisation_id = s.organisation_id AND c.active
             WHERE sc.organisation_id = s.organisation_id AND sc.doctor_user_id = s.user_id
           ),
           b.display_name
    FROM shown s
    LEFT JOIN organisation_branding b ON b.organisation_id = s.organisation_id
    ORDER BY regexp_replace(lower(coalesce(s.display_name, s.org_name)), '^dr(\.\s*|\s+)', ''),
             s.public_slug
    LIMIT 500
  $$;

REVOKE ALL ON FUNCTION public_doctor_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_doctor_directory() TO dhc_app;
