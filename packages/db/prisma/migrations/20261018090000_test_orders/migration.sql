-- Test orders (PRD §7.1): the clinic's test catalogue, the tests a doctor orders at a visit,
-- and the results uploaded against them. Orders are written with the visit's prescription
-- draft, print under "Prescribed tests" on the signed PDF, and lock when it is signed;
-- from then on only their status moves: ordered → result_uploaded → reviewed.

-- CreateEnum
CREATE TYPE "TestKind" AS ENUM ('blood', 'xray', 'mri', 'ct', 'other');

-- CreateEnum
CREATE TYPE "TestSide" AS ENUM ('left', 'right', 'both', 'na');

-- CreateEnum
CREATE TYPE "TestOrderStatus" AS ENUM ('ordered', 'result_uploaded', 'reviewed');

-- CreateTable
CREATE TABLE "test_catalogue_items" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "kind" "TestKind" NOT NULL,
    "name" TEXT NOT NULL,
    "regions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "views" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_catalogue_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_orders" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "doctor_user_id" UUID NOT NULL,
    "catalogue_item_id" UUID,
    "kind" "TestKind" NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT,
    "side" "TestSide" NOT NULL DEFAULT 'na',
    "views" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "sort_order" INTEGER NOT NULL,
    "status" "TestOrderStatus" NOT NULL DEFAULT 'ordered',
    "prescription_id" UUID,
    "ordered_at" TIMESTAMPTZ(3),
    "result_uploaded_at" TIMESTAMPTZ(3),
    "reviewed_at" TIMESTAMPTZ(3),
    "reviewed_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "test_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_results" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "test_order_id" UUID NOT NULL,
    "file_key" TEXT NOT NULL,
    "media_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaded_by_user_id" UUID NOT NULL,
    "uploaded_by_role" "Role" NOT NULL,
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "test_catalogue_items_organisation_id_name_key" ON "test_catalogue_items"("organisation_id", "name");

-- CreateIndex
CREATE INDEX "test_orders_appointment_id_idx" ON "test_orders"("appointment_id");

-- CreateIndex
CREATE INDEX "test_orders_patient_id_idx" ON "test_orders"("patient_id");

-- CreateIndex
CREATE INDEX "test_orders_organisation_id_doctor_user_id_status_idx" ON "test_orders"("organisation_id", "doctor_user_id", "status");

-- CreateIndex
CREATE INDEX "test_results_test_order_id_idx" ON "test_results"("test_order_id");

-- AddForeignKey
ALTER TABLE "test_catalogue_items" ADD CONSTRAINT "test_catalogue_items_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_orders" ADD CONSTRAINT "test_orders_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_orders" ADD CONSTRAINT "test_orders_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_orders" ADD CONSTRAINT "test_orders_catalogue_item_id_fkey" FOREIGN KEY ("catalogue_item_id") REFERENCES "test_catalogue_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_orders" ADD CONSTRAINT "test_orders_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_results" ADD CONSTRAINT "test_results_test_order_id_fkey" FOREIGN KEY ("test_order_id") REFERENCES "test_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Guard rails the API also checks ------------------------------------------------------
-- Imaging (X-ray, MRI, CT) has body regions; only X-rays have views. A blood test or an
-- "other" test has neither, and no side.
ALTER TABLE test_catalogue_items ADD CONSTRAINT test_catalogue_items_shape_check
  CHECK (
    length(btrim(name)) BETWEEN 1 AND 200
    AND regions IS NOT NULL AND views IS NOT NULL
    AND (kind IN ('xray', 'mri', 'ct') OR cardinality(regions) = 0)
    AND (kind = 'xray' OR cardinality(views) = 0)
  );
ALTER TABLE test_orders ADD CONSTRAINT test_orders_shape_check
  CHECK (
    length(btrim(name)) BETWEEN 1 AND 200
    AND (region IS NULL OR length(region) BETWEEN 1 AND 80)
    AND (notes IS NULL OR length(notes) <= 500)
    AND views IS NOT NULL AND cardinality(views) <= 6
    AND sort_order >= 0
    AND (kind IN ('xray', 'mri', 'ct') OR (region IS NULL AND side = 'na'))
    AND (kind = 'xray' OR cardinality(views) = 0)
  );
