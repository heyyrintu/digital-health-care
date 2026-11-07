CREATE TABLE assessment_forms (
 id uuid PRIMARY KEY, organisation_id uuid NOT NULL REFERENCES organisations(id), created_by_user_id uuid NOT NULL REFERENCES users(id),
 definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'), active boolean NOT NULL DEFAULT true, created_at timestamptz(3) NOT NULL
);
CREATE INDEX assessment_forms_organisation_id_id_idx ON assessment_forms(organisation_id,id);
CREATE TABLE patient_assessments (
 id uuid PRIMARY KEY, organisation_id uuid NOT NULL REFERENCES organisations(id), patient_id uuid NOT NULL REFERENCES patients(id), form_id uuid NOT NULL REFERENCES assessment_forms(id), assigned_by_user_id uuid NOT NULL REFERENCES users(id),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','submitted','cancelled')), result_cipher text, submitted_by_user_id uuid REFERENCES users(id), submitted_at timestamptz(3), created_at timestamptz(3) NOT NULL,
 CONSTRAINT assessment_submission_check CHECK((state='submitted' AND result_cipher IS NOT NULL AND submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL) OR (state<>'submitted' AND result_cipher IS NULL AND submitted_by_user_id IS NULL AND submitted_at IS NULL))
);
CREATE INDEX patient_assessments_organisation_id_patient_id_id_idx ON patient_assessments(organisation_id,patient_id,id);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['assessment_forms','patient_assessments'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO dhc_app',t);
 EXECUTE format('CREATE POLICY tenant_isolation ON %I TO dhc_app USING(organisation_id=app_current_organisation_id()) WITH CHECK(organisation_id=app_current_organisation_id())',t);
 END LOOP; END $$;
CREATE FUNCTION assessment_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Assessment history is retained'; END IF;
 IF TG_TABLE_NAME='assessment_forms' THEN
  IF TG_OP='UPDATE' AND (NEW.id,NEW.organisation_id,NEW.created_by_user_id,NEW.definition,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.organisation_id,OLD.created_by_user_id,OLD.definition,OLD.created_at) THEN RAISE EXCEPTION 'Published assessment forms are immutable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM memberships WHERE organisation_id=NEW.organisation_id AND user_id=NEW.created_by_user_id AND role IN('doctor','clinic_admin')) THEN RAISE EXCEPTION 'Assessment creator belongs to this clinic'; END IF;
 ELSE
  IF TG_OP='INSERT' AND NEW.state<>'pending' THEN RAISE EXCEPTION 'Assign before submitting'; END IF;
  IF TG_OP='UPDATE' AND (OLD.state<>'pending' OR (NEW.id,NEW.organisation_id,NEW.patient_id,NEW.form_id,NEW.assigned_by_user_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.organisation_id,OLD.patient_id,OLD.form_id,OLD.assigned_by_user_id,OLD.created_at)) THEN RAISE EXCEPTION 'Assessment responses and assignments are retained and immutable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM patients WHERE id=NEW.patient_id AND organisation_id=NEW.organisation_id) OR NOT EXISTS(SELECT 1 FROM assessment_forms WHERE id=NEW.form_id AND organisation_id=NEW.organisation_id) OR NOT EXISTS(SELECT 1 FROM memberships WHERE organisation_id=NEW.organisation_id AND user_id=NEW.assigned_by_user_id AND role='doctor') THEN RAISE EXCEPTION 'Assessment references belong to this clinic'; END IF;
  IF NEW.submitted_by_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memberships WHERE organisation_id=NEW.organisation_id AND user_id=NEW.submitted_by_user_id AND role='patient' AND status='active') THEN RAISE EXCEPTION 'Assessment respondent belongs to this clinic'; END IF;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER assessment_history_guard BEFORE INSERT OR UPDATE OR DELETE ON assessment_forms FOR EACH ROW EXECUTE FUNCTION assessment_history_guard();
CREATE TRIGGER assessment_history_guard BEFORE INSERT OR UPDATE OR DELETE ON patient_assessments FOR EACH ROW EXECUTE FUNCTION assessment_history_guard();
