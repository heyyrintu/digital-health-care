CREATE TABLE online_visit_settings(organisation_id uuid PRIMARY KEY REFERENCES organisations(id),version integer NOT NULL DEFAULT 1 CHECK(version>0),enabled boolean NOT NULL DEFAULT false);
CREATE TABLE online_visits(appointment_id uuid PRIMARY KEY REFERENCES appointments(id),organisation_id uuid NOT NULL REFERENCES organisations(id),version integer NOT NULL DEFAULT 1 CHECK(version>0),state_cipher text NOT NULL);
CREATE TABLE online_visit_events(id uuid PRIMARY KEY,organisation_id uuid NOT NULL REFERENCES organisations(id),appointment_id uuid NOT NULL REFERENCES appointments(id),version integer NOT NULL CHECK(version>0),actor_user_id uuid NOT NULL REFERENCES users(id),action text NOT NULL CHECK(action IN('intake','withdraw','call','verify')),state_cipher text NOT NULL,created_at timestamptz(3) NOT NULL DEFAULT now(),UNIQUE(appointment_id,version));
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['online_visit_settings','online_visits','online_visit_events'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('GRANT SELECT,INSERT ON %I TO dhc_app',t);
 EXECUTE format('CREATE POLICY tenant_isolation ON %I TO dhc_app USING(organisation_id=app_current_organisation_id()) WITH CHECK(organisation_id=app_current_organisation_id())',t);
END LOOP;END $$;
GRANT UPDATE ON online_visits,online_visit_settings TO dhc_app;
CREATE FUNCTION online_visit_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (TG_TABLE_NAME='online_visit_events' AND TG_OP='UPDATE') THEN RAISE EXCEPTION 'Online history is retained';END IF;
 IF TG_TABLE_NAME='online_visit_settings' THEN
  IF TG_OP='UPDATE' AND (NEW.organisation_id<>OLD.organisation_id OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'Invalid settings revision';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM appointments WHERE id=NEW.appointment_id AND organisation_id=NEW.organisation_id) THEN RAISE EXCEPTION 'Wrong clinic visit';END IF;
  IF TG_TABLE_NAME='online_visits' AND TG_OP='UPDATE' AND ((NEW.appointment_id,NEW.organisation_id) IS DISTINCT FROM (OLD.appointment_id,OLD.organisation_id) OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'Invalid online revision';END IF;
  IF TG_TABLE_NAME='online_visit_events' AND NOT EXISTS(SELECT 1 FROM online_visits WHERE appointment_id=NEW.appointment_id AND organisation_id=NEW.organisation_id AND version=NEW.version AND state_cipher=NEW.state_cipher) THEN RAISE EXCEPTION 'Invalid event snapshot';END IF;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER online_visit_guard BEFORE INSERT OR UPDATE OR DELETE ON online_visits FOR EACH ROW EXECUTE FUNCTION online_visit_guard();
CREATE TRIGGER online_visit_guard BEFORE INSERT OR UPDATE OR DELETE ON online_visit_events FOR EACH ROW EXECUTE FUNCTION online_visit_guard();
CREATE TRIGGER online_visit_guard BEFORE INSERT OR UPDATE OR DELETE ON online_visit_settings FOR EACH ROW EXECUTE FUNCTION online_visit_guard();
