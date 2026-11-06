CREATE TABLE staff_contact_changes (
 id uuid PRIMARY KEY, organisation_id uuid NOT NULL REFERENCES organisations(id), user_id uuid NOT NULL REFERENCES users(id), actor_user_id uuid NOT NULL REFERENCES users(id),
 field text NOT NULL CHECK (field IN ('email','phone')), encrypted_value text NOT NULL, version text NOT NULL, code_hash text NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5), created_at timestamptz(3) NOT NULL, expires_at timestamptz(3) NOT NULL,
 delivered_at timestamptz(3), consumed_at timestamptz(3), cancelled_at timestamptz(3)
);
CREATE INDEX staff_contact_changes_subject_idx ON staff_contact_changes(organisation_id,user_id,created_at);
ALTER TABLE staff_contact_changes ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON staff_contact_changes TO dhc_auth;
CREATE POLICY auth_staff_contact ON staff_contact_changes TO dhc_auth USING (true) WITH CHECK (true);
