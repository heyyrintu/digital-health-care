CREATE TABLE mfa_otp_challenges (
 id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE, subject_id uuid NOT NULL,
 audience text NOT NULL CHECK (audience IN ('staff','platform')), binding_hash text NOT NULL,
 code_hash text NOT NULL, attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
 created_at timestamptz(3) NOT NULL, expires_at timestamptz(3) NOT NULL,
 delivered_at timestamptz(3), consumed_at timestamptz(3)
);
CREATE INDEX mfa_otp_subject_created_idx ON mfa_otp_challenges(audience, subject_id, created_at);
-- Authentication-only table, like sessions: never accessible to the tenant application role.
ALTER TABLE mfa_otp_challenges ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON mfa_otp_challenges TO dhc_auth, dhc_platform;
CREATE POLICY auth_mfa ON mfa_otp_challenges TO dhc_auth USING (audience = 'staff') WITH CHECK (audience = 'staff');
CREATE POLICY platform_mfa ON mfa_otp_challenges TO dhc_platform USING (audience = 'platform') WITH CHECK (audience = 'platform');
