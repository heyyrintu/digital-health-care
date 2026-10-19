-- Referrals (PRD §7.2), slice 1: a doctor refers a patient from a visit, inside the
-- organisation (to one of its doctors) or outside it (a name, and optionally a specialty,
-- hospital and phone), with a reason, an urgency and notes. Status sent → seen → closed:
-- the receiving doctor's opening it marks it seen (internal only), and either doctor
-- closes it with an optional note. An internal referral that is not closed opens the
-- patient's chart to the receiving doctor under "own patients only" (the API's
-- assertChartAccess). The letter PDF, sending it, and attachments are not built yet.

-- CreateEnum
CREATE TYPE "ReferralKind" AS ENUM ('internal', 'external');

-- CreateEnum
CREATE TYPE "ReferralUrgency" AS ENUM ('routine', 'soon', 'urgent');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('sent', 'seen', 'closed');

-- CreateTable
CREATE TABLE "referrals" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "referring_doctor_user_id" UUID NOT NULL,
    "kind" "ReferralKind" NOT NULL,
    "receiving_doctor_user_id" UUID,
    "external_name" TEXT,
    "external_specialty" TEXT,
    "external_hospital" TEXT,
    "external_phone" TEXT,
    "reason" TEXT NOT NULL,
    "urgency" "ReferralUrgency" NOT NULL,
    "notes" TEXT,
    "status" "ReferralStatus" NOT NULL DEFAULT 'sent',
    "sent_at" TIMESTAMPTZ(3) NOT NULL,
    "seen_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_user_id" UUID,
    "close_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "referrals_appointment_id_idx" ON "referrals"("appointment_id");

-- CreateIndex
CREATE INDEX "referrals_patient_id_idx" ON "referrals"("patient_id");

-- CreateIndex
CREATE INDEX "referrals_organisation_id_receiving_doctor_user_id_status_idx" ON "referrals"("organisation_id", "receiving_doctor_user_id", "status");

-- CreateIndex
CREATE INDEX "referrals_organisation_id_referring_doctor_user_id_status_idx" ON "referrals"("organisation_id", "referring_doctor_user_id", "status");

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Guard rails the API also checks ------------------------------------------------------
-- Internal: a receiving doctor (not the referring one) and no outside details. External:
-- an outside name (the rest optional) and no receiving doctor. Names are on one line with
-- no whitespace at either end; the reason and notes may run over several lines.
ALTER TABLE referrals ADD CONSTRAINT referrals_shape_check
  CHECK (
    (kind = 'internal'
      AND receiving_doctor_user_id IS NOT NULL
      AND receiving_doctor_user_id <> referring_doctor_user_id
      AND external_name IS NULL AND external_specialty IS NULL
      AND external_hospital IS NULL AND external_phone IS NULL)
    OR
    (kind = 'external'
      AND receiving_doctor_user_id IS NULL
      AND external_name IS NOT NULL)
  );
ALTER TABLE referrals ADD CONSTRAINT referrals_text_check
  CHECK (
    (external_name IS NULL OR (length(external_name) BETWEEN 1 AND 120
      AND external_name ~ '^\S(.*\S)?$' AND external_name !~ '[[:cntrl:]]'))
    AND (external_specialty IS NULL OR (length(external_specialty) BETWEEN 1 AND 80
      AND external_specialty ~ '^\S(.*\S)?$' AND external_specialty !~ '[[:cntrl:]]'))
    AND (external_hospital IS NULL OR (length(external_hospital) BETWEEN 1 AND 160
      AND external_hospital ~ '^\S(.*\S)?$' AND external_hospital !~ '[[:cntrl:]]'))
    -- Digits with spaces, brackets and hyphens, optionally after a +: 6 to 20 characters.
    AND (external_phone IS NULL OR external_phone ~ '^\+?[0-9][0-9 ()-]{4,18}[0-9]$')
    AND length(btrim(reason)) BETWEEN 1 AND 500 AND length(reason) <= 500
    AND (notes IS NULL OR (length(btrim(notes)) >= 1 AND length(notes) <= 2000))
    AND (close_note IS NULL OR (length(btrim(close_note)) >= 1 AND length(close_note) <= 500))
  );
-- Each status carries its own times: seen only for internal referrals, after sending;
-- closed with who closed it (one of the two doctors) and when, after it was seen.
ALTER TABLE referrals ADD CONSTRAINT referrals_status_check
  CHECK (
    (status = 'closed') = (closed_at IS NOT NULL)
    AND (closed_at IS NULL) = (closed_by_user_id IS NULL)
    AND (close_note IS NULL OR closed_at IS NOT NULL)
    AND (status <> 'seen' OR seen_at IS NOT NULL)
    AND (status <> 'sent' OR seen_at IS NULL)
    AND (kind = 'internal' OR seen_at IS NULL)
    AND (seen_at IS NULL OR seen_at >= sent_at)
    AND (closed_at IS NULL OR closed_at >= COALESCE(seen_at, sent_at))
    AND (closed_by_user_id IS NULL
      OR closed_by_user_id = referring_doctor_user_id
      OR closed_by_user_id IS NOT DISTINCT FROM receiving_doctor_user_id)
  );

