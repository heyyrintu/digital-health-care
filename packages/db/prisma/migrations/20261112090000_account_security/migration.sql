ALTER TABLE users ADD COLUMN mfa_mode text, ADD COLUMN auth_version integer NOT NULL DEFAULT 0;
ALTER TABLE platform_operators ADD COLUMN mfa_mode text, ADD COLUMN auth_version integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD CONSTRAINT users_mfa_mode CHECK (mfa_mode IS NULL OR mfa_mode IN ('totp','whatsapp','email','disabled'));
ALTER TABLE platform_operators ADD CONSTRAINT operators_mfa_mode CHECK (mfa_mode IS NULL OR mfa_mode IN ('totp','whatsapp','email','disabled'));
CREATE TABLE account_security_challenges (
 id uuid PRIMARY KEY, audience text NOT NULL CHECK (audience IN ('staff','platform')),
 subject_id uuid NOT NULL, purpose text NOT NULL CHECK (purpose IN ('recovery','mfa_change')),
 binding_hash text NOT NULL, target_mode text CHECK (target_mode IN ('totp','whatsapp','email','disabled')),
 old_code_hash text, new_code_hash text NOT NULL, attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 created_at timestamptz(3) NOT NULL, expires_at timestamptz(3) NOT NULL, delivered_at timestamptz(3), consumed_at timestamptz(3)
);
CREATE INDEX security_expiry ON account_security_challenges(expires_at);
CREATE INDEX security_subject_created ON account_security_challenges(audience,subject_id,created_at);
ALTER TABLE account_security_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_security_challenges FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON account_security_challenges TO dhc_auth, dhc_platform;
CREATE POLICY staff_security ON account_security_challenges TO dhc_auth USING (audience='staff') WITH CHECK (audience='staff');
CREATE POLICY platform_security ON account_security_challenges TO dhc_platform USING (audience='platform') WITH CHECK (audience='platform');

-- Invalidate pending password-step tokens on every credential/contact/security change,
-- including changes made through existing invitation and recovery workflows.
CREATE FUNCTION account_auth_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
 OR NEW.mfa_secret IS DISTINCT FROM OLD.mfa_secret
 OR NEW.email IS DISTINCT FROM OLD.email
 OR NEW.mfa_mode IS DISTINCT FROM OLD.mfa_mode
 OR NEW.status IS DISTINCT FROM OLD.status
 OR (to_jsonb(NEW)->>'phone') IS DISTINCT FROM (to_jsonb(OLD)->>'phone') THEN
   NEW.auth_version := OLD.auth_version + 1;
 ELSE
   NEW.auth_version := OLD.auth_version;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER users_auth_version BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION account_auth_version();
CREATE TRIGGER operators_auth_version BEFORE UPDATE ON platform_operators FOR EACH ROW EXECUTE FUNCTION account_auth_version();

-- Older images do not understand personal methods or credential versions. After an
-- account changes security state, refuse legacy session creation rather than let a
-- rollback silently substitute the old deployment-wide policy.
CREATE FUNCTION require_account_security_protocol() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE changed boolean;
BEGIN
 IF current_user NOT IN ('dhc_auth','dhc_platform') OR current_setting('app.account_security_protocol',true)='1' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='sessions' THEN
   IF NEW.role='patient' THEN RETURN NEW; END IF;
   SELECT auth_version>0 OR mfa_mode IS NOT NULL INTO changed FROM public.users WHERE id=NEW.user_id;
 ELSE
   SELECT auth_version>0 OR mfa_mode IS NOT NULL INTO changed FROM public.platform_operators WHERE id=NEW.operator_id;
 END IF;
 IF changed THEN RAISE EXCEPTION 'Account requires a current authentication service' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sessions_security_protocol BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION require_account_security_protocol();
CREATE TRIGGER platform_sessions_security_protocol BEFORE INSERT ON platform_sessions FOR EACH ROW EXECUTE FUNCTION require_account_security_protocol();
