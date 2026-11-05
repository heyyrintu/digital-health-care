ALTER TABLE whatsapp_opt_ins ADD COLUMN category text NOT NULL DEFAULT 'appointments'
  CHECK (category IN ('appointments', 'records'));
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.whatsapp_opt_ins'::regclass AND contype = 'u' LOOP
    EXECUTE format('ALTER TABLE public.whatsapp_opt_ins DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE whatsapp_opt_ins ADD CONSTRAINT whatsapp_opt_in_category_key
  UNIQUE(organisation_id, phone, sender_phone_number_id, category);
ALTER TABLE whatsapp_deliveries
  ADD COLUMN prescription_id uuid REFERENCES prescriptions(id) ON DELETE RESTRICT,
  ADD COLUMN referral_letter_id uuid REFERENCES referral_letters(id) ON DELETE RESTRICT,
  ADD COLUMN patient_document_id uuid REFERENCES patient_documents(id) ON DELETE RESTRICT,
  ADD COLUMN link_expires_at timestamptz(3);
CREATE UNIQUE INDEX whatsapp_prescription_notice_key ON whatsapp_deliveries(prescription_id, sender_phone_number_id);
CREATE UNIQUE INDEX whatsapp_referral_notice_key ON whatsapp_deliveries(referral_letter_id, sender_phone_number_id);
CREATE UNIQUE INDEX whatsapp_document_notice_key ON whatsapp_deliveries(patient_document_id, sender_phone_number_id);
ALTER TABLE whatsapp_deliveries DROP CONSTRAINT whatsapp_delivery_kind_check;
ALTER TABLE whatsapp_deliveries ADD CONSTRAINT whatsapp_delivery_kind_check CHECK (
  (kind = 'otp' AND otp_challenge_id IS NOT NULL AND appointment_id IS NULL AND opt_in_id IS NULL
    AND prescription_id IS NULL AND referral_letter_id IS NULL AND patient_document_id IS NULL)
  OR (kind IN ('appointment_confirmation','appointment_reminder') AND otp_challenge_id IS NULL
    AND appointment_id IS NOT NULL AND recipient_patient_id IS NOT NULL AND opt_in_id IS NOT NULL
    AND opt_in_version IS NOT NULL AND appointment_start_at IS NOT NULL AND due_at IS NOT NULL AND expires_at IS NOT NULL
    AND prescription_id IS NULL AND referral_letter_id IS NULL AND patient_document_id IS NULL)
  OR (kind IN ('prescription_ready','referral_ready','document_ready') AND otp_challenge_id IS NULL
    AND appointment_id IS NULL AND recipient_patient_id IS NOT NULL AND opt_in_id IS NOT NULL
    AND opt_in_version IS NOT NULL AND due_at IS NOT NULL AND expires_at IS NOT NULL
    AND ((kind = 'prescription_ready' AND prescription_id IS NOT NULL AND referral_letter_id IS NULL AND patient_document_id IS NULL)
      OR (kind = 'referral_ready' AND referral_letter_id IS NOT NULL AND prescription_id IS NULL AND patient_document_id IS NULL)
      OR (kind = 'document_ready' AND patient_document_id IS NOT NULL AND prescription_id IS NULL AND referral_letter_id IS NULL)))
);

CREATE FUNCTION enqueue_whatsapp_record(p_kind text, p_id uuid, p_org uuid, p_patient uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE pref public.whatsapp_opt_ins%ROWTYPE; contact text;
BEGIN
  IF p_kind NOT IN ('prescription_ready','referral_ready','document_ready') THEN RETURN; END IF;
  SELECT phone INTO contact FROM public.patients WHERE id = p_patient
    AND organisation_id = p_org AND merged_into_id IS NULL;
  FOR pref IN SELECT * FROM public.whatsapp_opt_ins WHERE organisation_id = p_org
    AND phone = contact AND enabled AND category = 'records'
  LOOP
    INSERT INTO public.whatsapp_deliveries(id, organisation_id, sender_phone_number_id, kind,
      recipient_patient_id, opt_in_id, opt_in_version, prescription_id, referral_letter_id, patient_document_id,
      due_at, expires_at, status, last_status_at, created_at)
    VALUES(gen_random_uuid(), p_org, pref.sender_phone_number_id, p_kind, p_patient, pref.id, pref.version,
      CASE WHEN p_kind = 'prescription_ready' THEN p_id END,
      CASE WHEN p_kind = 'referral_ready' THEN p_id END,
      CASE WHEN p_kind = 'document_ready' THEN p_id END,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + interval '24 hours', 'queued', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION enqueue_whatsapp_record(text, uuid, uuid, uuid) FROM PUBLIC;

CREATE FUNCTION whatsapp_prescription_notice() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status <> 'signed' OR NEW.superseded_at IS NOT NULL OR NEW.voided_at IS NOT NULL THEN
    UPDATE public.whatsapp_deliveries SET status = 'skipped', skip_reason = 'record_changed',
      last_status_at = CURRENT_TIMESTAMP WHERE prescription_id = NEW.id AND status = 'queued';
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM public.enqueue_whatsapp_record('prescription_ready', NEW.id, NEW.organisation_id, NEW.patient_id);
  ELSIF OLD.status <> 'signed' THEN
    PERFORM public.enqueue_whatsapp_record('prescription_ready', NEW.id, NEW.organisation_id, NEW.patient_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER whatsapp_prescription_notice AFTER INSERT OR UPDATE OF status, superseded_at, voided_at ON prescriptions
  FOR EACH ROW EXECUTE FUNCTION whatsapp_prescription_notice();

CREATE FUNCTION whatsapp_referral_notice() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE patient uuid;
BEGIN
  SELECT patient_id INTO patient FROM public.referrals WHERE id = NEW.referral_id AND organisation_id = NEW.organisation_id;
  IF patient IS NOT NULL THEN
    PERFORM public.enqueue_whatsapp_record('referral_ready', NEW.id, NEW.organisation_id, patient);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER whatsapp_referral_notice AFTER INSERT ON referral_letters
  FOR EACH ROW EXECUTE FUNCTION whatsapp_referral_notice();

CREATE FUNCTION whatsapp_document_notice() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.withdrawn_at IS NOT NULL THEN
    UPDATE public.whatsapp_deliveries SET status = 'skipped', skip_reason = 'record_changed',
      last_status_at = CURRENT_TIMESTAMP WHERE patient_document_id = NEW.id AND status = 'queued';
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM public.enqueue_whatsapp_record('document_ready', NEW.id, NEW.organisation_id, NEW.patient_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER whatsapp_document_notice AFTER INSERT OR UPDATE OF withdrawn_at ON patient_documents
  FOR EACH ROW EXECUTE FUNCTION whatsapp_document_notice();
REVOKE EXECUTE ON FUNCTION whatsapp_prescription_notice() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION whatsapp_referral_notice() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION whatsapp_document_notice() FROM PUBLIC;

CREATE FUNCTION messaging_claim_record_notices(p_sender text) RETURNS TABLE(id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.whatsapp_deliveries SET status = 'skipped', skip_reason = 'expired', last_status_at = CURRENT_TIMESTAMP
    WHERE whatsapp_deliveries.id IN (SELECT d.id FROM public.whatsapp_deliveries d
      WHERE d.status = 'queued' AND d.expires_at <= CURRENT_TIMESTAMP
      ORDER BY d.expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED);
  UPDATE public.whatsapp_deliveries SET status = 'uncertain', last_status_at = CURRENT_TIMESTAMP
    WHERE status = 'sending' AND attempted_at < CURRENT_TIMESTAMP - interval '2 minutes';
  RETURN QUERY UPDATE public.whatsapp_deliveries d SET dispatch_lease_at = CURRENT_TIMESTAMP
    WHERE d.id IN (SELECT n.id FROM public.whatsapp_deliveries n WHERE n.sender_phone_number_id = p_sender
      AND n.kind IN ('prescription_ready','referral_ready','document_ready') AND n.status = 'queued'
      AND n.due_at <= CURRENT_TIMESTAMP AND n.expires_at > CURRENT_TIMESTAMP
      AND (n.dispatch_lease_at IS NULL OR n.dispatch_lease_at < CURRENT_TIMESTAMP - interval '60 seconds')
      ORDER BY n.dispatch_lease_at NULLS FIRST, n.due_at, n.id LIMIT 100 FOR UPDATE SKIP LOCKED)
    RETURNING d.id;
END $$;

CREATE FUNCTION messaging_begin_record_notice(p_id uuid, p_sender text)
RETURNS TABLE(phone text, organisation_slug text, link_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.whatsapp_deliveries%ROWTYPE; pref public.whatsapp_opt_ins%ROWTYPE;
  contact text; slug text; source_patient uuid; valid boolean := false; problem text;
BEGIN
  SELECT * INTO d FROM public.whatsapp_deliveries WHERE id = p_id;
  IF NOT FOUND OR d.kind NOT IN ('prescription_ready','referral_ready','document_ready')
    OR d.sender_phone_number_id <> p_sender OR d.status <> 'queued' OR d.due_at > CURRENT_TIMESTAMP THEN RETURN; END IF;
  SELECT * INTO pref FROM public.whatsapp_opt_ins WHERE id = d.opt_in_id FOR SHARE;
  SELECT * INTO d FROM public.whatsapp_deliveries WHERE id = p_id FOR UPDATE;
  IF d.status <> 'queued' THEN RETURN; END IF;
  IF d.kind = 'prescription_ready' THEN
    SELECT r.patient_id, r.status = 'signed' AND r.superseded_at IS NULL AND r.voided_at IS NULL
      INTO source_patient, valid FROM public.prescriptions r WHERE r.id = d.prescription_id AND r.organisation_id = d.organisation_id;
  ELSIF d.kind = 'referral_ready' THEN
    SELECT r.patient_id, true INTO source_patient, valid FROM public.referral_letters l
      JOIN public.referrals r ON r.id = l.referral_id AND r.organisation_id = l.organisation_id
      WHERE l.id = d.referral_letter_id AND l.organisation_id = d.organisation_id;
  ELSE
    SELECT r.patient_id, r.withdrawn_at IS NULL INTO source_patient, valid FROM public.patient_documents r
      WHERE r.id = d.patient_document_id AND r.organisation_id = d.organisation_id;
  END IF;
  SELECT p.phone INTO contact FROM public.patients p WHERE p.id = d.recipient_patient_id
    AND p.organisation_id = d.organisation_id AND p.merged_into_id IS NULL FOR SHARE;
  SELECT o.slug INTO slug FROM public.organisations o WHERE o.id = d.organisation_id AND o.status = 'active';
  problem := CASE
    WHEN d.expires_at <= CURRENT_TIMESTAMP THEN 'expired'
    WHEN slug IS NULL OR NOT coalesce(valid, false) OR source_patient IS DISTINCT FROM d.recipient_patient_id THEN 'record_changed'
    WHEN contact IS NULL OR contact <> pref.phone THEN 'recipient_changed'
    WHEN NOT pref.enabled OR pref.category <> 'records' OR pref.version <> d.opt_in_version
      OR pref.organisation_id <> d.organisation_id OR pref.sender_phone_number_id <> p_sender THEN 'consent_changed'
    ELSE NULL END;
  IF problem IS NOT NULL THEN
    UPDATE public.whatsapp_deliveries SET status = 'skipped', skip_reason = problem, last_status_at = CURRENT_TIMESTAMP WHERE id = d.id;
    RETURN;
  END IF;
  UPDATE public.whatsapp_deliveries SET status = 'sending', attempted_at = CURRENT_TIMESTAMP,
    last_status_at = CURRENT_TIMESTAMP, link_expires_at = CURRENT_TIMESTAMP + interval '1 hour' WHERE id = d.id;
  INSERT INTO public.audit_logs(id, organisation_id, action, entity_type, entity_id, metadata)
    VALUES(gen_random_uuid(), d.organisation_id, 'messaging.send_started', 'whatsapp_delivery', d.id::text, jsonb_build_object('kind', d.kind));
  RETURN QUERY SELECT contact, slug, l.link_expires_at FROM public.whatsapp_deliveries l WHERE l.id = d.id;
END $$;

CREATE FUNCTION messaging_finish_record_notice(p_id uuid, p_sender text, p_status text, p_message text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.whatsapp_deliveries%ROWTYPE;
BEGIN
  IF p_status NOT IN ('accepted','submission_failed','uncertain') THEN RAISE EXCEPTION 'invalid send result' USING ERRCODE = '23514'; END IF;
  SELECT * INTO STRICT d FROM public.whatsapp_deliveries WHERE id = p_id AND sender_phone_number_id = p_sender FOR UPDATE;
  IF d.kind NOT IN ('prescription_ready','referral_ready','document_ready') OR d.attempted_at IS NULL THEN
    RAISE EXCEPTION 'record notice has not started' USING ERRCODE = '23514'; END IF;
  IF p_message IS NOT NULL AND d.provider_message_id IS NOT NULL AND d.provider_message_id <> p_message THEN
    RAISE EXCEPTION 'WhatsApp message does not match' USING ERRCODE = '23514'; END IF;
  UPDATE public.whatsapp_deliveries SET provider_message_id = coalesce(provider_message_id, p_message),
    status = CASE WHEN status = 'sending' THEN p_status ELSE status END,
    last_status_at = CASE WHEN status = 'sending' THEN CURRENT_TIMESTAMP ELSE last_status_at END WHERE id = d.id;
  INSERT INTO public.audit_logs(id, organisation_id, action, entity_type, entity_id, metadata)
    VALUES(gen_random_uuid(), d.organisation_id, 'messaging.send_finished', 'whatsapp_delivery', d.id::text, jsonb_build_object('result', p_status));
END $$;
REVOKE EXECUTE ON FUNCTION messaging_claim_record_notices(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION messaging_begin_record_notice(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION messaging_finish_record_notice(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION messaging_claim_record_notices(text), messaging_begin_record_notice(uuid, text),
  messaging_finish_record_notice(uuid, text, text, text) TO dhc_messaging;

-- Keep existing appointment capabilities confined to their consent category.
CREATE OR REPLACE FUNCTION whatsapp_opt_in_checks() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.organisation_id, NEW.phone, NEW.sender_phone_number_id, NEW.category)
     IS DISTINCT FROM (OLD.id, OLD.organisation_id, OLD.phone, OLD.sender_phone_number_id, OLD.category)
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'consent identity is immutable and revisions increase once' USING ERRCODE = '23514';
  END IF;
  UPDATE public.whatsapp_deliveries SET status = 'skipped', skip_reason = 'consent_changed',
    last_status_at = CURRENT_TIMESTAMP
  WHERE opt_in_id = OLD.id AND status = 'queued';
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION enqueue_whatsapp_appointment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
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
    WHERE organisation_id = NEW.organisation_id AND phone = contact AND enabled AND category = 'appointments'
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

CREATE OR REPLACE FUNCTION messaging_claim_appointment_notices(p_sender text) RETURNS TABLE(id uuid)
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
    WHERE n.sender_phone_number_id = p_sender AND n.kind IN ('appointment_confirmation','appointment_reminder') AND n.status = 'queued'
      AND n.due_at <= CURRENT_TIMESTAMP AND n.expires_at > CURRENT_TIMESTAMP
      AND (n.dispatch_lease_at IS NULL OR n.dispatch_lease_at < CURRENT_TIMESTAMP - interval '60 seconds')
    ORDER BY n.dispatch_lease_at NULLS FIRST, n.due_at, n.id LIMIT 100 FOR UPDATE SKIP LOCKED)
  RETURNING d.id;
END $$;

CREATE OR REPLACE FUNCTION messaging_begin_appointment_notice(p_id uuid, p_sender text)
RETURNS TABLE(phone text, kind text, clinic_name text, organisation_slug text, start_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.whatsapp_deliveries%ROWTYPE; a public.appointments%ROWTYPE;
  pref public.whatsapp_opt_ins%ROWTYPE; contact text; clinic_label text; slug text; problem text;
BEGIN
  SELECT * INTO d FROM public.whatsapp_deliveries WHERE id = p_id;
  IF NOT FOUND OR d.kind NOT IN ('appointment_confirmation','appointment_reminder') OR d.sender_phone_number_id <> p_sender OR d.status <> 'queued'
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
    WHEN NOT pref.enabled OR pref.category <> 'appointments' OR pref.version <> d.opt_in_version
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

CREATE OR REPLACE FUNCTION messaging_finish_appointment_notice(p_id uuid, p_sender text, p_status text, p_message text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.whatsapp_deliveries%ROWTYPE;
BEGIN
  IF p_status NOT IN ('accepted','submission_failed','uncertain') THEN
    RAISE EXCEPTION 'invalid send result' USING ERRCODE = '23514'; END IF;
  SELECT * INTO STRICT d FROM public.whatsapp_deliveries WHERE id = p_id AND sender_phone_number_id = p_sender FOR UPDATE;
  IF d.kind NOT IN ('appointment_confirmation','appointment_reminder') OR d.attempted_at IS NULL THEN
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
