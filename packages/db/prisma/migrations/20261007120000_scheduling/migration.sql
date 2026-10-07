-- CreateEnum
CREATE TYPE "ConsultationMode" AS ENUM ('in_person', 'audio', 'video');

-- CreateEnum
CREATE TYPE "AvailabilityExceptionType" AS ENUM ('leave', 'holiday', 'extra_session');

-- CreateTable
CREATE TABLE "clinics" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "clinics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consultation_types" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "ConsultationMode" NOT NULL,
    "default_duration_min" INTEGER NOT NULL,
    "fee_paise" INTEGER NOT NULL,
    "follow_up_fee_paise" INTEGER,
    "requires_prepayment" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "consultation_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_rules" (
    "organisation_id" UUID NOT NULL,
    "horizon_days" INTEGER NOT NULL DEFAULT 30,
    "same_day_cutoff_minutes" INTEGER NOT NULL DEFAULT 60,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "booking_rules_pkey" PRIMARY KEY ("organisation_id")
);

-- CreateTable
CREATE TABLE "availability_versions" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "doctor_user_id" UUID NOT NULL,
    "clinic_id" UUID NOT NULL,
    "consultation_type_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "weekly" JSONB NOT NULL,
    "slot_minutes" INTEGER NOT NULL,
    "buffer_minutes" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "availability_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_exceptions" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "type" "AvailabilityExceptionType" NOT NULL,
    "doctor_user_id" UUID,
    "clinic_id" UUID,
    "consultation_type_id" UUID,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "start_time" TEXT,
    "end_time" TEXT,
    "reason" TEXT,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "availability_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clinics_organisation_id_name_key" ON "clinics"("organisation_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "consultation_types_organisation_id_name_key" ON "consultation_types"("organisation_id", "name");

-- CreateIndex
CREATE INDEX "availability_versions_organisation_id_doctor_user_id_idx" ON "availability_versions"("organisation_id", "doctor_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "availability_versions_doctor_user_id_clinic_id_consultation_key" ON "availability_versions"("doctor_user_id", "clinic_id", "consultation_type_id", "effective_from");

-- CreateIndex
CREATE INDEX "availability_exceptions_organisation_id_start_date_idx" ON "availability_exceptions"("organisation_id", "start_date");

-- AddForeignKey
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultation_types" ADD CONSTRAINT "consultation_types_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_rules" ADD CONSTRAINT "booking_rules_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_versions" ADD CONSTRAINT "availability_versions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_versions" ADD CONSTRAINT "availability_versions_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_versions" ADD CONSTRAINT "availability_versions_consultation_type_id_fkey" FOREIGN KEY ("consultation_type_id") REFERENCES "consultation_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_consultation_type_id_fkey" FOREIGN KEY ("consultation_type_id") REFERENCES "consultation_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Guard rails the API also checks (PRD §4.3).
ALTER TABLE consultation_types ADD CONSTRAINT consultation_types_amounts_check
  CHECK (default_duration_min BETWEEN 5 AND 240 AND fee_paise >= 0
    AND (follow_up_fee_paise IS NULL OR follow_up_fee_paise >= 0));
ALTER TABLE booking_rules ADD CONSTRAINT booking_rules_range_check
  CHECK (horizon_days BETWEEN 1 AND 365 AND same_day_cutoff_minutes BETWEEN 0 AND 1440);
ALTER TABLE availability_versions ADD CONSTRAINT availability_versions_minutes_check
  CHECK (slot_minutes BETWEEN 5 AND 240 AND buffer_minutes BETWEEN 0 AND 120);
ALTER TABLE availability_exceptions ADD CONSTRAINT availability_exceptions_dates_check
  CHECK (end_date >= start_date AND (start_time IS NULL) = (end_time IS NULL));

-- Row-level security (ADR 0014). Clinics, consultation types and booking rules are
-- deactivated rather than deleted. Schedule versions and exceptions may be deleted
-- while they still lie in the future (the API checks the date and audits it).
ALTER TABLE clinics ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON clinics TO dhc_app;
CREATE POLICY tenant_isolation ON clinics TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

ALTER TABLE consultation_types ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON consultation_types TO dhc_app;
CREATE POLICY tenant_isolation ON consultation_types TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

ALTER TABLE booking_rules ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON booking_rules TO dhc_app;
CREATE POLICY tenant_isolation ON booking_rules TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

ALTER TABLE availability_versions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON availability_versions TO dhc_app;
CREATE POLICY tenant_isolation ON availability_versions TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

ALTER TABLE availability_exceptions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON availability_exceptions TO dhc_app;
CREATE POLICY tenant_isolation ON availability_exceptions TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());
