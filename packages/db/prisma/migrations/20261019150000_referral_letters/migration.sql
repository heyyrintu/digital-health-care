-- Referrals (PRD §7.2), slice 2: the signed referral letter PDF. The referring doctor signs
-- it with the signing PIN while the referral is not closed (one letter per referral); it
-- is rendered from a versioned template, stored by key with its SHA-256 and signature
-- (ADR 0008), and checked by anyone holding it at /verify/referral/<code>. A letter never
-- changes and is never deleted; closing the referral leaves it valid. Sending it to the
-- patient or the receiving doctor is not built yet.

-- CreateTable
CREATE TABLE "referral_letters" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "referral_id" UUID NOT NULL,
    "signed_by_user_id" UUID NOT NULL,
    "language" "Language" NOT NULL,
    "paper_size" "PaperSize" NOT NULL,
    "template_version" TEXT NOT NULL,
    "pdf_file_key" TEXT NOT NULL,
    "pdf_sha256" TEXT NOT NULL,
    "signature_method" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "signer_certificate" TEXT NOT NULL,
    "verification_code" TEXT NOT NULL,
    "signed_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_letters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_letter_verifications" (
    "code_hash" TEXT NOT NULL,
    "organisation_id" UUID NOT NULL,
    "referral_letter_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_letter_verifications_pkey" PRIMARY KEY ("code_hash")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_letters_referral_id_key" ON "referral_letters"("referral_id");

-- CreateIndex
CREATE UNIQUE INDEX "referral_letters_verification_code_key" ON "referral_letters"("verification_code");

-- CreateIndex
CREATE UNIQUE INDEX "referral_letter_verifications_referral_letter_id_key" ON "referral_letter_verifications"("referral_letter_id");

-- AddForeignKey
ALTER TABLE "referral_letters" ADD CONSTRAINT "referral_letters_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_letters" ADD CONSTRAINT "referral_letters_referral_id_fkey" FOREIGN KEY ("referral_id") REFERENCES "referrals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_letter_verifications" ADD CONSTRAINT "referral_letter_verifications_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_letter_verifications" ADD CONSTRAINT "referral_letter_verifications_referral_letter_id_fkey" FOREIGN KEY ("referral_letter_id") REFERENCES "referral_letters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Guard rails the API also checks ------------------------------------------------------
-- A letter carries everything that proves it: the stored PDF and its hash, the template
-- it was rendered with, the signature and its method, and the code in its QR (Crockford
-- base32, 24 characters, as for prescriptions).
ALTER TABLE referral_letters ADD CONSTRAINT referral_letters_fields_check
  CHECK (
    pdf_sha256 ~ '^[0-9a-f]{64}$'
    AND length(pdf_file_key) BETWEEN 1 AND 300
    AND template_version ~ '^referral-[0-9]+$'
    AND signature_method IN ('test_key', 'cloud_dsc')
    AND length(signature) >= 1
    AND length(signer_certificate) >= 1
    AND verification_code ~ '^[0-9A-HJKMNP-TV-Z]{24}$'
  );
-- SHA-256, base64url without padding.
ALTER TABLE referral_letter_verifications ADD CONSTRAINT referral_letter_verifications_hash_check
  CHECK (code_hash ~ '^[A-Za-z0-9_-]{43}$');

-- Row-level security (ADR 0014). Insert-only: no UPDATE or DELETE grant, and the triggers
-- below refuse both to every role.
ALTER TABLE referral_letters ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON referral_letters TO dhc_app;
CREATE POLICY tenant_isolation ON referral_letters TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());

-- The QR lookup: written when a letter is signed, read without a session by the sign-in
-- role (as for prescriptions). It holds a hash of the code and the IDs, nothing clinical.
ALTER TABLE referral_letter_verifications ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON referral_letter_verifications TO dhc_app;
CREATE POLICY tenant_isolation ON referral_letter_verifications TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());
GRANT SELECT ON referral_letter_verifications TO dhc_auth;
CREATE POLICY auth_lookup ON referral_letter_verifications FOR SELECT TO dhc_auth USING (true);

-- A letter belongs to a referral of its organisation, is signed by that referral's
-- referring doctor, and only while the referral is not closed. The referral is locked FOR
-- SHARE until the transaction ends, so a concurrent close waits (and the API locks it FOR
-- UPDATE first). Tables are schema-qualified with a fixed search_path so a temporary table
-- cannot stand in.
CREATE FUNCTION referral_letters_same_tenant() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  ref_status text;
  ref_doctor uuid;
BEGIN
  SELECT r.status::text, r.referring_doctor_user_id INTO ref_status, ref_doctor
  FROM public.referrals r
  WHERE r.id = NEW.referral_id AND r.organisation_id = NEW.organisation_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'referral letter does not match its referral' USING ERRCODE = '23514';
  END IF;
  IF ref_doctor <> NEW.signed_by_user_id THEN
    RAISE EXCEPTION 'only the referring doctor signs the referral letter'
      USING ERRCODE = '23514';
  END IF;
  IF ref_status = 'closed' THEN
    RAISE EXCEPTION 'a closed referral cannot be given a letter' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER referral_letters_same_tenant
  BEFORE INSERT ON referral_letters
  FOR EACH ROW EXECUTE FUNCTION referral_letters_same_tenant();

CREATE FUNCTION referral_letter_verifications_same_tenant() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.referral_letters l
    WHERE l.id = NEW.referral_letter_id AND l.organisation_id = NEW.organisation_id
  ) THEN
    RAISE EXCEPTION 'verification does not match its referral letter' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER referral_letter_verifications_same_tenant
  BEFORE INSERT ON referral_letter_verifications
  FOR EACH ROW EXECUTE FUNCTION referral_letter_verifications_same_tenant();

-- A signed letter and its lookup never change and are never deleted, by any role.
CREATE FUNCTION referral_letters_immutable() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'a signed referral letter cannot change' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER referral_letters_immutable
  BEFORE UPDATE OR DELETE ON referral_letters
  FOR EACH ROW EXECUTE FUNCTION referral_letters_immutable();
CREATE TRIGGER referral_letter_verifications_immutable
  BEFORE UPDATE OR DELETE ON referral_letter_verifications
  FOR EACH ROW EXECUTE FUNCTION referral_letters_immutable();

-- Only these triggers use the functions; no role may call or attach them elsewhere.
REVOKE EXECUTE ON FUNCTION referral_letters_same_tenant() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION referral_letter_verifications_same_tenant() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION referral_letters_immutable() FROM PUBLIC;