-- A draft line has no ordering version; an ordered one has both. Each status carries its
-- own time, and a review names the doctor.
ALTER TABLE test_orders ADD CONSTRAINT test_orders_status_check
  CHECK (
    (ordered_at IS NULL) = (prescription_id IS NULL)
    AND (status = 'ordered' OR ordered_at IS NOT NULL)
    AND (status = 'ordered' OR result_uploaded_at IS NOT NULL)
    AND ((status = 'reviewed') = (reviewed_at IS NOT NULL))
    AND ((reviewed_at IS NULL) = (reviewed_by_user_id IS NULL))
  );
ALTER TABLE test_results ADD CONSTRAINT test_results_file_check
  CHECK (size_bytes > 0 AND sha256 ~ '^[0-9a-f]{64}$' AND length(file_key) > 0);
-- Results come from the patient, the front desk or a doctor; clinic admins never upload.
ALTER TABLE test_results ADD CONSTRAINT test_results_uploader_role_check
  CHECK (uploaded_by_role IN ('patient', 'front_desk', 'doctor'));

-- Row-level security (ADR 0014). Results are append-only for the app.
ALTER TABLE test_catalogue_items ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON test_catalogue_items TO dhc_app;
CREATE POLICY tenant_isolation ON test_catalogue_items TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

ALTER TABLE test_orders ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON test_orders TO dhc_app;
CREATE POLICY tenant_isolation ON test_orders TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

ALTER TABLE test_results ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON test_results TO dhc_app;
CREATE POLICY tenant_isolation ON test_results TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

-- Same organisation (foreign keys do not see row-level security) ------------------------
-- An order's patient and doctor are its visit's; its prescription is a version of that
-- visit; its reviewer is a doctor of the same organisation. The parents are locked FOR
-- SHARE until the transaction ends, as in same_tenant_reference, so a concurrent move of
-- the parent cannot slip between the check and the commit. Tables are schema-qualified
-- with a fixed search_path so a temporary table cannot stand in.
CREATE FUNCTION test_orders_same_tenant() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.appointments a
  WHERE a.id = NEW.appointment_id
    AND a.organisation_id = NEW.organisation_id
    AND a.patient_id = NEW.patient_id
    AND a.doctor_user_id = NEW.doctor_user_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'test order does not match its visit' USING ERRCODE = '23514';
  END IF;
  IF NEW.prescription_id IS NOT NULL THEN
    PERFORM 1 FROM public.prescriptions p
    WHERE p.id = NEW.prescription_id
      AND p.organisation_id = NEW.organisation_id
      AND p.appointment_id = NEW.appointment_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'test order does not match its visit' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER test_orders_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, appointment_id, patient_id, doctor_user_id,
    prescription_id
  ON test_orders FOR EACH ROW EXECUTE FUNCTION test_orders_same_tenant();

-- Users are platform-level (no organisation of their own): a user named on a clinic row
-- must hold a membership of that clinic in the role the row says.
CREATE FUNCTION test_orders_reviewer_same_tenant() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.reviewed_by_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.user_id = NEW.reviewed_by_user_id
      AND m.organisation_id = NEW.organisation_id
      AND m.role = 'doctor'
  ) THEN
    RAISE EXCEPTION 'test order reviewer is not a doctor of its organisation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER test_orders_reviewer_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, reviewed_by_user_id ON test_orders
  FOR EACH ROW EXECUTE FUNCTION test_orders_reviewer_same_tenant();
CREATE TRIGGER test_orders_catalogue_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, catalogue_item_id ON test_orders
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('test_catalogue_items', 'catalogue_item_id');
CREATE TRIGGER test_catalogue_items_keep_children
  BEFORE UPDATE OF organisation_id ON test_catalogue_items
  FOR EACH ROW EXECUTE FUNCTION same_tenant_keep_children('test_orders', 'catalogue_item_id');

-- A result belongs to an order of the same clinic that has been ordered (signed), locked
-- FOR SHARE like the parents above, and its uploader is a member of that clinic in the
-- role recorded.
CREATE FUNCTION test_results_same_tenant() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.test_orders o
  WHERE o.id = NEW.test_order_id
    AND o.organisation_id = NEW.organisation_id
    AND o.ordered_at IS NOT NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'test result does not match an ordered test' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.user_id = NEW.uploaded_by_user_id
      AND m.organisation_id = NEW.organisation_id
      AND m.role = NEW.uploaded_by_role
  ) THEN
    RAISE EXCEPTION 'test result uploader is not a member of its organisation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER test_results_same_tenant
  BEFORE INSERT ON test_results FOR EACH ROW EXECUTE FUNCTION test_results_same_tenant();

