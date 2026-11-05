CREATE TABLE patient_records (
 id uuid PRIMARY KEY, organisation_id uuid NOT NULL REFERENCES organisations(id), patient_id uuid NOT NULL REFERENCES patients(id), created_by_user_id uuid NOT NULL REFERENCES users(id),
 create_hash text NOT NULL, details_cipher text, category text NOT NULL CHECK(category IN ('prescription','lab','imaging','discharge','other')),record_date date,
 appointment_id uuid REFERENCES appointments(id),test_order_id uuid REFERENCES test_orders(id),revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 state text NOT NULL DEFAULT 'awaiting_upload' CHECK(state IN ('awaiting_upload','ready','deleting','deleted')),
 file_key text UNIQUE,media_type text CHECK(media_type IN ('application/pdf','image/jpeg','image/png','image/webp')),size_bytes integer CHECK(size_bytes>0),sha256 text,source_sha256 text,
 created_at timestamptz(3) NOT NULL DEFAULT now(),upload_expires_at timestamptz(3) NOT NULL,
 reviewed_at timestamptz(3),reviewed_by_user_id uuid REFERENCES users(id),used_at timestamptz(3),hidden_at timestamptz(3),
 purge_claim uuid,purge_lease_until timestamptz(3),purge_next_at timestamptz(3),purged_at timestamptz(3),
 CHECK(state <> 'ready' OR (file_key IS NOT NULL AND media_type IS NOT NULL AND size_bytes IS NOT NULL AND sha256 IS NOT NULL AND source_sha256 IS NOT NULL AND details_cipher IS NOT NULL)),
 CHECK(state <> 'deleted' OR (file_key IS NULL AND details_cipher IS NULL AND sha256 IS NULL AND source_sha256 IS NULL AND purged_at IS NOT NULL)),
 CHECK(used_at IS NULL OR state='ready'), CHECK(state NOT IN ('deleting','deleted') OR hidden_at IS NOT NULL),
 CHECK((reviewed_at IS NULL)=(reviewed_by_user_id IS NULL))
);
CREATE INDEX patient_records_organisation_id_patient_id_created_at_idx ON patient_records(organisation_id,patient_id,created_at);
CREATE INDEX patient_records_state_purge_next_at_idx ON patient_records(state,purge_next_at);
CREATE TABLE patient_record_shares (
 id uuid PRIMARY KEY,organisation_id uuid NOT NULL REFERENCES organisations(id),record_id uuid NOT NULL REFERENCES patient_records(id),doctor_user_id uuid NOT NULL REFERENCES users(id),
 token_hash text NOT NULL UNIQUE,token_cipher text,ttl_hours integer NOT NULL CHECK(ttl_hours BETWEEN 1 AND 168),created_at timestamptz(3) NOT NULL,expires_at timestamptz(3) NOT NULL,revoked_at timestamptz(3)
);
CREATE INDEX patient_record_shares_doctor_user_id_expires_at_idx ON patient_record_shares(doctor_user_id,expires_at);
CREATE TABLE patient_record_uses (
 id uuid PRIMARY KEY,organisation_id uuid NOT NULL REFERENCES organisations(id),record_id uuid NOT NULL REFERENCES patient_records(id),appointment_id uuid NOT NULL REFERENCES appointments(id),doctor_user_id uuid NOT NULL REFERENCES users(id),revision integer NOT NULL,used_at timestamptz(3) NOT NULL,
 UNIQUE(record_id,appointment_id)
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['patient_records','patient_record_shares','patient_record_uses'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO dhc_app',t);
 EXECUTE format('CREATE POLICY tenant_isolation ON %I TO dhc_app USING(organisation_id=app_current_organisation_id()) WITH CHECK(organisation_id=app_current_organisation_id())',t);
END LOOP; END $$;
CREATE FUNCTION patient_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Patient record tombstones cannot be deleted'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.organisation_id,NEW.patient_id,NEW.created_by_user_id,NEW.create_hash,NEW.created_at,NEW.upload_expires_at) IS DISTINCT FROM (OLD.id,OLD.organisation_id,OLD.patient_id,OLD.created_by_user_id,OLD.create_hash,OLD.created_at,OLD.upload_expires_at) THEN RAISE EXCEPTION 'Patient record identity is immutable'; END IF;
  IF OLD.used_at IS NOT NULL AND (NEW.details_cipher,NEW.category,NEW.record_date,NEW.appointment_id,NEW.test_order_id,NEW.revision,NEW.file_key,NEW.media_type,NEW.size_bytes,NEW.sha256,NEW.source_sha256,NEW.used_at,NEW.state) IS DISTINCT FROM (OLD.details_cipher,OLD.category,OLD.record_date,OLD.appointment_id,OLD.test_order_id,OLD.revision,OLD.file_key,OLD.media_type,OLD.size_bytes,OLD.sha256,OLD.source_sha256,OLD.used_at,OLD.state) THEN RAISE EXCEPTION 'Used patient records are retained and immutable'; END IF;
  IF OLD.state='deleted' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Deleted record tombstones are immutable'; END IF;
  IF OLD.state='deleting' AND NEW.state NOT IN ('deleting','deleted') THEN RAISE EXCEPTION 'Record deletion cannot be reversed'; END IF;
  IF OLD.state='ready' AND NEW.state='awaiting_upload' THEN RAISE EXCEPTION 'Record files cannot be replaced'; END IF;
  IF OLD.state='ready' AND NEW.state <> 'deleted' AND (NEW.file_key,NEW.sha256,NEW.source_sha256,NEW.media_type,NEW.size_bytes) IS DISTINCT FROM (OLD.file_key,OLD.sha256,OLD.source_sha256,OLD.media_type,OLD.size_bytes) THEN RAISE EXCEPTION 'Record files cannot be replaced'; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM patients p WHERE p.id=NEW.patient_id AND p.organisation_id=NEW.organisation_id) THEN RAISE EXCEPTION 'Record patient belongs to another tenant'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER patient_record_guard BEFORE INSERT OR UPDATE OR DELETE ON patient_records FOR EACH ROW EXECUTE FUNCTION patient_record_guard();
CREATE FUNCTION patient_record_share_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE r patient_records; BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Record share history is retained'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.organisation_id,NEW.record_id,NEW.doctor_user_id,NEW.token_hash,NEW.created_at,NEW.expires_at,NEW.ttl_hours) IS DISTINCT FROM (OLD.id,OLD.organisation_id,OLD.record_id,OLD.doctor_user_id,OLD.token_hash,OLD.created_at,OLD.expires_at,OLD.ttl_hours) OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) OR (NEW.token_cipher IS DISTINCT FROM OLD.token_cipher AND NEW.token_cipher IS NOT NULL) THEN RAISE EXCEPTION 'Record share binding is immutable'; END IF;
 ELSE
  SELECT * INTO r FROM patient_records WHERE id=NEW.record_id FOR UPDATE;
  IF r.id IS NULL OR r.organisation_id<>NEW.organisation_id OR r.state<>'ready' OR r.hidden_at IS NOT NULL THEN RAISE EXCEPTION 'Record cannot be shared'; END IF;
 END IF;
 RETURN NEW; END $$;
CREATE TRIGGER patient_record_share_guard BEFORE INSERT OR UPDATE OR DELETE ON patient_record_shares FOR EACH ROW EXECUTE FUNCTION patient_record_share_guard();
CREATE FUNCTION patient_record_use_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE r patient_records; a appointments; rp uuid; ap uuid; BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Record use is append-only'; END IF;
 SELECT * INTO r FROM patient_records WHERE id=NEW.record_id FOR UPDATE;
 SELECT * INTO a FROM appointments WHERE id=NEW.appointment_id FOR SHARE;
 SELECT COALESCE(merged_into_id,id) INTO rp FROM patients WHERE id=r.patient_id;
 SELECT COALESCE(merged_into_id,id) INTO ap FROM patients WHERE id=a.patient_id;
 IF r.id IS NULL OR a.id IS NULL OR r.organisation_id<>NEW.organisation_id OR a.organisation_id<>NEW.organisation_id OR r.state<>'ready' OR (r.hidden_at IS NOT NULL AND r.used_at IS NULL) OR r.revision<>NEW.revision OR rp<>ap OR a.doctor_user_id<>NEW.doctor_user_id OR a.status NOT IN ('checked_in','in_consultation','completed') THEN RAISE EXCEPTION 'Record use requires the treating visit'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER patient_record_use_guard BEFORE INSERT OR UPDATE OR DELETE ON patient_record_uses FOR EACH ROW EXECUTE FUNCTION patient_record_use_guard();
CREATE FUNCTION patient_record_used_stamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 UPDATE patient_records SET used_at=COALESCE(used_at,NEW.used_at) WHERE id=NEW.record_id;
 RETURN NEW; END $$;
CREATE TRIGGER patient_record_used_stamp AFTER INSERT ON patient_record_uses FOR EACH ROW EXECUTE FUNCTION patient_record_used_stamp();
CREATE FUNCTION patient_record_links_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE p uuid; linked uuid; o test_orders; BEGIN
 SELECT COALESCE(merged_into_id,id) INTO p FROM patients WHERE id=NEW.patient_id AND organisation_id=NEW.organisation_id;
 IF NEW.appointment_id IS NOT NULL THEN
  SELECT COALESCE(q.merged_into_id,q.id) INTO linked FROM appointments a JOIN patients q ON q.id=a.patient_id WHERE a.id=NEW.appointment_id AND a.organisation_id=NEW.organisation_id;
  IF linked IS NULL OR linked<>p THEN RAISE EXCEPTION 'Record appointment belongs to another patient'; END IF;
 END IF;
 IF NEW.test_order_id IS NOT NULL THEN
  SELECT * INTO o FROM test_orders WHERE id=NEW.test_order_id AND organisation_id=NEW.organisation_id;
  SELECT COALESCE(merged_into_id,id) INTO linked FROM patients WHERE id=o.patient_id;
  IF o.id IS NULL OR linked<>p OR (NEW.appointment_id IS NOT NULL AND NEW.appointment_id<>o.appointment_id) THEN RAISE EXCEPTION 'Record order belongs to another patient or visit'; END IF;
 END IF;
 RETURN NEW; END $$;
CREATE TRIGGER patient_record_links_guard BEFORE INSERT OR UPDATE OF appointment_id,test_order_id,patient_id,organisation_id ON patient_records FOR EACH ROW EXECUTE FUNCTION patient_record_links_guard();
