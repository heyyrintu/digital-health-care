-- CreateTable
CREATE TABLE "organisation_settings" (
    "organisation_id" UUID NOT NULL,
    "chart_model" TEXT NOT NULL DEFAULT 'shared',
    "hidden_safety_rules" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "max_upload_mb" INTEGER NOT NULL DEFAULT 10,
    "upload_types" TEXT[] NOT NULL DEFAULT ARRAY['pdf', 'jpeg', 'png']::TEXT[],
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organisation_settings_pkey" PRIMARY KEY ("organisation_id")
);

-- AddForeignKey
ALTER TABLE "organisation_settings" ADD CONSTRAINT "organisation_settings_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Guard rails the API also checks. Only the catalogue's "Visibility only" rules can be
-- hidden (SR-06, SR-08, SR-15); the locked rules never can. Uploads are capped at 25 MB.
ALTER TABLE organisation_settings ADD CONSTRAINT organisation_settings_chart_model_check
  CHECK (chart_model IN ('shared', 'own_patients'));
ALTER TABLE organisation_settings ADD CONSTRAINT organisation_settings_hidden_rules_check
  CHECK (hidden_safety_rules <@ ARRAY['SR-06', 'SR-08', 'SR-15']::TEXT[]);
ALTER TABLE organisation_settings ADD CONSTRAINT organisation_settings_upload_check
  CHECK (max_upload_mb BETWEEN 1 AND 25
         AND cardinality(upload_types) > 0
         AND upload_types <@ ARRAY['pdf', 'jpeg', 'png', 'heic']::TEXT[]);

ALTER TABLE organisation_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON organisation_settings TO dhc_app;
CREATE POLICY tenant_isolation ON organisation_settings TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());
