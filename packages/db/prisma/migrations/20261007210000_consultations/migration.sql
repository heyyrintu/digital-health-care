-- CreateEnum
CREATE TYPE "ChartSource" AS ENUM ('doctor', 'patient');

-- CreateEnum
CREATE TYPE "PregnancyStatus" AS ENUM ('not_pregnant', 'pregnant', 'breastfeeding');

-- CreateTable
CREATE TABLE "allergies" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "substance" TEXT NOT NULL,
    "reaction" TEXT,
    "source" "ChartSource" NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by_user_id" UUID,
    "removed_reason" TEXT,

    CONSTRAINT "allergies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medical_conditions" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "icd10_code" TEXT,
    "source" "ChartSource" NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by_user_id" UUID,
    "removed_reason" TEXT,

    CONSTRAINT "medical_conditions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "current_medications" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "dose" TEXT,
    "source" "ChartSource" NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ(3),
    "removed_by_user_id" UUID,
    "removed_reason" TEXT,

    CONSTRAINT "current_medications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vitals" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "bp_systolic" INTEGER,
    "bp_diastolic" INTEGER,
    "pulse" INTEGER,
    "temperature_c" DECIMAL(4,1),
    "spo2" INTEGER,
    "weight_kg" DECIMAL(5,2),
    "height_cm" DECIMAL(5,1),
    "pain_score" INTEGER,
    "pregnancy_status" "PregnancyStatus",
    "recorded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vitals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consultations" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "doctor_user_id" UUID NOT NULL,
    "notes_cipher" TEXT NOT NULL,
    "follow_up_date" DATE,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "locked_at" TIMESTAMPTZ(3),

    CONSTRAINT "consultations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "allergies_patient_id_idx" ON "allergies"("patient_id");

-- CreateIndex
CREATE INDEX "medical_conditions_patient_id_idx" ON "medical_conditions"("patient_id");

-- CreateIndex
CREATE INDEX "current_medications_patient_id_idx" ON "current_medications"("patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "vitals_appointment_id_key" ON "vitals"("appointment_id");

-- CreateIndex
CREATE INDEX "vitals_patient_id_idx" ON "vitals"("patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "consultations_appointment_id_key" ON "consultations"("appointment_id");

-- CreateIndex
CREATE INDEX "consultations_patient_id_idx" ON "consultations"("patient_id");

-- AddForeignKey
ALTER TABLE "allergies" ADD CONSTRAINT "allergies_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allergies" ADD CONSTRAINT "allergies_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_conditions" ADD CONSTRAINT "medical_conditions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_conditions" ADD CONSTRAINT "medical_conditions_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "current_medications" ADD CONSTRAINT "current_medications_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "current_medications" ADD CONSTRAINT "current_medications_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vitals" ADD CONSTRAINT "vitals_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vitals" ADD CONSTRAINT "vitals_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Guard rails the API also checks.
ALTER TABLE vitals ADD CONSTRAINT vitals_ranges_check CHECK (
  (bp_systolic IS NULL OR bp_systolic BETWEEN 40 AND 300)
  AND (bp_diastolic IS NULL OR bp_diastolic BETWEEN 20 AND 200)
  AND (pulse IS NULL OR pulse BETWEEN 20 AND 250)
  AND (temperature_c IS NULL OR temperature_c BETWEEN 30 AND 45)
  AND (spo2 IS NULL OR spo2 BETWEEN 50 AND 100)
  AND (weight_kg IS NULL OR weight_kg BETWEEN 0.3 AND 400)
  AND (height_cm IS NULL OR height_cm BETWEEN 20 AND 250)
  AND (pain_score IS NULL OR pain_score BETWEEN 0 AND 10)
);
ALTER TABLE consultations ADD CONSTRAINT consultations_revision_check CHECK (revision > 0);

-- Row-level security (ADR 0014). Clinical records are never deleted (retention class
-- "Clinical"): chart entries are removed by setting removed_at, consultations lock.
ALTER TABLE allergies ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON allergies TO dhc_app;
CREATE POLICY tenant_isolation ON allergies TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

ALTER TABLE medical_conditions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON medical_conditions TO dhc_app;
CREATE POLICY tenant_isolation ON medical_conditions TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

ALTER TABLE current_medications ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON current_medications TO dhc_app;
CREATE POLICY tenant_isolation ON current_medications TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

ALTER TABLE vitals ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON vitals TO dhc_app;
CREATE POLICY tenant_isolation ON vitals TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

ALTER TABLE consultations ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON consultations TO dhc_app;
CREATE POLICY tenant_isolation ON consultations TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());
