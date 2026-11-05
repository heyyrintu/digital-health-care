ALTER TABLE patients ADD COLUMN portal_closed_at timestamptz(3);
ALTER TABLE otp_challenges DROP CONSTRAINT otp_challenges_purpose_check;
ALTER TABLE otp_challenges ADD CONSTRAINT otp_challenges_purpose_check CHECK(purpose IN ('sign_in','phone_change','account_close'));
CREATE TABLE patient_account_access(organisation_id uuid NOT NULL REFERENCES organisations(id),user_id uuid NOT NULL REFERENCES users(id),closed_at timestamptz(3),PRIMARY KEY(organisation_id,user_id));
INSERT INTO patient_account_access(organisation_id,user_id) SELECT organisation_id,user_id FROM memberships WHERE role='patient' ON CONFLICT DO NOTHING;
ALTER TABLE patient_account_access ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON patient_account_access TO dhc_auth;
GRANT SELECT,UPDATE ON patient_account_access TO dhc_app;
CREATE POLICY auth_read ON patient_account_access FOR SELECT TO dhc_auth USING(true);
CREATE POLICY auth_create ON patient_account_access FOR INSERT TO dhc_auth WITH CHECK(closed_at IS NULL);
CREATE POLICY tenant_isolation ON patient_account_access TO dhc_app USING(organisation_id=app_current_organisation_id()) WITH CHECK(organisation_id=app_current_organisation_id());
CREATE FUNCTION patient_account_close_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.organisation_id,NEW.user_id) IS DISTINCT FROM (OLD.organisation_id,OLD.user_id) OR (OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at) THEN RAISE EXCEPTION 'Patient account closure cannot be reversed'; END IF;RETURN NEW;END $$;
CREATE TRIGGER patient_account_close_guard BEFORE UPDATE ON patient_account_access FOR EACH ROW EXECUTE FUNCTION patient_account_close_guard();
CREATE TABLE data_rights_requests(id uuid PRIMARY KEY,organisation_id uuid NOT NULL REFERENCES organisations(id),user_id uuid NOT NULL REFERENCES users(id),patient_id uuid REFERENCES patients(id),kind text NOT NULL CHECK(kind IN ('correction','erasure','export','account_closure')),area text NOT NULL CHECK(area IN ('profile','clinical','financial','account')),details_cipher text NOT NULL,state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','in_review','fulfilled','declined','retained','withdrawn','processing','failed')),assigned_doctor_id uuid REFERENCES users(id),response_cipher text,policy_reference text,review_after date,evidence_id uuid,revision integer NOT NULL DEFAULT 1,created_at timestamptz(3) NOT NULL,updated_at timestamptz(3) NOT NULL);
CREATE INDEX data_rights_requests_organisation_id_state_created_at_idx ON data_rights_requests(organisation_id,state,created_at);
CREATE TABLE data_rights_events(id uuid PRIMARY KEY,organisation_id uuid NOT NULL REFERENCES organisations(id),request_id uuid NOT NULL REFERENCES data_rights_requests(id),actor_user_id uuid NOT NULL REFERENCES users(id),action text NOT NULL,at timestamptz(3) NOT NULL);
CREATE INDEX data_rights_events_request_id_at_idx ON data_rights_events(request_id,at);
CREATE TABLE rights_file_deletions(id uuid PRIMARY KEY,organisation_id uuid NOT NULL REFERENCES organisations(id),file_key text NOT NULL UNIQUE,next_at timestamptz(3) NOT NULL,done_at timestamptz(3));
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['data_rights_requests','data_rights_events','rights_file_deletions'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO dhc_app',t);EXECUTE format('CREATE POLICY tenant_isolation ON %I TO dhc_app USING(organisation_id=app_current_organisation_id()) WITH CHECK(organisation_id=app_current_organisation_id())',t);END LOOP;END $$;
CREATE TABLE account_closure_attempts(id uuid PRIMARY KEY,organisation_id uuid NOT NULL REFERENCES organisations(id),user_id uuid NOT NULL REFERENCES users(id),challenge_id uuid UNIQUE REFERENCES otp_challenges(id),created_at timestamptz(3) NOT NULL,expires_at timestamptz(3) NOT NULL,confirmed_at timestamptz(3));
CREATE INDEX account_closure_attempts_user_id_created_at_idx ON account_closure_attempts(user_id,created_at);
ALTER TABLE account_closure_attempts ENABLE ROW LEVEL SECURITY;GRANT SELECT,INSERT,UPDATE ON account_closure_attempts TO dhc_auth;
CREATE POLICY auth_access ON account_closure_attempts TO dhc_auth USING(true) WITH CHECK(true);
CREATE FUNCTION rights_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR TG_TABLE_NAME='data_rights_events' THEN RAISE EXCEPTION 'Data rights history is append-only';END IF;
 IF (NEW.id,NEW.organisation_id,NEW.user_id,NEW.patient_id,NEW.kind,NEW.area,NEW.details_cipher,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.organisation_id,OLD.user_id,OLD.patient_id,OLD.kind,OLD.area,OLD.details_cipher,OLD.created_at) THEN RAISE EXCEPTION 'Data rights request identity is immutable';END IF;
 IF OLD.state IN ('fulfilled','declined','retained','withdrawn') THEN RAISE EXCEPTION 'Data rights decision is final';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER rights_history_guard BEFORE UPDATE OR DELETE ON data_rights_requests FOR EACH ROW EXECUTE FUNCTION rights_history_guard();
CREATE TRIGGER rights_events_guard BEFORE UPDATE OR DELETE ON data_rights_events FOR EACH ROW EXECUTE FUNCTION rights_history_guard();
CREATE FUNCTION rights_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='data_rights_requests' THEN
  IF NEW.patient_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM patients WHERE id=NEW.patient_id AND organisation_id=NEW.organisation_id) THEN RAISE EXCEPTION 'Rights subject must belong to clinic'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM data_rights_requests WHERE id=NEW.request_id AND organisation_id=NEW.organisation_id) THEN RAISE EXCEPTION 'Rights event must belong to request clinic'; END IF;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER rights_scope_guard BEFORE INSERT ON data_rights_requests FOR EACH ROW EXECUTE FUNCTION rights_scope_guard();
CREATE TRIGGER rights_event_scope_guard BEFORE INSERT ON data_rights_events FOR EACH ROW EXECUTE FUNCTION rights_scope_guard();
