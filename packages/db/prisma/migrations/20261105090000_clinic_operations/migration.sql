ALTER TABLE appointments ADD COLUMN delay_minutes integer NOT NULL DEFAULT 0 CHECK(delay_minutes BETWEEN 0 AND 240),ADD COLUMN delay_updated_at timestamptz(3);
CREATE TABLE clinic_operations(id uuid PRIMARY KEY,organisation_id uuid NOT NULL REFERENCES organisations(id),created_by_user_id uuid NOT NULL REFERENCES users(id),doctor_id uuid NOT NULL REFERENCES users(id),kind text NOT NULL CHECK(kind IN ('cancel','reschedule','delay')),state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','applied')),revision integer NOT NULL DEFAULT 1,request_hash text NOT NULL,snapshot_hash text NOT NULL,plan_cipher text NOT NULL,result_cipher text,created_at timestamptz(3) NOT NULL,expires_at timestamptz(3) NOT NULL,applied_at timestamptz(3));
CREATE INDEX clinic_operations_organisation_id_created_at_idx ON clinic_operations(organisation_id,created_at);
CREATE TABLE clinic_operational_updates(id uuid PRIMARY KEY,organisation_id uuid NOT NULL REFERENCES organisations(id),operation_id uuid NOT NULL REFERENCES clinic_operations(id),appointment_id uuid NOT NULL REFERENCES appointments(id),replacement_id uuid REFERENCES appointments(id),kind text NOT NULL CHECK(kind IN ('cancel','reschedule','delay')),delay_minutes integer NOT NULL DEFAULT 0 CHECK(delay_minutes BETWEEN 0 AND 240),created_at timestamptz(3) NOT NULL,UNIQUE(operation_id,appointment_id));
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['clinic_operations','clinic_operational_updates'] LOOP EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO dhc_app',t);EXECUTE format('CREATE POLICY tenant_isolation ON %I TO dhc_app USING(organisation_id=app_current_organisation_id()) WITH CHECK(organisation_id=app_current_organisation_id())',t);END LOOP;END $$;
CREATE FUNCTION clinic_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Clinic operation history is retained';END IF;
 IF TG_TABLE_NAME='clinic_operations' THEN
  IF TG_OP='INSERT' THEN IF NOT EXISTS(SELECT 1 FROM memberships WHERE organisation_id=NEW.organisation_id AND user_id=NEW.doctor_id AND role='doctor') THEN RAISE EXCEPTION 'Operation doctor belongs to another clinic';END IF;
  ELSE
   IF OLD.state='applied' OR (NEW.id,NEW.organisation_id,NEW.created_by_user_id,NEW.doctor_id,NEW.kind,NEW.request_hash,NEW.snapshot_hash,NEW.plan_cipher,NEW.created_at,NEW.expires_at) IS DISTINCT FROM (OLD.id,OLD.organisation_id,OLD.created_by_user_id,OLD.doctor_id,OLD.kind,OLD.request_hash,OLD.snapshot_hash,OLD.plan_cipher,OLD.created_at,OLD.expires_at) THEN RAISE EXCEPTION 'Operation plan and applied history are immutable';END IF;
  END IF;
 ELSE
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Operational updates are append-only';END IF;
  IF NOT EXISTS(SELECT 1 FROM clinic_operations WHERE id=NEW.operation_id AND organisation_id=NEW.organisation_id AND kind=NEW.kind) OR NOT EXISTS(SELECT 1 FROM appointments WHERE id=NEW.appointment_id AND organisation_id=NEW.organisation_id) THEN RAISE EXCEPTION 'Operational source belongs to another clinic';END IF;
  IF NEW.replacement_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM appointments WHERE id=NEW.replacement_id AND organisation_id=NEW.organisation_id AND rescheduled_from_id=NEW.appointment_id) THEN RAISE EXCEPTION 'Invalid replacement appointment';END IF;
 END IF;RETURN NEW;END $$;
CREATE TRIGGER clinic_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON clinic_operations FOR EACH ROW EXECUTE FUNCTION clinic_operation_guard();
CREATE TRIGGER clinic_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON clinic_operational_updates FOR EACH ROW EXECUTE FUNCTION clinic_operation_guard();
ALTER TABLE whatsapp_deliveries ADD COLUMN operational_update_id uuid REFERENCES clinic_operational_updates(id);
CREATE UNIQUE INDEX whatsapp_operational_update_key ON whatsapp_deliveries(operational_update_id,sender_phone_number_id);
DO $$ DECLARE expr text;BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO expr FROM pg_constraint WHERE conrelid='whatsapp_deliveries'::regclass AND conname='whatsapp_delivery_kind_check';
 ALTER TABLE whatsapp_deliveries DROP CONSTRAINT whatsapp_delivery_kind_check;
 EXECUTE 'ALTER TABLE whatsapp_deliveries ADD CONSTRAINT whatsapp_delivery_kind_check CHECK ((operational_update_id IS NULL AND ('||expr||')) OR (kind=''appointment_update'' AND operational_update_id IS NOT NULL AND otp_challenge_id IS NULL AND appointment_id IS NULL AND recipient_patient_id IS NOT NULL AND opt_in_id IS NOT NULL AND opt_in_version IS NOT NULL AND appointment_start_at IS NOT NULL AND due_at IS NOT NULL AND expires_at IS NOT NULL AND prescription_id IS NULL AND referral_letter_id IS NULL AND patient_document_id IS NULL AND financial_order_id IS NULL AND receipt_payment_id IS NULL AND refund_entry_id IS NULL))';
