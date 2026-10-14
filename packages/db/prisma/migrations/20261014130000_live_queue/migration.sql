-- Live queue (build plan: server-sent events instead of polling). Any change that the
-- queue or the waiting-room screen shows announces which visit changed on the
-- `dhc_queue` channel; the API listens once and tells the open screens to refresh.
-- The payload is IDs and a date only, never patient details: `o` organisation, `c` clinic
-- (so a waiting-room screen hears only its own clinic), `d` day, `a` visit.

CREATE FUNCTION queue_notify(org uuid, clinic uuid, day date, visit uuid) RETURNS void
LANGUAGE sql AS $$
  SELECT pg_notify(
    'dhc_queue',
    json_build_object('o', org, 'c', clinic, 'd', to_char(day, 'YYYY-MM-DD'), 'a', visit)::text
  );
$$;

CREATE FUNCTION notify_queue_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  visit uuid;
  org uuid;
  clinic uuid;
  day date;
BEGIN
  IF TG_TABLE_NAME = 'appointments' THEN
    visit := NEW.id;
    org := NEW.organisation_id;
    clinic := NEW.clinic_id;
    day := NEW.date;
  ELSE
    visit := NEW.appointment_id;
    org := NEW.organisation_id;
    SELECT a.date, a.clinic_id INTO day, clinic FROM appointments a WHERE a.id = visit;
  END IF;
  IF day IS NOT NULL THEN
    PERFORM queue_notify(org, clinic, day, visit);
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

-- The Follow-ups tab lists consultations by the date they asked the patient back, so a
-- new or moved follow-up date announces both days, keyed by the visit it came from.
CREATE FUNCTION notify_follow_up_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  clinic uuid;
BEGIN
  SELECT a.clinic_id INTO clinic FROM appointments a WHERE a.id = NEW.appointment_id;
  IF NEW.follow_up_date IS NOT NULL THEN
    PERFORM queue_notify(NEW.organisation_id, clinic, NEW.follow_up_date, NEW.appointment_id);
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.follow_up_date IS NOT NULL
     AND OLD.follow_up_date IS DISTINCT FROM NEW.follow_up_date THEN
    PERFORM queue_notify(OLD.organisation_id, clinic, OLD.follow_up_date, OLD.appointment_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER consultations_notify_follow_up
  AFTER INSERT OR UPDATE OF follow_up_date ON consultations
  FOR EACH ROW EXECUTE FUNCTION notify_follow_up_change();

-- A priority tag moves a checked-in patient up the queue: tagging or untagging someone
-- announces their open visits.
CREATE FUNCTION notify_patient_tag_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  row_ patient_tags%ROWTYPE;
  visit record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_ := OLD;
  ELSE
    row_ := NEW;
  END IF;
  FOR visit IN
    SELECT a.id, a.clinic_id, a.date FROM appointments a
    WHERE a.patient_id = row_.patient_id
      AND a.organisation_id = row_.organisation_id
      AND a.status IN ('pending', 'confirmed', 'checked_in', 'in_consultation')
  LOOP
    PERFORM queue_notify(row_.organisation_id, visit.clinic_id, visit.date, visit.id);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER patient_tags_notify_queue
  AFTER INSERT OR DELETE ON patient_tags
  FOR EACH ROW EXECUTE FUNCTION notify_patient_tag_change();
