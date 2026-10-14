-- Live queue (build plan: server-sent events instead of polling). Any change that the
-- queue or the waiting-room screen shows announces which visit changed on the
-- `dhc_queue` channel; the API listens once and tells the open screens to refresh.
-- The payload is IDs and a date only, never patient details.

CREATE FUNCTION notify_queue_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  visit uuid;
  org uuid;
  day date;
BEGIN
  IF TG_TABLE_NAME = 'appointments' THEN
    visit := NEW.id;
    org := NEW.organisation_id;
    day := NEW.date;
  ELSE
    visit := NEW.appointment_id;
    org := NEW.organisation_id;
    SELECT a.date INTO day FROM appointments a WHERE a.id = visit;
  END IF;
  IF day IS NOT NULL THEN
    PERFORM pg_notify(
      'dhc_queue',
      json_build_object('o', org, 'd', to_char(day, 'YYYY-MM-DD'), 'a', visit)::text
    );
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER appointments_notify_queue
  AFTER INSERT OR UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION notify_queue_change();
CREATE TRIGGER vitals_notify_queue
  AFTER INSERT OR UPDATE ON vitals
  FOR EACH ROW EXECUTE FUNCTION notify_queue_change();
CREATE TRIGGER bills_notify_queue
  AFTER INSERT OR UPDATE ON bills
  FOR EACH ROW EXECUTE FUNCTION notify_queue_change();
CREATE TRIGGER prescriptions_notify_queue
  AFTER INSERT OR UPDATE OF status ON prescriptions
  FOR EACH ROW EXECUTE FUNCTION notify_queue_change();