END $$;
CREATE FUNCTION enqueue_clinic_operation_notice(p_update uuid,p_sender text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE u public.clinic_operational_updates%ROWTYPE;a public.appointments%ROWTYPE;p public.patients%ROWTYPE;contact text;pref public.whatsapp_opt_ins%ROWTYPE;n integer:=0;
BEGIN
 SELECT * INTO u FROM public.clinic_operational_updates WHERE id=p_update AND organisation_id=public.app_current_organisation_id();IF NOT FOUND THEN RETURN 0;END IF;
 SELECT * INTO a FROM public.appointments WHERE id=u.appointment_id AND organisation_id=u.organisation_id;
 SELECT live.* INTO p FROM public.patients src JOIN public.patients live ON live.id=coalesce(src.merged_into_id,src.id) AND live.organisation_id=src.organisation_id WHERE src.id=a.patient_id AND src.organisation_id=u.organisation_id;
 IF p.id IS NULL OR p.portal_closed_at IS NOT NULL THEN RETURN 0;END IF;
 SELECT coalesce(p.phone,g.phone) INTO contact FROM (SELECT 1) x LEFT JOIN public.patients g ON g.id=p.guardian_patient_id AND g.organisation_id=u.organisation_id AND g.portal_closed_at IS NULL;
 FOR pref IN SELECT * FROM public.whatsapp_opt_ins WHERE organisation_id=u.organisation_id AND phone=contact AND sender_phone_number_id=p_sender AND category='appointments' AND enabled LOOP
  INSERT INTO public.whatsapp_deliveries(id,organisation_id,sender_phone_number_id,kind,appointment_id,recipient_patient_id,opt_in_id,opt_in_version,appointment_start_at,due_at,expires_at,status,last_status_at,created_at,operational_update_id)
  VALUES(gen_random_uuid(),u.organisation_id,p_sender,'appointment_update',NULL,p.id,pref.id,pref.version,a.start_at,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval '1 hour','queued',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,u.id) ON CONFLICT DO NOTHING;
  IF FOUND THEN n:=n+1;END IF;
 END LOOP;RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION enqueue_clinic_operation_notice(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_clinic_operation_notice(uuid,text) TO dhc_app;
CREATE FUNCTION messaging_claim_operational_notices(p_sender text) RETURNS TABLE(id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 UPDATE public.whatsapp_deliveries SET status='uncertain',last_status_at=CURRENT_TIMESTAMP WHERE kind='appointment_update' AND status='sending' AND attempted_at<CURRENT_TIMESTAMP-interval '2 minutes';
 UPDATE public.whatsapp_deliveries SET status='skipped',skip_reason='expired',last_status_at=CURRENT_TIMESTAMP WHERE kind='appointment_update' AND status='queued' AND expires_at<=CURRENT_TIMESTAMP;
 RETURN QUERY UPDATE public.whatsapp_deliveries d SET dispatch_lease_at=CURRENT_TIMESTAMP WHERE d.id IN(SELECT x.id FROM public.whatsapp_deliveries x WHERE x.kind='appointment_update' AND x.sender_phone_number_id=p_sender AND x.status='queued' AND x.expires_at>CURRENT_TIMESTAMP AND (x.dispatch_lease_at IS NULL OR x.dispatch_lease_at<CURRENT_TIMESTAMP-interval '60 seconds') ORDER BY x.created_at LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING d.id;
END $$;
CREATE FUNCTION messaging_begin_operational_notice(p_id uuid,p_sender text) RETURNS TABLE(phone text,kind text,clinic_name text,organisation_slug text,start_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.whatsapp_deliveries%ROWTYPE;u public.clinic_operational_updates%ROWTYPE;a public.appointments%ROWTYPE;p public.patients%ROWTYPE;pref public.whatsapp_opt_ins%ROWTYPE;contact text;label text;slug text;problem text;
BEGIN
 SELECT wd.* INTO d FROM public.whatsapp_deliveries wd WHERE wd.id=p_id AND wd.kind='appointment_update' AND wd.sender_phone_number_id=p_sender;IF NOT FOUND OR d.status<>'queued' THEN RETURN;END IF;
 SELECT * INTO u FROM public.clinic_operational_updates WHERE id=d.operational_update_id;
 SELECT * INTO a FROM public.appointments WHERE id=u.appointment_id FOR SHARE;
 SELECT * INTO p FROM public.patients WHERE id=d.recipient_patient_id AND organisation_id=d.organisation_id AND merged_into_id IS NULL AND portal_closed_at IS NULL FOR SHARE;
 SELECT * INTO pref FROM public.whatsapp_opt_ins WHERE id=d.opt_in_id FOR SHARE;
 SELECT coalesce(p.phone,g.phone) INTO contact FROM (SELECT 1) x LEFT JOIN public.patients g ON g.id=p.guardian_patient_id AND g.organisation_id=d.organisation_id AND g.merged_into_id IS NULL AND g.portal_closed_at IS NULL;
 SELECT * INTO d FROM public.whatsapp_deliveries WHERE id=p_id FOR UPDATE;IF d.status<>'queued' THEN RETURN;END IF;
 SELECT o.slug INTO slug FROM public.organisations o WHERE o.id=d.organisation_id AND o.status='active';SELECT c.name INTO label FROM public.clinics c WHERE c.id=a.clinic_id AND c.organisation_id=d.organisation_id AND c.active;
 problem:=CASE WHEN d.expires_at<=CURRENT_TIMESTAMP THEN 'expired' WHEN slug IS NULL OR label IS NULL THEN 'unavailable'
 WHEN u.organisation_id IS DISTINCT FROM d.organisation_id OR u.appointment_id IS DISTINCT FROM a.id OR NOT EXISTS(SELECT 1 FROM public.clinic_operations op WHERE op.id=u.operation_id AND op.state='applied') THEN 'source_changed'
 WHEN p.id IS NULL OR contact IS DISTINCT FROM pref.phone OR coalesce((SELECT merged_into_id FROM public.patients WHERE id=a.patient_id),a.patient_id) IS DISTINCT FROM p.id THEN 'recipient_changed'
 WHEN NOT coalesce(pref.enabled,false) OR pref.category<>'appointments' OR pref.version<>d.opt_in_version OR pref.sender_phone_number_id<>p_sender OR pref.organisation_id<>d.organisation_id THEN 'consent_changed'
 WHEN u.kind='cancel' AND a.status<>'cancelled' THEN 'source_changed'
 WHEN u.kind='reschedule' AND (a.status<>'rescheduled' OR NOT EXISTS(SELECT 1 FROM public.appointments n WHERE n.id=u.replacement_id AND n.rescheduled_from_id=a.id AND n.status IN('pending','confirmed') AND n.start_at>CURRENT_TIMESTAMP)) THEN 'source_changed'
 WHEN u.kind='delay' AND (a.status NOT IN('pending','confirmed','checked_in') OR a.delay_minutes<>u.delay_minutes OR a.delay_updated_at IS DISTINCT FROM u.created_at OR a.date<>(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date) THEN 'source_changed' ELSE NULL END;
 IF problem IS NOT NULL THEN UPDATE public.whatsapp_deliveries SET status='skipped',skip_reason=problem,last_status_at=CURRENT_TIMESTAMP WHERE id=d.id;RETURN;END IF;
 UPDATE public.whatsapp_deliveries SET status='sending',attempted_at=CURRENT_TIMESTAMP,last_status_at=CURRENT_TIMESTAMP WHERE id=d.id;
 INSERT INTO public.audit_logs(id,organisation_id,action,entity_type,entity_id,metadata) VALUES(gen_random_uuid(),d.organisation_id,'messaging.send_started','whatsapp_delivery',d.id::text,jsonb_build_object('kind',d.kind));
 RETURN QUERY SELECT contact,d.kind,label,slug,a.start_at;
END $$;
CREATE FUNCTION messaging_finish_operational_notice(p_id uuid,p_sender text,p_status text,p_message text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.whatsapp_deliveries%ROWTYPE;BEGIN
 IF p_status NOT IN('accepted','submission_failed','uncertain') THEN RAISE EXCEPTION 'Invalid result';END IF;
 SELECT * INTO d FROM public.whatsapp_deliveries WHERE id=p_id AND sender_phone_number_id=p_sender AND kind='appointment_update' FOR UPDATE;
 IF d.id IS NULL OR d.attempted_at IS NULL THEN RAISE EXCEPTION 'Notice not authorized';END IF;
 IF d.provider_message_id IS NOT NULL AND p_message IS NOT NULL AND d.provider_message_id<>p_message THEN RAISE EXCEPTION 'Message mismatch';END IF;
 UPDATE public.whatsapp_deliveries SET provider_message_id=coalesce(provider_message_id,p_message),status=CASE WHEN status='sending' THEN p_status ELSE status END,last_status_at=CASE WHEN status='sending' THEN CURRENT_TIMESTAMP ELSE last_status_at END WHERE id=d.id;
END $$;
REVOKE EXECUTE ON FUNCTION messaging_claim_operational_notices(text),messaging_begin_operational_notice(uuid,text),messaging_finish_operational_notice(uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION messaging_claim_operational_notices(text),messaging_begin_operational_notice(uuid,text),messaging_finish_operational_notice(uuid,text,text,text) TO dhc_messaging;
