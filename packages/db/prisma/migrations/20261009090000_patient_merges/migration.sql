-- CreateEnum
CREATE TYPE "PatientMergeStatus" AS ENUM ('pending', 'approved', 'rejected');

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "merged_at" TIMESTAMPTZ(3),
ADD COLUMN     "merged_into_id" UUID;

-- CreateTable
CREATE TABLE "patient_merge_requests" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "source_patient_id" UUID NOT NULL,
    "target_patient_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "PatientMergeStatus" NOT NULL DEFAULT 'pending',
    "requested_by_user_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,

    CONSTRAINT "patient_merge_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "patient_merge_requests_organisation_id_status_idx" ON "patient_merge_requests"("organisation_id", "status");

-- CreateIndex
CREATE INDEX "patient_merge_requests_source_patient_id_idx" ON "patient_merge_requests"("source_patient_id");

-- CreateIndex
CREATE INDEX "patient_merge_requests_target_patient_id_idx" ON "patient_merge_requests"("target_patient_id");

-- CreateIndex
CREATE INDEX "patients_merged_into_id_idx" ON "patients"("merged_into_id");

-- AddForeignKey
ALTER TABLE "patient_merge_requests" ADD CONSTRAINT "patient_merge_requests_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_merge_requests" ADD CONSTRAINT "patient_merge_requests_source_patient_id_fkey" FOREIGN KEY ("source_patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patient_merge_requests" ADD CONSTRAINT "patient_merge_requests_target_patient_id_fkey" FOREIGN KEY ("target_patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Guard rails. A request merges two different records; a decided request says who decided
-- and when, and a rejection says why. A merged record points at another record, never itself.
ALTER TABLE patient_merge_requests ADD CONSTRAINT patient_merge_requests_two_patients
  CHECK (source_patient_id <> target_patient_id);
ALTER TABLE patient_merge_requests ADD CONSTRAINT patient_merge_requests_decision
  CHECK ((status = 'pending') = (decided_at IS NULL)
         AND (decided_at IS NULL) = (decided_by_user_id IS NULL)
         AND (status <> 'rejected' OR decision_note IS NOT NULL));
-- One open request per duplicate at a time.
CREATE UNIQUE INDEX patient_merge_requests_one_pending
  ON patient_merge_requests (source_patient_id) WHERE status = 'pending';
ALTER TABLE patients ADD CONSTRAINT patients_merge
  CHECK (merged_into_id IS DISTINCT FROM id AND (merged_into_id IS NULL) = (merged_at IS NULL));

-- Requests belong to one clinic; they are decided, never deleted.
ALTER TABLE patient_merge_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON patient_merge_requests TO dhc_app;
CREATE POLICY tenant_isolation ON patient_merge_requests TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

-- Both records are the clinic's own (the shared check from the same-tenant migration).
CREATE TRIGGER patient_merge_requests_source_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, source_patient_id ON patient_merge_requests
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('patients', 'source_patient_id');
CREATE TRIGGER patient_merge_requests_target_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, target_patient_id ON patient_merge_requests
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('patients', 'target_patient_id');
CREATE TRIGGER patients_merged_into_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, merged_into_id ON patients
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('patients', 'merged_into_id');

-- A merged record is closed: nothing new may point at it (visits, chart entries, tags, a
-- guardian link, another merge), so its history cannot grow behind the kept record.
-- Trigger argument: the column on the row being written that names a patient.
CREATE FUNCTION patient_not_merged() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  ref_id uuid := to_jsonb(NEW) ->> TG_ARGV[0];
BEGIN
  IF ref_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.patients p WHERE p.id = ref_id AND p.merged_into_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION '%.% names a patient record that was merged into another',
      TG_TABLE_NAME, TG_ARGV[0] USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appointments_patient_not_merged
  BEFORE INSERT OR UPDATE OF patient_id ON appointments
  FOR EACH ROW EXECUTE FUNCTION patient_not_merged('patient_id');
CREATE TRIGGER allergies_patient_not_merged
  BEFORE INSERT OR UPDATE OF patient_id ON allergies
  FOR EACH ROW EXECUTE FUNCTION patient_not_merged('patient_id');
CREATE TRIGGER medical_conditions_patient_not_merged
  BEFORE INSERT OR UPDATE OF patient_id ON medical_conditions
  FOR EACH ROW EXECUTE FUNCTION patient_not_merged('patient_id');
CREATE TRIGGER current_medications_patient_not_merged
  BEFORE INSERT OR UPDATE OF patient_id ON current_medications
  FOR EACH ROW EXECUTE FUNCTION patient_not_merged('patient_id');
CREATE TRIGGER patient_tags_patient_not_merged
  BEFORE INSERT ON patient_tags
  FOR EACH ROW EXECUTE FUNCTION patient_not_merged('patient_id');
CREATE TRIGGER patients_guardian_not_merged
  BEFORE INSERT OR UPDATE OF guardian_patient_id ON patients
  FOR EACH ROW EXECUTE FUNCTION patient_not_merged('guardian_patient_id');
CREATE TRIGGER patients_merged_into_not_merged
  BEFORE INSERT OR UPDATE OF merged_into_id ON patients
  FOR EACH ROW EXECUTE FUNCTION patient_not_merged('merged_into_id');
CREATE TRIGGER patient_merge_requests_source_not_merged
  BEFORE INSERT ON patient_merge_requests
  FOR EACH ROW EXECUTE FUNCTION patient_not_merged('source_patient_id');
CREATE TRIGGER patient_merge_requests_target_not_merged
  BEFORE INSERT ON patient_merge_requests
  FOR EACH ROW EXECUTE FUNCTION patient_not_merged('target_patient_id');
REVOKE EXECUTE ON FUNCTION patient_not_merged() FROM PUBLIC;

-- A patient keeps its organisation while merge requests or merged records point at it.
DROP TRIGGER patients_keep_children ON patients;
CREATE TRIGGER patients_keep_children
  BEFORE UPDATE OF organisation_id ON patients
  FOR EACH ROW EXECUTE FUNCTION same_tenant_keep_children(
    'patients', 'guardian_patient_id', 'patient_tags', 'patient_id',
    'appointments', 'patient_id', 'allergies', 'patient_id',
    'medical_conditions', 'patient_id', 'current_medications', 'patient_id',
    'vitals', 'patient_id', 'consultations', 'patient_id', 'prescriptions', 'patient_id',
    'bills', 'patient_id', 'patients', 'merged_into_id',
    'patient_merge_requests', 'source_patient_id', 'patient_merge_requests', 'target_patient_id');
