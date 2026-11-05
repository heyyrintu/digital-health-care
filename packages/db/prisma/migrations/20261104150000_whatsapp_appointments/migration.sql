CREATE TABLE whatsapp_opt_ins (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  phone text NOT NULL CHECK (phone ~ '^\+91[6-9][0-9]{9}$'),
  sender_phone_number_id text NOT NULL CHECK (sender_phone_number_id ~ '^[0-9]+$'),
  enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  changed_at timestamptz(3) NOT NULL,
  changed_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  UNIQUE(organisation_id, phone, sender_phone_number_id)
);
CREATE INDEX whatsapp_opt_ins_phone_sender_phone_number_id_idx ON whatsapp_opt_ins(phone, sender_phone_number_id);
ALTER TABLE whatsapp_opt_ins ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON whatsapp_opt_ins TO dhc_app;
CREATE POLICY tenant_isolation ON whatsapp_opt_ins TO dhc_app
  USING (organisation_id = app_current_organisation_id())
  WITH CHECK (organisation_id = app_current_organisation_id());
CREATE TABLE whatsapp_opt_out_events (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  received_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE whatsapp_opt_out_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON whatsapp_opt_out_events FROM PUBLIC, dhc_app, dhc_auth, dhc_messaging;

ALTER TABLE whatsapp_deliveries ALTER COLUMN otp_challenge_id DROP NOT NULL;
ALTER TABLE whatsapp_deliveries ADD COLUMN kind text NOT NULL DEFAULT 'otp',
  ADD COLUMN appointment_id uuid REFERENCES appointments(id) ON DELETE RESTRICT,
  ADD COLUMN recipient_patient_id uuid REFERENCES patients(id) ON DELETE RESTRICT,
  ADD COLUMN opt_in_id uuid REFERENCES whatsapp_opt_ins(id) ON DELETE RESTRICT,
  ADD COLUMN opt_in_version integer,
  ADD COLUMN appointment_start_at timestamptz(3), ADD COLUMN due_at timestamptz(3),
  ADD COLUMN expires_at timestamptz(3), ADD COLUMN dispatch_lease_at timestamptz(3),
  ADD COLUMN attempted_at timestamptz(3), ADD COLUMN skip_reason text;
ALTER TABLE whatsapp_deliveries DROP CONSTRAINT whatsapp_deliveries_status_check;
ALTER TABLE whatsapp_deliveries ADD CONSTRAINT whatsapp_deliveries_status_check
  CHECK (status IN ('pending','accepted','submission_failed','sent','delivered','read','failed',
    'queued','sending','skipped','uncertain'));
ALTER TABLE whatsapp_deliveries ADD CONSTRAINT whatsapp_delivery_kind_check CHECK (
  (kind = 'otp' AND otp_challenge_id IS NOT NULL AND appointment_id IS NULL AND opt_in_id IS NULL)
  OR (kind IN ('appointment_confirmation','appointment_reminder') AND otp_challenge_id IS NULL
    AND appointment_id IS NOT NULL AND recipient_patient_id IS NOT NULL AND opt_in_id IS NOT NULL
    AND opt_in_version IS NOT NULL AND appointment_start_at IS NOT NULL
    AND due_at IS NOT NULL AND expires_at IS NOT NULL)
);
CREATE UNIQUE INDEX whatsapp_appointment_notice_key
  ON whatsapp_deliveries(appointment_id, kind, appointment_start_at, sender_phone_number_id);
CREATE INDEX whatsapp_deliveries_sender_phone_number_id_status_due_at_idx
  ON whatsapp_deliveries(sender_phone_number_id, status, due_at);

-- Consent identity is immutable; a revision invalidates every unsent old-revision notice.
CREATE FUNCTION whatsapp_opt_in_checks() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.organisation_id, NEW.phone, NEW.sender_phone_number_id)
     IS DISTINCT FROM (OLD.id, OLD.organisation_id, OLD.phone, OLD.sender_phone_number_id)
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'consent identity is immutable and revisions increase once' USING ERRCODE = '23514';
  END IF;
  UPDATE public.whatsapp_deliveries SET status = 'skipped', skip_reason = 'consent_changed',
    last_status_at = CURRENT_TIMESTAMP
  WHERE opt_in_id = OLD.id AND status = 'queued';
  RETURN NEW;
END $$;
CREATE TRIGGER whatsapp_opt_in_checks BEFORE UPDATE ON whatsapp_opt_ins
  FOR EACH ROW EXECUTE FUNCTION whatsapp_opt_in_checks();
