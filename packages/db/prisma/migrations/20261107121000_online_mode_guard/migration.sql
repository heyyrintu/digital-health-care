-- A used type's mode is clinical history; never rewrite it or bypass online readiness.
CREATE FUNCTION appointment_mode_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_mode "ConsultationMode"; next_mode "ConsultationMode";
BEGIN
 IF TG_TABLE_NAME='consultation_types' THEN
  IF NEW.mode IS DISTINCT FROM OLD.mode AND EXISTS(SELECT 1 FROM appointments WHERE consultation_type_id=OLD.id AND organisation_id=OLD.organisation_id) THEN RAISE EXCEPTION 'Used consultation mode is immutable';END IF;
 ELSE
  SELECT mode INTO next_mode FROM consultation_types WHERE id=NEW.consultation_type_id AND organisation_id=NEW.organisation_id FOR SHARE;
  IF TG_OP='UPDATE' AND NEW.consultation_type_id IS DISTINCT FROM OLD.consultation_type_id THEN
   SELECT mode INTO previous_mode FROM consultation_types WHERE id=OLD.consultation_type_id AND organisation_id=OLD.organisation_id;
   IF next_mode IS DISTINCT FROM previous_mode THEN RAISE EXCEPTION 'Appointment mode is immutable; create a new booking';END IF;
  END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER appointment_mode_history_guard BEFORE UPDATE OF mode ON consultation_types FOR EACH ROW EXECUTE FUNCTION appointment_mode_history_guard();
CREATE TRIGGER appointment_mode_history_guard BEFORE INSERT OR UPDATE OF consultation_type_id ON appointments FOR EACH ROW EXECUTE FUNCTION appointment_mode_history_guard();
