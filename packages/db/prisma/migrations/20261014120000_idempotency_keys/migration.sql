-- CreateTable
CREATE TABLE "idempotency_keys" (
    "organisation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status_code" INTEGER,
    "response" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("organisation_id","user_id","key")
);

-- CreateIndex
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys"("created_at");

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Keys are opaque client strings; the API also checks the length and characters.
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_key_check
  CHECK (length(key) BETWEEN 8 AND 100);

-- One clinic's keys only. Rows are replaced after 24 hours, never read across clinics.
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO dhc_app;
CREATE POLICY tenant_isolation ON idempotency_keys TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());
