CREATE TABLE patient_import_jobs(id uuid PRIMARY KEY,organisation_id uuid NOT NULL REFERENCES organisations(id),created_by_user_id uuid NOT NULL REFERENCES users(id),source text NOT NULL,input_hash text NOT NULL,payload_cipher text NOT NULL,result_cipher text,status text NOT NULL DEFAULT 'preview' CHECK(status IN('preview','applied','cancelled')),created_at timestamptz(3) NOT NULL DEFAULT now(),expires_at timestamptz(3) NOT NULL,applied_at timestamptz(3),CHECK(expires_at>created_at),CHECK((status='applied')=(applied_at IS NOT NULL AND result_cipher IS NOT NULL)));
CREATE INDEX patient_import_jobs_organisation_id_created_at_idx ON patient_import_jobs(organisation_id,created_at);
CREATE TABLE patient_import_records(id uuid PRIMARY KEY,organisation_id uuid NOT NULL REFERENCES organisations(id),job_id uuid NOT NULL REFERENCES patient_import_jobs(id),source text NOT NULL,external_id text NOT NULL,row_hash text NOT NULL,patient_id uuid NOT NULL REFERENCES patients(id),UNIQUE(organisation_id,source,external_id));
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['patient_import_jobs','patient_import_records'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dhc_app',t);
 EXECUTE format('CREATE POLICY tenant_isolation ON %I TO dhc_app USING(organisation_id=app_current_organisation_id()) WITH CHECK(organisation_id=app_current_organisation_id())',t);
END LOOP;END $$;
GRANT UPDATE ON patient_import_jobs TO dhc_app;
CREATE FUNCTION patient_import_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Import history is retained'; END IF;
 IF TG_TABLE_NAME='patient_import_jobs' THEN
  IF NOT EXISTS(SELECT 1 FROM memberships WHERE organisation_id=NEW.organisation_id AND user_id=NEW.created_by_user_id AND role='clinic_admin') THEN RAISE EXCEPTION 'Invalid import creator'; END IF;
  IF TG_OP='INSERT' AND (NEW.status<>'preview' OR NEW.result_cipher IS NOT NULL OR NEW.applied_at IS NOT NULL) THEN RAISE EXCEPTION 'Import must start with preview';END IF;
  IF TG_OP='UPDATE' AND (OLD.status<>'preview' OR NEW.status NOT IN('applied','cancelled') OR (NEW.id,NEW.organisation_id,NEW.created_by_user_id,NEW.source,NEW.input_hash,NEW.payload_cipher,NEW.created_at,NEW.expires_at) IS DISTINCT FROM (OLD.id,OLD.organisation_id,OLD.created_by_user_id,OLD.source,OLD.input_hash,OLD.payload_cipher,OLD.created_at,OLD.expires_at)) THEN RAISE EXCEPTION 'Import history is immutable';END IF;
 ELSE
  IF TG_OP='UPDATE' OR NOT EXISTS(SELECT 1 FROM patient_import_jobs WHERE id=NEW.job_id AND organisation_id=NEW.organisation_id AND source=NEW.source AND status='preview') OR NOT EXISTS(SELECT 1 FROM patients WHERE id=NEW.patient_id AND organisation_id=NEW.organisation_id) THEN RAISE EXCEPTION 'Invalid import provenance';END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER patient_import_guard BEFORE INSERT OR UPDATE OR DELETE ON patient_import_jobs FOR EACH ROW EXECUTE FUNCTION patient_import_guard();
CREATE TRIGGER patient_import_guard BEFORE INSERT OR UPDATE OR DELETE ON patient_import_records FOR EACH ROW EXECUTE FUNCTION patient_import_guard();
