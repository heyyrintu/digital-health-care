-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('pending', 'confirmed', 'checked_in', 'in_consultation', 'completed', 'cancelled', 'no_show', 'rescheduled');

-- CreateEnum
CREATE TYPE "AppointmentSource" AS ENUM ('front_desk', 'walk_in', 'app', 'web');

-- AlterTable
ALTER TABLE "booking_rules" ADD COLUMN     "overbook_per_day" INTEGER NOT NULL DEFAULT 2;

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "doctor_user_id" UUID NOT NULL,
    "clinic_id" UUID NOT NULL,
    "consultation_type_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "end_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "AppointmentStatus" NOT NULL,
    "source" "AppointmentSource" NOT NULL,
    "token_number" INTEGER NOT NULL,
    "overbook" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "cancel_reason" TEXT,
    "rescheduled_from_id" UUID,
    "checked_in_at" TIMESTAMPTZ(3),
    "consultation_started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_status_history" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "from_status" "AppointmentStatus",
    "to_status" "AppointmentStatus" NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "note" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointment_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "appointments_rescheduled_from_id_key" ON "appointments"("rescheduled_from_id");

-- CreateIndex
CREATE INDEX "appointments_organisation_id_date_idx" ON "appointments"("organisation_id", "date");

-- CreateIndex
CREATE INDEX "appointments_doctor_user_id_date_idx" ON "appointments"("doctor_user_id", "date");

-- CreateIndex
CREATE INDEX "appointments_patient_id_idx" ON "appointments"("patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_doctor_user_id_clinic_id_date_token_number_key" ON "appointments"("doctor_user_id", "clinic_id", "date", "token_number");

-- CreateIndex
CREATE INDEX "appointment_status_history_appointment_id_idx" ON "appointment_status_history"("appointment_id");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_consultation_type_id_fkey" FOREIGN KEY ("consultation_type_id") REFERENCES "consultation_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_rescheduled_from_id_fkey" FOREIGN KEY ("rescheduled_from_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_status_history" ADD CONSTRAINT "appointment_status_history_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_status_history" ADD CONSTRAINT "appointment_status_history_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Guard rails the API also checks.
ALTER TABLE booking_rules ADD CONSTRAINT booking_rules_overbook_check
  CHECK (overbook_per_day BETWEEN 0 AND 50);
ALTER TABLE appointments ADD CONSTRAINT appointments_times_check
  CHECK (end_at > start_at AND token_number > 0);

-- Row-level security (ADR 0014). Appointments are never deleted: cancellations,
-- no-shows and reschedules are statuses. Status history is append-only.
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON appointments TO dhc_app;
CREATE POLICY tenant_isolation ON appointments TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

ALTER TABLE appointment_status_history ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON appointment_status_history TO dhc_app;
CREATE POLICY tenant_isolation ON appointment_status_history TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());
