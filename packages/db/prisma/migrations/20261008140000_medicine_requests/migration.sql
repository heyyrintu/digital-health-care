-- CreateEnum
CREATE TYPE "MedicineDecision" AS ENUM ('approved', 'rejected');

-- CreateTable
CREATE TABLE "medicine_requests" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name_key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "decision" "MedicineDecision" NOT NULL,
    "medicine_id" UUID,
    "reason" TEXT,
    "decided_by_user_id" UUID NOT NULL,
    "decided_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medicine_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "medicine_requests_medicine_id_idx" ON "medicine_requests"("medicine_id");

-- CreateIndex
CREATE UNIQUE INDEX "medicine_requests_organisation_id_name_key_key" ON "medicine_requests"("organisation_id", "name_key");

-- AddForeignKey
ALTER TABLE "medicine_requests" ADD CONSTRAINT "medicine_requests_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medicine_requests" ADD CONSTRAINT "medicine_requests_medicine_id_fkey" FOREIGN KEY ("medicine_id") REFERENCES "medicines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Guard rails. The key is the name in lower case with single spaces; an approval names a
-- medicine and a rejection gives a reason.
ALTER TABLE medicine_requests ADD CONSTRAINT medicine_requests_name_key_check
  CHECK (name_key = lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) AND name_key <> '');
ALTER TABLE medicine_requests ADD CONSTRAINT medicine_requests_decision_check
  CHECK ((decision = 'approved') = (medicine_id IS NOT NULL)
         AND (decision <> 'rejected' OR reason IS NOT NULL));

-- Decisions belong to one clinic; undoing one deletes it (the audit log keeps the history).
ALTER TABLE medicine_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON medicine_requests TO dhc_app;
CREATE POLICY tenant_isolation ON medicine_requests TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

-- An approval points at a medicine this clinic can use: the platform's or its own (the
-- shared check from the same-tenant references migration), and a clinic medicine an
-- approval names keeps its organisation.
CREATE TRIGGER medicine_requests_medicine_same_tenant
  BEFORE INSERT OR UPDATE OF organisation_id, medicine_id ON medicine_requests
  FOR EACH ROW EXECUTE FUNCTION same_tenant_reference('medicines', 'medicine_id', 'shared');
DROP TRIGGER medicines_keep_children ON medicines;
CREATE TRIGGER medicines_keep_children
  BEFORE UPDATE OF organisation_id ON medicines
  FOR EACH ROW EXECUTE FUNCTION same_tenant_keep_children(
    'prescription_items', 'medicine_id', 'medicine_requests', 'medicine_id');
