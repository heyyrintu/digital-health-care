ALTER TABLE otp_challenges ADD COLUMN purpose text NOT NULL DEFAULT 'sign_in'
  CHECK (purpose IN ('sign_in','phone_change'));
ALTER TABLE patients ADD COLUMN photo_key text, ADD COLUMN photo_media_type text,
  ADD COLUMN reported_blood_group text CHECK (reported_blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
  ADD COLUMN blood_group_reported_at timestamptz(3), ADD COLUMN blood_group_confirmed_at timestamptz(3),
  ADD CONSTRAINT patient_photo_fields CHECK ((photo_key IS NULL) = (photo_media_type IS NULL));
CREATE TABLE patient_phone_changes (
  id uuid PRIMARY KEY, organisation_id uuid NOT NULL REFERENCES organisations(id),
  user_id uuid NOT NULL REFERENCES users(id), patient_id uuid NOT NULL REFERENCES patients(id),
  old_phone text NOT NULL, new_phone text NOT NULL,
  old_challenge_id uuid UNIQUE REFERENCES otp_challenges(id),
  new_challenge_id uuid UNIQUE REFERENCES otp_challenges(id),
  created_at timestamptz(3) NOT NULL DEFAULT now(), expires_at timestamptz(3) NOT NULL,
  completed_at timestamptz(3),
  CHECK (old_phone <> new_phone AND old_challenge_id <> new_challenge_id)
);
CREATE INDEX patient_phone_changes_user_id_created_at_idx ON patient_phone_changes(user_id, created_at);
ALTER TABLE patient_phone_changes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON patient_phone_changes TO dhc_auth;
CREATE POLICY auth_access ON patient_phone_changes TO dhc_auth USING (true) WITH CHECK (true);