-- A visit with test orders keeps its organisation, patient and doctor.
CREATE FUNCTION appointments_keep_test_orders() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.organisation_id, NEW.patient_id, NEW.doctor_user_id)
       IS DISTINCT FROM (OLD.organisation_id, OLD.patient_id, OLD.doctor_user_id)
     AND EXISTS (SELECT 1 FROM public.test_orders o WHERE o.appointment_id = OLD.id) THEN
    RAISE EXCEPTION 'appointment has test orders' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appointments_keep_test_orders
  BEFORE UPDATE OF organisation_id, patient_id, doctor_user_id
  ON appointments FOR EACH ROW EXECUTE FUNCTION appointments_keep_test_orders();

-- Locked once ordered (PRD §7.1, like the lines of a signed prescription) ---------------
-- A test starts as a draft line and is ordered only by the version being signed: the
-- visit's newest version, signed, at the same instant. An ordered test is never deleted,
-- and only its status and the times and reviewer that go with it change: forwards only
-- (ordered → result_uploaded → reviewed), and not at all once reviewed. A draft line
-- changes freely (the API allows it only while the visit's prescription is a draft).
CREATE FUNCTION test_orders_locked() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  changeable CONSTANT text[] := ARRAY['status', 'result_uploaded_at', 'reviewed_at',
    'reviewed_by_user_id', 'updated_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.ordered_at IS NOT NULL OR NEW.prescription_id IS NOT NULL THEN
      RAISE EXCEPTION 'a test is ordered only by signing its prescription'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.ordered_at IS NULL THEN
    IF TG_OP = 'UPDATE' AND NEW.ordered_at IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.prescriptions p
      WHERE p.id = NEW.prescription_id
        AND p.appointment_id = NEW.appointment_id
        AND p.status = 'signed'
        AND p.signed_at = NEW.ordered_at
        AND NOT EXISTS (
          SELECT 1 FROM public.prescriptions q
          WHERE q.appointment_id = p.appointment_id AND q.version > p.version
        )
    ) THEN
      RAISE EXCEPTION 'a test is ordered only by the version being signed'
        USING ERRCODE = '23514';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - changeable) = (to_jsonb(OLD) - changeable) THEN
    -- The status only moves forward: ordered → result_uploaded (again for each further
    -- result) → reviewed. A review is final: once reviewed nothing changes but updated_at.
    IF OLD.status = 'reviewed' THEN
      IF (to_jsonb(NEW) - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'a reviewed test cannot change' USING ERRCODE = '23514';
    END IF;
    IF (OLD.status = 'result_uploaded' AND NEW.status = 'ordered')
       OR (OLD.result_uploaded_at IS NOT NULL AND NEW.result_uploaded_at IS NULL) THEN
      RAISE EXCEPTION 'a test status only moves forward' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'an ordered test cannot change' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER test_orders_locked
  BEFORE INSERT OR UPDATE OR DELETE ON test_orders
  FOR EACH ROW EXECUTE FUNCTION test_orders_locked();

-- The default catalogue -----------------------------------------------------------------
-- Every organisation starts with common blood tests and imaging by region (the clinic can
-- deactivate what it does not use). Run for each new organisation by the trigger below,
-- however it is created (platform onboarding, the development seed, tests), and once here
-- for the organisations that already exist. Adding again skips names already listed.
CREATE FUNCTION seed_test_catalogue(p_organisation_id uuid) RETURNS void
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
    SELECT gen_random_uuid(), p_organisation_id, kind, name, regions, views, sort_order,
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM items
    ON CONFLICT (organisation_id, name) DO NOTHING
  $$;

CREATE FUNCTION organisations_seed_test_catalogue() RETURNS trigger LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.seed_test_catalogue(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER organisations_seed_test_catalogue
  AFTER INSERT ON organisations
  FOR EACH ROW EXECUTE FUNCTION organisations_seed_test_catalogue();

SELECT seed_test_catalogue(id) FROM organisations;

-- Only these triggers use the functions; no role may call or attach them elsewhere.
REVOKE EXECUTE ON FUNCTION test_orders_same_tenant() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION test_orders_reviewer_same_tenant() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION test_results_same_tenant() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION appointments_keep_test_orders() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION test_orders_locked() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION seed_test_catalogue(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION organisations_seed_test_catalogue() FROM PUBLIC;
