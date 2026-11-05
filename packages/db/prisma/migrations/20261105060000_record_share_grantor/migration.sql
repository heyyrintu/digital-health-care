ALTER TABLE patient_record_shares ADD COLUMN created_by_user_id uuid REFERENCES users(id);
UPDATE patient_record_shares s SET created_by_user_id=r.created_by_user_id FROM patient_records r WHERE r.id=s.record_id;
ALTER TABLE patient_record_shares ALTER COLUMN created_by_user_id SET NOT NULL;
CREATE FUNCTION patient_record_grantor_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN RAISE EXCEPTION 'Record grantor is immutable'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER patient_record_grantor_guard BEFORE UPDATE OF created_by_user_id ON patient_record_shares FOR EACH ROW EXECUTE FUNCTION patient_record_grantor_guard();
