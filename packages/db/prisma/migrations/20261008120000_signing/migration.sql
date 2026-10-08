-- CreateEnum
CREATE TYPE "DoctorVerification" AS ENUM ('pending', 'verified');

-- CreateEnum
CREATE TYPE "PaperSize" AS ENUM ('a4', 'a5');

-- AlterEnum
ALTER TYPE "PrescriptionStatus" ADD VALUE 'superseded';

-- AlterTable
ALTER TABLE "prescriptions" ADD COLUMN     "amendment_reason" TEXT,
ADD COLUMN     "amends_prescription_id" UUID,
ADD COLUMN     "number" TEXT,
ADD COLUMN     "paper_size" "PaperSize",
ADD COLUMN     "pdf_file_key" TEXT,
ADD COLUMN     "pdf_sha256" TEXT,
ADD COLUMN     "signature" TEXT,
ADD COLUMN     "signature_method" TEXT,
ADD COLUMN     "signed_at" TIMESTAMPTZ(3),
ADD COLUMN     "signer_certificate" TEXT,
ADD COLUMN     "superseded_at" TIMESTAMPTZ(3),
ADD COLUMN     "template_version" TEXT,
ADD COLUMN     "verification_code" TEXT,
ADD COLUMN     "void_pdf_file_key" TEXT,
ADD COLUMN     "void_reason" TEXT,
ADD COLUMN     "voided_at" TIMESTAMPTZ(3),
ADD COLUMN     "voided_by_user_id" UUID;

-- CreateTable
CREATE TABLE "prescription_verifications" (
    "code_hash" TEXT NOT NULL,
    "organisation_id" UUID NOT NULL,
    "prescription_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prescription_verifications_pkey" PRIMARY KEY ("code_hash")
);

-- CreateTable
CREATE TABLE "doctor_profiles" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "registration_number" TEXT,
    "council" TEXT,
    "qualifications" TEXT,
    "specialty" TEXT,
    "rx_prefix" TEXT,
    "rx_sequence" INTEGER NOT NULL DEFAULT 0,
    "paper_size" "PaperSize" NOT NULL DEFAULT 'a5',
    "verification" "DoctorVerification" NOT NULL DEFAULT 'pending',
    "verified_at" TIMESTAMPTZ(3),
    "verified_by" TEXT,
    "signing_pin_hash" TEXT,
    "pin_failed_count" INTEGER NOT NULL DEFAULT 0,
    "pin_locked_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "doctor_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "prescription_verifications_prescription_id_key" ON "prescription_verifications"("prescription_id");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_profiles_organisation_id_user_id_key" ON "doctor_profiles"("organisation_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_profiles_organisation_id_rx_prefix_key" ON "doctor_profiles"("organisation_id", "rx_prefix");

-- CreateIndex
CREATE UNIQUE INDEX "prescriptions_amends_prescription_id_key" ON "prescriptions"("amends_prescription_id");

-- CreateIndex
CREATE UNIQUE INDEX "prescriptions_verification_code_key" ON "prescriptions"("verification_code");

-- CreateIndex
CREATE UNIQUE INDEX "prescriptions_organisation_id_number_version_key" ON "prescriptions"("organisation_id", "number", "version");

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_amends_prescription_id_fkey" FOREIGN KEY ("amends_prescription_id") REFERENCES "prescriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_verifications" ADD CONSTRAINT "prescription_verifications_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescription_verifications" ADD CONSTRAINT "prescription_verifications_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_profiles" ADD CONSTRAINT "doctor_profiles_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Guard rails. A signed version carries everything that proves it: its number, the stored
-- PDF and its hash, the signature and the verification code. (The new `superseded` value
-- cannot be used as an enum in the migration that adds it, so it is compared as text.)
ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_signed_fields_check
  CHECK ((status = 'draft') = (signed_at IS NULL)
         AND (status = 'draft' OR (number IS NOT NULL AND pdf_file_key IS NOT NULL
              AND pdf_sha256 IS NOT NULL AND template_version IS NOT NULL
              AND paper_size IS NOT NULL AND signature_method IS NOT NULL
              AND signature IS NOT NULL AND verification_code IS NOT NULL)));
ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_pdf_sha256_check
  CHECK (pdf_sha256 IS NULL OR pdf_sha256 ~ '^[0-9a-f]{64}$');
ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_superseded_check
  CHECK ((status::text = 'superseded') = (superseded_at IS NOT NULL));
ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_void_check
  CHECK ((status = 'void') = (voided_at IS NOT NULL)
         AND (voided_at IS NULL OR (void_reason IS NOT NULL AND voided_by_user_id IS NOT NULL
                                    AND void_pdf_file_key IS NOT NULL)));
ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_amendment_check
  CHECK ((amends_prescription_id IS NULL) = (amendment_reason IS NULL)
         AND (amends_prescription_id IS NULL) = (version = 1));