REVOKE EXECUTE ON FUNCTION whatsapp_opt_in_checks() FROM PUBLIC;

-- A database outbox makes booking + notification intent one transaction, including all
-- staff/patient booking paths, confirmations and replacement bookings after rescheduling.
CREATE FUNCTION enqueue_whatsapp_appointment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE pref public.whatsapp_opt_ins%ROWTYPE; contact text; at timestamptz := CURRENT_TIMESTAMP;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status <> 'confirmed' OR NEW.start_at IS DISTINCT FROM OLD.start_at
      OR NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
      UPDATE public.whatsapp_deliveries SET status = 'skipped', skip_reason = 'appointment_changed',
        last_status_at = CURRENT_TIMESTAMP WHERE appointment_id = NEW.id AND status = 'queued';
    END IF;
  END IF;
  IF NEW.status <> 'confirmed' OR NEW.start_at <= at THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'confirmed' THEN RETURN NEW; END IF;
  END IF;
  SELECT phone INTO contact FROM public.patients
    WHERE id = NEW.patient_id AND organisation_id = NEW.organisation_id AND merged_into_id IS NULL;
  FOR pref IN SELECT * FROM public.whatsapp_opt_ins
    WHERE organisation_id = NEW.organisation_id AND phone = contact AND enabled
  LOOP
    INSERT INTO public.whatsapp_deliveries(id, organisation_id, sender_phone_number_id, kind,
      appointment_id, recipient_patient_id, opt_in_id, opt_in_version, appointment_start_at,
      due_at, expires_at, status, last_status_at, created_at)
    VALUES(gen_random_uuid(), NEW.organisation_id, pref.sender_phone_number_id, 'appointment_confirmation',
      NEW.id, NEW.patient_id, pref.id, pref.version, NEW.start_at, at,
      least(at + interval '15 minutes', NEW.start_at), 'queued', at, at)
    ON CONFLICT (appointment_id, kind, appointment_start_at, sender_phone_number_id) DO NOTHING;
    IF NEW.start_at - interval '24 hours' > at THEN
      INSERT INTO public.whatsapp_deliveries(id, organisation_id, sender_phone_number_id, kind,
        appointment_id, recipient_patient_id, opt_in_id, opt_in_version, appointment_start_at,
        due_at, expires_at, status, last_status_at, created_at)
      VALUES(gen_random_uuid(), NEW.organisation_id, pref.sender_phone_number_id, 'appointment_reminder',
        NEW.id, NEW.patient_id, pref.id, pref.version, NEW.start_at,
        NEW.start_at - interval '24 hours', NEW.start_at - interval '24 hours' + interval '15 minutes',
        'queued', at, at)
      ON CONFLICT (appointment_id, kind, appointment_start_at, sender_phone_number_id) DO NOTHING;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER enqueue_whatsapp_appointment AFTER INSERT OR UPDATE OF status, start_at, patient_id ON appointments
  FOR EACH ROW EXECUTE FUNCTION enqueue_whatsapp_appointment();
REVOKE EXECUTE ON FUNCTION enqueue_whatsapp_appointment() FROM PUBLIC;

