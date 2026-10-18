-- Clinic admins edit the test catalogue (PRD §7.1, §9.2; API guide §3t). Tests already
-- ordered keep their own copy of the kind, name, region, side and views, so nothing here
-- touches test_orders: an edit or a deactivation changes only what doctors pick from next.
-- Items are never deleted (orders point at them); they are deactivated.

-- Names are unique per organisation among active tests, whatever the case. An inactive test
-- keeps its name, so a clinic can retire a test and add a new one by the same name, but two
-- active tests never read the same on the doctor's list. Replaces the exact-name unique index
-- from 20261018090000_test_orders (Prisma cannot express a partial expression index; the
-- schema notes it).
DROP INDEX "test_catalogue_items_organisation_id_name_key";
CREATE UNIQUE INDEX test_catalogue_items_active_name_key
  ON test_catalogue_items (organisation_id, lower(name)) WHERE active;

-- The region and view lists, as the API also checks them: each region 1–80 characters (an
-- ordered test copies it into test_orders.region, which allows 80), already trimmed, and
-- each once whatever the case; each view once. Immutable and without side effects, so a
-- CHECK may call it (a CHECK cannot hold the subqueries itself).
CREATE FUNCTION test_catalogue_lists_valid(p_regions text[], p_views text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT (
      SELECT coalesce(bool_and(length(r) BETWEEN 1 AND 80 AND r = btrim(r)), true)
         AND count(DISTINCT lower(r)) = count(*)
      FROM unnest(p_regions) AS r
    ) AND (
      SELECT count(DISTINCT v) = count(*) FROM unnest(p_views) AS v
    )
  $$;

-- Limits the API also checks (CreateTestCatalogueItemBody in @dhc/contracts): a trimmed
-- name, up to 40 regions, and X-ray views only from the six the catalogue offers.
ALTER TABLE test_catalogue_items ADD CONSTRAINT test_catalogue_items_limits_check
  CHECK (
    name = btrim(name)
    AND cardinality(regions) <= 40
    AND views <@ ARRAY['AP', 'PA', 'Lateral', 'Oblique', 'Skyline', 'Standing']::text[]
    AND test_catalogue_lists_valid(regions, views)
    AND sort_order >= 0
  );

-- The default catalogue, as before, now skipping a name the organisation already lists in any
-- case, active or not (NOT EXISTS), and leaving to the new partial index any active name that
-- appears meanwhile (ON CONFLICT), rather than relying on the exact-name index dropped above.
-- Same signature, owner and grants (CREATE OR REPLACE keeps them).
CREATE OR REPLACE FUNCTION seed_test_catalogue(p_organisation_id uuid) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH xray_regions AS (SELECT ARRAY['Chest', 'Skull', 'Paranasal sinuses', 'Cervical spine',
           'Thoracic spine', 'Lumbosacral spine', 'Pelvis', 'Shoulder', 'Arm', 'Elbow',
           'Forearm', 'Wrist', 'Hand', 'Hip', 'Thigh', 'Knee', 'Leg', 'Ankle', 'Foot',
           'Abdomen'] AS r),
         mri_regions AS (SELECT ARRAY['Brain', 'Cervical spine', 'Thoracic spine',
           'Lumbosacral spine', 'Whole spine', 'Shoulder', 'Elbow', 'Wrist', 'Hand', 'Pelvis',
           'Hip', 'Thigh', 'Knee', 'Leg', 'Ankle', 'Foot'] AS r),
         ct_regions AS (SELECT ARRAY['Brain', 'Paranasal sinuses', 'Chest', 'Abdomen and pelvis',
           'Cervical spine', 'Lumbosacral spine', 'Shoulder', 'Elbow', 'Wrist', 'Pelvis', 'Hip',
           'Knee', 'Ankle', 'Foot'] AS r),
         items (kind, name, regions, views, sort_order) AS (
           VALUES
             ('blood'::"TestKind", 'Complete blood count (CBC)', ARRAY[]::text[], ARRAY[]::text[], 10),
             ('blood', 'ESR', ARRAY[]::text[], ARRAY[]::text[], 20),
             ('blood', 'C-reactive protein (CRP)', ARRAY[]::text[], ARRAY[]::text[], 30),
             ('blood', 'Fasting blood sugar', ARRAY[]::text[], ARRAY[]::text[], 40),
             ('blood', 'Post-prandial blood sugar', ARRAY[]::text[], ARRAY[]::text[], 50),
             ('blood', 'HbA1c', ARRAY[]::text[], ARRAY[]::text[], 60),
             ('blood', 'Lipid profile', ARRAY[]::text[], ARRAY[]::text[], 70),
             ('blood', 'Liver function test (LFT)', ARRAY[]::text[], ARRAY[]::text[], 80),
             ('blood', 'Kidney function test (KFT)', ARRAY[]::text[], ARRAY[]::text[], 90),
             ('blood', 'Serum uric acid', ARRAY[]::text[], ARRAY[]::text[], 100),
             ('blood', 'Serum calcium', ARRAY[]::text[], ARRAY[]::text[], 110),
             ('blood', 'Vitamin D (25-OH)', ARRAY[]::text[], ARRAY[]::text[], 120),
             ('blood', 'Vitamin B12', ARRAY[]::text[], ARRAY[]::text[], 130),
             ('blood', 'Thyroid profile (T3, T4, TSH)', ARRAY[]::text[], ARRAY[]::text[], 140),
             ('blood', 'RA factor', ARRAY[]::text[], ARRAY[]::text[], 150),
             ('blood', 'Anti-CCP antibodies', ARRAY[]::text[], ARRAY[]::text[], 160),
             ('blood', 'HLA-B27', ARRAY[]::text[], ARRAY[]::text[], 170),
             ('blood', 'Prothrombin time (PT/INR)', ARRAY[]::text[], ARRAY[]::text[], 180),
             ('xray', 'X-ray', (SELECT r FROM xray_regions),
               ARRAY['AP', 'PA', 'Lateral', 'Oblique', 'Skyline', 'Standing'], 200),
             ('mri', 'MRI', (SELECT r FROM mri_regions), ARRAY[]::text[], 300),
             ('ct', 'CT', (SELECT r FROM ct_regions), ARRAY[]::text[], 400),
             ('other', 'Urine routine', ARRAY[]::text[], ARRAY[]::text[], 500),
             ('other', 'ECG', ARRAY[]::text[], ARRAY[]::text[], 510),
             ('other', 'Ultrasound abdomen', ARRAY[]::text[], ARRAY[]::text[], 520),
             ('other', 'Bone mineral density (DEXA)', ARRAY[]::text[], ARRAY[]::text[], 530),
             ('other', 'Nerve conduction study', ARRAY[]::text[], ARRAY[]::text[], 540)
         )
    INSERT INTO test_catalogue_items
      (id, organisation_id, kind, name, regions, views, sort_order, created_at, updated_at)
    SELECT gen_random_uuid(), p_organisation_id, i.kind, i.name, i.regions, i.views,
           i.sort_order, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM items i
    WHERE NOT EXISTS (
      SELECT 1 FROM test_catalogue_items t
      WHERE t.organisation_id = p_organisation_id AND lower(t.name) = lower(i.name)
    )
    -- A concurrent writer adding the same name between the check and the insert.
    ON CONFLICT (organisation_id, lower(name)) WHERE active DO NOTHING
  $$;
