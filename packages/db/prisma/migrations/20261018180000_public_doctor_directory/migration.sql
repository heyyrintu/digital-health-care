-- The "Find a doctor" directory on the public home page (Build Plan §5.1; ADR 0017 addendum;
-- API guide §3u).
--
-- One SECURITY DEFINER function, like the two in `20261018150000_public_doctor_pages`: it
-- returns a card per doctor whose page is shown, with only the card's fields, so the home
-- page can list and search them without one request per doctor. Every value here is already
-- on the doctor's own page; nothing new is published. Executable only by dhc_app, which the
-- API uses with no organisation set (`withPublic` in @dhc/db).
--
-- Shown: exactly the rule of public_doctor_profile and public_doctor_slugs (listed, verified,
-- an active doctor membership, an active user, an active organisation). The integration
-- tests check that the directory and the sitemap list name the same pages.
--
-- Clinics and the lowest fee come from the same schedules as the page: the active clinics
-- and consultation types the doctor has a schedule for that is in force today (IST) or
-- starts later and has sessions. For each clinic only its name and the first line of its
-- address (the clinic table holds one free-text address and no city): carriage returns
-- dropped, spaces and tabs trimmed, and over 120 characters cut at a word boundary with an
-- ellipsis; none if the clinic has no address.
--
-- At most 500 cards, by name (a leading "Dr", "Dr." or "Dr. " ignored, never the "Dr" of a
-- name such as "Drishti") and then address: the page
-- searches the list in the browser, so it has to stay small. More than that needs a search
-- in the API (ADR 0017's review trigger).

CREATE FUNCTION public_doctor_directory()
  RETURNS TABLE (
    slug text,
    display_name text,
    qualifications text,
    specialty text,
    organisation_name text,
    clinics jsonb,
    languages text[],
    fee_from_paise integer
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
           )
    FROM shown s
    ORDER BY regexp_replace(lower(coalesce(s.display_name, s.org_name)), '^dr(\.\s*|\s+)', ''),
             s.public_slug
    LIMIT 500
  $$;

REVOKE ALL ON FUNCTION public_doctor_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_doctor_directory() TO dhc_app;