ALTER TABLE doctor_profiles ADD CONSTRAINT doctor_profiles_rx_prefix_check
  CHECK (rx_prefix IS NULL OR rx_prefix ~ '^[A-Z0-9]{1,8}$');
ALTER TABLE doctor_profiles ADD CONSTRAINT doctor_profiles_verified_check
  CHECK ((verification = 'verified') = (verified_at IS NOT NULL));

ALTER TABLE doctor_profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON doctor_profiles TO dhc_app;
CREATE POLICY tenant_isolation ON doctor_profiles TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

-- The QR lookup: written when a version is signed, read without a session by the sign-in
-- role (like display screens). It holds a hash of the code and the IDs, nothing clinical.
ALTER TABLE prescription_verifications ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON prescription_verifications TO dhc_app;
CREATE POLICY tenant_isolation ON prescription_verifications TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());
GRANT SELECT ON prescription_verifications TO dhc_auth;
CREATE POLICY auth_lookup ON prescription_verifications FOR SELECT TO dhc_auth USING (true);

CREATE FUNCTION prescription_verifications_same_tenant() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.prescriptions p
    WHERE p.id = NEW.prescription_id AND p.organisation_id = NEW.organisation_id
  ) THEN
    RAISE EXCEPTION 'verification does not match its prescription' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prescription_verifications_same_tenant
  BEFORE INSERT OR UPDATE ON prescription_verifications
  FOR EACH ROW EXECUTE FUNCTION prescription_verifications_same_tenant();

-- An amendment is the next version of a prescription for the same visit.
CREATE FUNCTION prescriptions_amendment_chain() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.amends_prescription_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.prescriptions p
    WHERE p.id = NEW.amends_prescription_id
      AND p.organisation_id = NEW.organisation_id
      AND p.appointment_id = NEW.appointment_id
      AND p.version = NEW.version - 1
  ) THEN
    RAISE EXCEPTION 'amendment does not follow its prescription' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prescriptions_amendment_chain
  BEFORE INSERT OR UPDATE OF amends_prescription_id, appointment_id, version
  ON prescriptions FOR EACH ROW EXECUTE FUNCTION prescriptions_amendment_chain();

-- Signed prescriptions are immutable (PRD §6.6). A signed version may only be superseded
-- by its amendment or voided, which touch nothing but the status and those fields; a
-- superseded or void version never changes again.
CREATE FUNCTION prescriptions_immutable() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  changeable CONSTANT text[] := ARRAY['status', 'superseded_at', 'voided_at',
    'voided_by_user_id', 'void_reason', 'void_pdf_file_key', 'updated_at'];
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF OLD.status::text = 'signed' AND NEW.status::text IN ('signed', 'superseded', 'void')
     AND (to_jsonb(NEW) - changeable) = (to_jsonb(OLD) - changeable) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a signed prescription cannot change' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER prescriptions_immutable
  BEFORE UPDATE ON prescriptions FOR EACH ROW EXECUTE FUNCTION prescriptions_immutable();

-- Lines and the safety log of a signed version are frozen with it.
CREATE FUNCTION prescription_children_frozen() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (TG_OP <> 'INSERT' AND EXISTS (
        SELECT 1 FROM public.prescriptions p
        WHERE p.id = OLD.prescription_id AND p.status <> 'draft'))
     OR (TG_OP <> 'DELETE' AND EXISTS (
        SELECT 1 FROM public.prescriptions p
        WHERE p.id = NEW.prescription_id AND p.status <> 'draft')) THEN
    RAISE EXCEPTION 'a signed prescription cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER prescription_items_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON prescription_items
  FOR EACH ROW EXECUTE FUNCTION prescription_children_frozen();
CREATE TRIGGER safety_alerts_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON safety_alerts
  FOR EACH ROW EXECUTE FUNCTION prescription_children_frozen();

-- The visit record locks when its prescription is first signed, and stays locked.
CREATE FUNCTION consultations_stay_locked() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'the consultation is locked' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consultations_stay_locked
  BEFORE UPDATE ON consultations FOR EACH ROW EXECUTE FUNCTION consultations_stay_locked();

-- Only these triggers use the functions; no role may attach them elsewhere.
REVOKE EXECUTE ON FUNCTION prescription_verifications_same_tenant() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prescriptions_amendment_chain() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prescriptions_immutable() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION prescription_children_frozen() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION consultations_stay_locked() FROM PUBLIC;
