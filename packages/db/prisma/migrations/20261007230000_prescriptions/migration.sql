-- CreateEnum
CREATE TYPE "MedicineSource" AS ENUM ('reference', 'clinic');

-- CreateEnum
CREATE TYPE "MedicineRoute" AS ENUM ('oral', 'topical', 'inhaled', 'eye', 'ear', 'nasal', 'injection', 'other');

-- CreateEnum
CREATE TYPE "DoseTiming" AS ENUM ('after_food', 'before_food', 'with_food', 'empty_stomach', 'bedtime');

-- CreateEnum
CREATE TYPE "PrescriptionStatus" AS ENUM ('draft', 'signed', 'void');

-- CreateTable
CREATE TABLE "drug_molecules" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "drug_class" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drug_molecules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medicines" (
    "id" UUID NOT NULL,
    "organisation_id" UUID,
    "name" TEXT NOT NULL,
    "generic_name" TEXT NOT NULL,
    "composition" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "molecule_ids" UUID[],
    "default_route" "MedicineRoute" NOT NULL DEFAULT 'oral',
    "source" "MedicineSource" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medicines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescriptions" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "doctor_user_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "PrescriptionStatus" NOT NULL DEFAULT 'draft',
    "language" "Language" NOT NULL DEFAULT 'en',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "prescriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescription_items" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "prescription_id" UUID NOT NULL,
    "medicine_id" UUID,
    "name" TEXT NOT NULL,
    "composition" TEXT,
    "form" TEXT,
    "route" "MedicineRoute",
    "timing" "DoseTiming",
    "steps" JSONB NOT NULL,
    "quantity" TEXT,
    "instructions" TEXT,
    "remarks" TEXT NOT NULL,
    "remarks_edited" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "prescription_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescription_templates" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "doctor_user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "prescription_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drug_molecules_name_key" ON "drug_molecules"("name");

-- CreateIndex
CREATE INDEX "medicines_organisation_id_idx" ON "medicines"("organisation_id");

-- CreateIndex
CREATE INDEX "prescriptions_patient_id_idx" ON "prescriptions"("patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "prescriptions_appointment_id_version_key" ON "prescriptions"("appointment_id", "version");

-- CreateIndex
CREATE INDEX "prescription_items_prescription_id_idx" ON "prescription_items"("prescription_id");

-- CreateIndex
CREATE UNIQUE INDEX "prescription_templates_organisation_id_doctor_user_id_name_key" ON "prescription_templates"("organisation_id", "doctor_user_id", "name");

-- AddForeignKey
ALTER TABLE "medicines" ADD CONSTRAINT "medicines_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_templates" ADD CONSTRAINT "prescription_templates_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Guard rails the API also checks.
ALTER TABLE medicines ADD CONSTRAINT medicines_source_check
  CHECK ((organisation_id IS NULL) = (source = 'reference'));
ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_numbers_check
  CHECK (version > 0 AND revision > 0);

-- Reference drug data is platform-wide and read-only to clinics; it is loaded by the
-- owner role (licensed import; a synthetic sample in development).
GRANT SELECT ON drug_molecules TO dhc_app;

-- Row-level security (ADR 0014). Clinics read the platform master (no organisation)
-- and their own medicines, and may only write their own.
ALTER TABLE medicines ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON medicines TO dhc_app;
CREATE POLICY tenant_isolation ON medicines TO dhc_app
  USING (organisation_id IS NULL OR organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

-- Draft lines are replaced as the doctor edits; signed prescriptions will be immutable.
ALTER TABLE prescriptions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON prescriptions TO dhc_app;
CREATE POLICY tenant_isolation ON prescriptions TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

ALTER TABLE prescription_items ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON prescription_items TO dhc_app;
CREATE POLICY tenant_isolation ON prescription_items TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

ALTER TABLE prescription_templates ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON prescription_templates TO dhc_app;
CREATE POLICY tenant_isolation ON prescription_templates TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());
