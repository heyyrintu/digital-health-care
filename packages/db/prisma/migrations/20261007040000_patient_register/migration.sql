-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('female', 'male', 'other');

-- CreateEnum
CREATE TYPE "Language" AS ENUM ('en', 'hi');

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "address" TEXT,
ADD COLUMN     "blood_group" TEXT,
ADD COLUMN     "created_by_user_id" UUID,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "emergency_contact_name" TEXT,
ADD COLUMN     "emergency_contact_phone" TEXT,
ADD COLUMN     "gender" "Gender",
ADD COLUMN     "guardian_patient_id" UUID,
ADD COLUMN     "language" "Language" NOT NULL DEFAULT 'en';

-- CreateTable
CREATE TABLE "uhid_settings" (
    "organisation_id" UUID NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "next_number" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "uhid_settings_pkey" PRIMARY KEY ("organisation_id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "colour" TEXT NOT NULL,
    "sort_to_top" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patient_tags" (
    "organisation_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "added_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patient_tags_pkey" PRIMARY KEY ("patient_id","tag_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tags_organisation_id_name_key" ON "tags"("organisation_id", "name");

-- CreateIndex
CREATE INDEX "patient_tags_organisation_id_tag_id_idx" ON "patient_tags"("organisation_id", "tag_id");

-- CreateIndex
CREATE INDEX "patients_guardian_patient_id_idx" ON "patients"("guardian_patient_id");

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_guardian_patient_id_fkey" FOREIGN KEY ("guardian_patient_id") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uhid_settings" ADD CONSTRAINT "uhid_settings_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tags" ADD CONSTRAINT "tags_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_tags" ADD CONSTRAINT "patient_tags_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_tags" ADD CONSTRAINT "patient_tags_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_tags" ADD CONSTRAINT "patient_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Row-level security (ADR 0014) ----------------------------------------------------
-- UHID numbering: one row per organisation, read and advanced inside its transaction.
ALTER TABLE uhid_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON uhid_settings TO dhc_app;
CREATE POLICY tenant_isolation ON uhid_settings TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

-- Tags are archived, never deleted, so past assignments keep their meaning.
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON tags TO dhc_app;
CREATE POLICY tenant_isolation ON tags TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

-- Removing a tag from a patient deletes the assignment (audited by the API).
ALTER TABLE patient_tags ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON patient_tags TO dhc_app;
CREATE POLICY tenant_isolation ON patient_tags TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());
