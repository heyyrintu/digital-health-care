-- CreateTable
CREATE TABLE "account_consents" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "accepted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_at" TIMESTAMPTZ(3),

    CONSTRAINT "account_consents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_consents_organisation_id_user_id_kind_idx" ON "account_consents"("organisation_id", "user_id", "kind");

-- AddForeignKey
ALTER TABLE "account_consents" ADD CONSTRAINT "account_consents_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE account_consents ADD CONSTRAINT account_consents_kind_check
  CHECK (kind IN ('privacy_notice', 'terms', 'health_data'));
ALTER TABLE account_consents ADD CONSTRAINT account_consents_withdrawn_check
  CHECK (withdrawn_at IS NULL OR withdrawn_at >= accepted_at);

-- One acceptance in force per account, consent and version, even if two taps race.
CREATE UNIQUE INDEX account_consents_in_force_key
  ON account_consents (organisation_id, user_id, kind, version)
  WHERE withdrawn_at IS NULL;

-- Consent records are evidence: never deleted, and only the withdrawal time may change.
ALTER TABLE account_consents ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON account_consents TO dhc_app;
GRANT UPDATE (withdrawn_at) ON account_consents TO dhc_app;
CREATE POLICY tenant_isolation ON account_consents TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());