-- Row-level security (ADR 0014). Never deleted by the app.
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON referrals TO dhc_app;
CREATE POLICY tenant_isolation ON referrals TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

-- Same organisation (foreign keys do not see row-level security) ------------------------
CREATE TRIGGER referrals_patient_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, patient_id ON referrals
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('patients', 'patient_id');
CREATE TRIGGER referrals_appointment_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, appointment_id ON referrals
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('appointments', 'appointment_id');
-- Nothing new may point at a merged record.
CREATE TRIGGER referrals_patient_not_merged
  BEFORE INSERT OR UPDATE OF patient_id ON referrals
  FOR EACH ROW EXECUTE FUNCTION patient_not_merged('patient_id');

-- A referral's patient and referring doctor are its visit's (the visit locked FOR SHARE
-- until the transaction ends, as in same_tenant_reference). Users are platform-level, so
-- each doctor named must hold a doctor membership of the organisation; a new referral
-- names only active ones. Tables are schema-qualified with a fixed search_path so a
-- temporary table cannot stand in.
CREATE FUNCTION referrals_same_tenant() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.appointments a
  WHERE a.id = NEW.appointment_id
    AND a.organisation_id = NEW.organisation_id
    AND a.patient_id = NEW.patient_id
    AND a.doctor_user_id = NEW.referring_doctor_user_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'referral does not match its visit' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.user_id = NEW.referring_doctor_user_id
      AND m.organisation_id = NEW.organisation_id
      AND m.role = 'doctor'
      AND (TG_OP = 'UPDATE' OR m.status = 'active')
  ) THEN
    RAISE EXCEPTION 'referring doctor is not a doctor of the organisation'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.receiving_doctor_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.user_id = NEW.receiving_doctor_user_id
      AND m.organisation_id = NEW.organisation_id
      AND m.role = 'doctor'
      AND (TG_OP = 'UPDATE' OR m.status = 'active')
  ) THEN
    RAISE EXCEPTION 'receiving doctor is not a doctor of the organisation'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER referrals_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, appointment_id, patient_id,
    referring_doctor_user_id, receiving_doctor_user_id
  ON referrals FOR EACH ROW EXECUTE FUNCTION referrals_same_tenant();

-- The other side: a patient or visit with referrals keeps its organisation, and the visit
-- keeps its patient and doctor.
CREATE TRIGGER patients_keep_referrals
  BEFORE UPDATE OF organisation_id ON patients
  FOR EACH ROW EXECUTE FUNCTION same_tenant_keep_children('referrals', 'patient_id');
CREATE FUNCTION appointments_keep_referrals() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.organisation_id, NEW.patient_id, NEW.doctor_user_id)
       IS DISTINCT FROM (OLD.organisation_id, OLD.patient_id, OLD.doctor_user_id)
     AND EXISTS (SELECT 1 FROM public.referrals r WHERE r.appointment_id = OLD.id) THEN
    RAISE EXCEPTION 'appointment has referrals' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appointments_keep_referrals
  BEFORE UPDATE OF organisation_id, patient_id, doctor_user_id
  ON appointments FOR EACH ROW EXECUTE FUNCTION appointments_keep_referrals();

-- Once made, only the status moves (sent → seen → closed, or sent → closed) with its
-- times, closer and note; a closed referral does not change at all, and none is deleted.
CREATE FUNCTION referrals_locked() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  changeable CONSTANT text[] := ARRAY['status', 'seen_at', 'closed_at', 'closed_by_user_id',
    'close_note', 'updated_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'sent' OR NEW.seen_at IS NOT NULL OR NEW.closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a referral starts as sent' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a referral is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - changeable) IS DISTINCT FROM (to_jsonb(OLD) - changeable) THEN
    RAISE EXCEPTION 'only a referral''s status can change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'closed' THEN
    IF (to_jsonb(NEW) - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a closed referral cannot change' USING ERRCODE = '23514';
  END IF;
  IF (OLD.status = 'seen' AND NEW.status = 'sent')
     OR (OLD.seen_at IS NOT NULL AND NEW.seen_at IS DISTINCT FROM OLD.seen_at) THEN
    RAISE EXCEPTION 'a referral status only moves forward' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER referrals_locked
  BEFORE INSERT OR UPDATE OR DELETE ON referrals
  FOR EACH ROW EXECUTE FUNCTION referrals_locked();

-- Only these triggers use the functions; no role may call or attach them elsewhere.
REVOKE EXECUTE ON FUNCTION referrals_same_tenant() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION appointments_keep_referrals() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION referrals_locked() FROM PUBLIC;