CREATE FUNCTION messaging_claim_appointment_notices(p_sender text) RETURNS TABLE(id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.whatsapp_deliveries SET status = 'skipped', skip_reason = 'expired',
    last_status_at = CURRENT_TIMESTAMP
  WHERE whatsapp_deliveries.id IN (SELECT d.id FROM public.whatsapp_deliveries d
    WHERE d.status = 'queued' AND d.expires_at <= CURRENT_TIMESTAMP
    ORDER BY d.expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED);
  -- After a process crash it is unknown whether Meta received the request. Never resend.
  UPDATE public.whatsapp_deliveries SET status = 'uncertain', last_status_at = CURRENT_TIMESTAMP
  WHERE status = 'sending' AND attempted_at < CURRENT_TIMESTAMP - interval '2 minutes';
  RETURN QUERY UPDATE public.whatsapp_deliveries d SET dispatch_lease_at = CURRENT_TIMESTAMP
  WHERE d.id IN (SELECT n.id FROM public.whatsapp_deliveries n
    WHERE n.sender_phone_number_id = p_sender AND n.status = 'queued'
      AND n.due_at <= CURRENT_TIMESTAMP AND n.expires_at > CURRENT_TIMESTAMP
      AND (n.dispatch_lease_at IS NULL OR n.dispatch_lease_at < CURRENT_TIMESTAMP - interval '60 seconds')
    ORDER BY n.dispatch_lease_at NULLS FIRST, n.due_at, n.id LIMIT 100 FOR UPDATE SKIP LOCKED)
  RETURNING d.id;
END $$;

-- The only worker read of recipient/contact data, available once for a valid due notice.
-- No clinical notes, patient name, diagnosis or document data is returned.
CREATE FUNCTION messaging_begin_appointment_notice(p_id uuid, p_sender text)
RETURNS TABLE(phone text, kind text, clinic_name text, organisation_slug text, start_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.whatsapp_deliveries%ROWTYPE; a public.appointments%ROWTYPE;
  pref public.whatsapp_opt_ins%ROWTYPE; contact text; clinic_label text; slug text; problem text;
BEGIN
  SELECT * INTO d FROM public.whatsapp_deliveries WHERE id = p_id;
  IF NOT FOUND OR d.kind = 'otp' OR d.sender_phone_number_id <> p_sender OR d.status <> 'queued'
    OR d.due_at > CURRENT_TIMESTAMP THEN RETURN; END IF;
  SELECT * INTO a FROM public.appointments WHERE id = d.appointment_id FOR SHARE;
  SELECT * INTO pref FROM public.whatsapp_opt_ins WHERE id = d.opt_in_id FOR SHARE;
  SELECT * INTO d FROM public.whatsapp_deliveries WHERE id = p_id FOR UPDATE;
  IF d.status <> 'queued' THEN RETURN; END IF;
  SELECT p.phone INTO contact FROM public.patients p
    WHERE p.id = d.recipient_patient_id AND p.organisation_id = d.organisation_id
      AND p.merged_into_id IS NULL FOR SHARE;
  SELECT o.slug INTO slug FROM public.organisations o WHERE o.id = d.organisation_id AND o.status = 'active';
  SELECT c.name INTO clinic_label FROM public.clinics c WHERE c.id = a.clinic_id AND c.organisation_id = d.organisation_id AND c.active;
  problem := CASE
    WHEN d.expires_at <= CURRENT_TIMESTAMP THEN 'expired'
    WHEN slug IS NULL OR clinic_label IS NULL
      OR NOT EXISTS (SELECT 1 FROM public.users u JOIN public.memberships m ON m.user_id = u.id
        WHERE u.id = a.doctor_user_id AND u.status = 'active' AND m.organisation_id = d.organisation_id
          AND m.role = 'doctor' AND m.status = 'active')
      OR NOT EXISTS (SELECT 1 FROM public.consultation_types t
        WHERE t.id = a.consultation_type_id AND t.organisation_id = d.organisation_id AND t.active)
      THEN 'unavailable'
    WHEN a.status <> 'confirmed' OR a.start_at <> d.appointment_start_at
      OR a.patient_id <> d.recipient_patient_id OR a.organisation_id <> d.organisation_id
      OR a.start_at <= CURRENT_TIMESTAMP THEN 'appointment_changed'
    WHEN contact IS NULL OR contact <> pref.phone THEN 'recipient_changed'
    WHEN NOT pref.enabled OR pref.version <> d.opt_in_version
      OR pref.organisation_id <> d.organisation_id OR pref.sender_phone_number_id <> p_sender THEN 'consent_changed'
    ELSE NULL END;
  IF problem IS NOT NULL THEN
    UPDATE public.whatsapp_deliveries SET status = 'skipped', skip_reason = problem,
      last_status_at = CURRENT_TIMESTAMP WHERE id = d.id;
    RETURN;
  END IF;
  UPDATE public.whatsapp_deliveries SET status = 'sending', attempted_at = CURRENT_TIMESTAMP,
    last_status_at = CURRENT_TIMESTAMP WHERE id = d.id;
  INSERT INTO public.audit_logs(id, organisation_id, action, entity_type, entity_id, metadata)
    VALUES(gen_random_uuid(), d.organisation_id, 'messaging.send_started', 'whatsapp_delivery', d.id::text,
      jsonb_build_object('kind', d.kind));
  RETURN QUERY SELECT contact, d.kind, clinic_label, slug, a.start_at;
END $$;

CREATE FUNCTION messaging_finish_appointment_notice(p_id uuid, p_sender text, p_status text, p_message text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.whatsapp_deliveries%ROWTYPE;
BEGIN
  IF p_status NOT IN ('accepted','submission_failed','uncertain') THEN
    RAISE EXCEPTION 'invalid send result' USING ERRCODE = '23514'; END IF;
  SELECT * INTO STRICT d FROM public.whatsapp_deliveries WHERE id = p_id AND sender_phone_number_id = p_sender FOR UPDATE;
  IF d.kind = 'otp' OR d.attempted_at IS NULL THEN
    RAISE EXCEPTION 'notice has not started' USING ERRCODE = '23514'; END IF;
  IF p_message IS NOT NULL AND d.provider_message_id IS NOT NULL AND d.provider_message_id <> p_message THEN
    RAISE EXCEPTION 'WhatsApp message does not match' USING ERRCODE = '23514'; END IF;
  UPDATE public.whatsapp_deliveries SET provider_message_id = coalesce(provider_message_id, p_message),
    status = CASE WHEN status = 'sending' THEN p_status ELSE status END,
    last_status_at = CASE WHEN status = 'sending' THEN CURRENT_TIMESTAMP ELSE last_status_at END
  WHERE id = d.id;
  INSERT INTO public.audit_logs(id, organisation_id, action, entity_type, entity_id, metadata)
    VALUES(gen_random_uuid(), d.organisation_id, 'messaging.send_finished', 'whatsapp_delivery', d.id::text,
      jsonb_build_object('result', p_status));
END $$;

-- Inbound STOP IDs are hashed by the verified callback receiver. Only current grants
-- at or before that STOP are revoked, across organisations sharing this sending number.
CREATE FUNCTION messaging_opt_out_phone(p_event text, p_sender text, p_phone text, p_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE pref public.whatsapp_opt_ins%ROWTYPE;
BEGIN
  IF p_phone !~ '^\+91[6-9][0-9]{9}$' THEN RETURN; END IF;
  INSERT INTO public.whatsapp_opt_out_events(id) VALUES(p_event) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN; END IF;
  FOR pref IN UPDATE public.whatsapp_opt_ins SET enabled = false, version = version + 1,
    changed_at = CURRENT_TIMESTAMP, changed_by_user_id = NULL
    WHERE phone = p_phone AND sender_phone_number_id = p_sender AND enabled
      AND p_at >= date_trunc('second', changed_at) RETURNING *
  LOOP
    INSERT INTO public.audit_logs(id, organisation_id, action, entity_type, entity_id, metadata)
      VALUES(gen_random_uuid(), pref.organisation_id, 'messaging.preference_changed', 'whatsapp_opt_in',
        pref.id::text, jsonb_build_object('enabled', false, 'source', 'whatsapp_stop'));
  END LOOP;
END $$;

REVOKE EXECUTE ON FUNCTION messaging_claim_appointment_notices(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION messaging_begin_appointment_notice(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION messaging_finish_appointment_notice(uuid, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION messaging_opt_out_phone(text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION messaging_claim_appointment_notices(text),
  messaging_begin_appointment_notice(uuid, text), messaging_finish_appointment_notice(uuid, text, text, text),
  messaging_opt_out_phone(text, text, text, timestamptz) TO dhc_messaging;

CREATE OR REPLACE FUNCTION messaging_process_status(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE e public.whatsapp_status_events%ROWTYPE; d public.whatsapp_deliveries%ROWTYPE;
  apply boolean := false;
BEGIN
  SELECT * INTO e FROM public.whatsapp_status_events WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR e.processed_at IS NOT NULL THEN RETURN; END IF;
  SELECT * INTO STRICT d FROM public.whatsapp_deliveries WHERE id = e.delivery_id FOR UPDATE;
  -- Stronger successful states win even when callbacks arrive out of order. Failed never
  -- overwrites delivered/read. A stale failure cannot overwrite a later sent event.
  apply := CASE e.status
    WHEN 'read' THEN d.status <> 'read'
    WHEN 'delivered' THEN d.status NOT IN ('delivered', 'read')
    WHEN 'sent' THEN d.status IN ('pending', 'accepted', 'submission_failed', 'sending', 'uncertain')
    WHEN 'failed' THEN d.status IN ('pending', 'accepted', 'submission_failed', 'sending', 'uncertain')
      OR (d.status IN ('sent', 'failed') AND e.occurred_at >= d.last_status_at)
    ELSE false END;
  IF apply THEN
    UPDATE public.whatsapp_deliveries SET status = e.status, last_status_at = e.occurred_at,
      error_code = CASE WHEN e.status = 'failed' THEN e.error_code ELSE NULL END WHERE id = d.id;
    INSERT INTO public.audit_logs(id, organisation_id, action, entity_type, entity_id, metadata)
    VALUES(gen_random_uuid(), d.organisation_id, 'messaging.status_updated', 'whatsapp_delivery',
      d.id::text, jsonb_build_object('status', e.status));
  END IF;
  UPDATE public.whatsapp_status_events SET processed_at = CURRENT_TIMESTAMP WHERE id = p_id;
END $$;
