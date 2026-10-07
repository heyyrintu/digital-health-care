-- CreateTable
CREATE TABLE "display_screens" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "clinic_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "display_screens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "display_screens_token_hash_key" ON "display_screens"("token_hash");

-- CreateIndex
CREATE INDEX "display_screens_organisation_id_idx" ON "display_screens"("organisation_id");

-- AddForeignKey
ALTER TABLE "display_screens" ADD CONSTRAINT "display_screens_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "display_screens" ADD CONSTRAINT "display_screens_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Row-level security (ADR 0014). Clinic admins manage screens in their organisation;
-- screens are revoked, never deleted.
ALTER TABLE display_screens ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON display_screens TO dhc_app;
CREATE POLICY tenant_isolation ON display_screens TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

-- The public display endpoint finds a screen by its token hash before it knows the
-- organisation (like staff invites); it then reads the queue as that organisation.
GRANT SELECT ON display_screens TO dhc_auth;
CREATE POLICY auth_lookup ON display_screens FOR SELECT TO dhc_auth USING (true);
