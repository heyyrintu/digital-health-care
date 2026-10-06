-- CreateTable
CREATE TABLE "staff_invites" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_invites_token_hash_key" ON "staff_invites"("token_hash");

-- CreateIndex
CREATE INDEX "staff_invites_organisation_id_created_at_idx" ON "staff_invites"("organisation_id", "created_at");

-- AddForeignKey
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Row-level security (ADR 0014) ----------------------------------------------------
ALTER TABLE staff_invites ENABLE ROW LEVEL SECURITY;

-- Clinic admins create, list and revoke invites inside their organisation.
GRANT SELECT, INSERT, UPDATE ON staff_invites TO dhc_app;
CREATE POLICY tenant_isolation ON staff_invites TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

-- The sign-in role looks invites up by token hash and may only mark an open invite accepted.
GRANT SELECT, UPDATE ON staff_invites TO dhc_auth;
CREATE POLICY auth_lookup ON staff_invites FOR SELECT TO dhc_auth USING (true);
CREATE POLICY auth_accept ON staff_invites FOR UPDATE TO dhc_auth
  USING (accepted_at IS NULL AND revoked_at IS NULL)
  WITH CHECK (accepted_at IS NOT NULL);

-- Completing an invite activates its membership; the sign-in role can do nothing else to
-- memberships beyond creating patient ones.
GRANT UPDATE ON memberships TO dhc_auth;
CREATE POLICY auth_activate_invited ON memberships FOR UPDATE TO dhc_auth
  USING (status = 'invited')
  WITH CHECK (status = 'active');
