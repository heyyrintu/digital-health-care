CREATE TABLE review_settings(organisation_id uuid PRIMARY KEY REFERENCES organisations(id),version integer NOT NULL DEFAULT 1 CHECK(version>0),enabled boolean NOT NULL DEFAULT false,google_url text,cooldown_days integer NOT NULL DEFAULT 90 CHECK(cooldown_days BETWEEN 30 AND 365),CHECK(NOT enabled OR google_url IS NOT NULL));
CREATE TABLE review_requests(id uuid PRIMARY KEY,organisation_id uuid NOT NULL REFERENCES organisations(id),appointment_id uuid NOT NULL UNIQUE REFERENCES appointments(id),patient_id uuid NOT NULL REFERENCES patients(id),created_by_user_id uuid NOT NULL REFERENCES users(id),settings_version integer NOT NULL,destination_url text NOT NULL,created_at timestamptz(3) NOT NULL,expires_at timestamptz(3) NOT NULL CHECK(expires_at>created_at),cancelled_at timestamptz(3),opened_at timestamptz(3));
CREATE INDEX review_requests_organisation_id_created_at_id_idx ON review_requests(organisation_id,created_at,id);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['review_settings','review_requests'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO dhc_app',t);
 EXECUTE format('CREATE POLICY tenant_isolation ON %I TO dhc_app USING(organisation_id=app_current_organisation_id()) WITH CHECK(organisation_id=app_current_organisation_id())',t);
END LOOP;END $$;
ALTER TABLE whatsapp_opt_ins DROP CONSTRAINT whatsapp_opt_ins_category_check;
ALTER TABLE whatsapp_opt_ins ADD CONSTRAINT whatsapp_opt_ins_category_check CHECK(category IN('appointments','records','payments','reviews'));
ALTER TABLE whatsapp_deliveries ADD COLUMN review_request_id uuid UNIQUE REFERENCES review_requests(id);
DO $$ DECLARE expr text;BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO expr FROM pg_constraint WHERE conrelid='whatsapp_deliveries'::regclass AND conname='whatsapp_delivery_kind_check';
 ALTER TABLE whatsapp_deliveries DROP CONSTRAINT whatsapp_delivery_kind_check;
 EXECUTE 'ALTER TABLE whatsapp_deliveries ADD CONSTRAINT whatsapp_delivery_kind_check CHECK ((review_request_id IS NULL AND ('||expr||')) OR (kind=''review_request'' AND review_request_id=id AND operational_update_id IS NULL AND financial_order_id IS NULL AND receipt_payment_id IS NULL AND refund_entry_id IS NULL AND otp_challenge_id IS NULL AND appointment_id IS NULL AND recipient_patient_id IS NOT NULL AND opt_in_id IS NOT NULL AND opt_in_version IS NOT NULL AND due_at IS NOT NULL AND expires_at IS NOT NULL AND prescription_id IS NULL AND referral_letter_id IS NULL AND patient_document_id IS NULL))';
END $$;
CREATE FUNCTION review_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Review history is retained';END IF;
 IF TG_TABLE_NAME='review_settings' THEN
  IF TG_OP='UPDATE' AND (NEW.organisation_id<>OLD.organisation_id OR NEW.version<>OLD.version+1) THEN RAISE EXCEPTION 'Review settings revision conflict';END IF;
 ELSE
  IF TG_OP='UPDATE' AND ((NEW.id,NEW.organisation_id,NEW.appointment_id,NEW.patient_id,NEW.created_by_user_id,NEW.settings_version,NEW.destination_url,NEW.created_at,NEW.expires_at) IS DISTINCT FROM (OLD.id,OLD.organisation_id,OLD.appointment_id,OLD.patient_id,OLD.created_by_user_id,OLD.settings_version,OLD.destination_url,OLD.created_at,OLD.expires_at) OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at) OR (OLD.opened_at IS NOT NULL AND NEW.opened_at IS DISTINCT FROM OLD.opened_at)) THEN RAISE EXCEPTION 'Review request identity and history are immutable';END IF;
  IF NOT EXISTS(SELECT 1 FROM appointments WHERE id=NEW.appointment_id AND organisation_id=NEW.organisation_id) OR NOT EXISTS(SELECT 1 FROM patients WHERE id=NEW.patient_id AND organisation_id=NEW.organisation_id) OR NOT EXISTS(SELECT 1 FROM memberships WHERE organisation_id=NEW.organisation_id AND user_id=NEW.created_by_user_id AND role IN('doctor','front_desk','clinic_admin')) THEN RAISE EXCEPTION 'Review source belongs to another clinic';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER review_history_guard BEFORE INSERT OR UPDATE OR DELETE ON review_requests FOR EACH ROW EXECUTE FUNCTION review_history_guard();
CREATE TRIGGER review_history_guard BEFORE INSERT OR UPDATE OR DELETE ON review_settings FOR EACH ROW EXECUTE FUNCTION review_history_guard();
CREATE FUNCTION enqueue_review_request(p_id uuid,p_appointment uuid,p_actor uuid,p_sender text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE org uuid:=public.app_current_organisation_id();a public.appointments%ROWTYPE;p public.patients%ROWTYPE;s public.review_settings%ROWTYPE;pref public.whatsapp_opt_ins%ROWTYPE;contact text;
BEGIN
 SELECT * INTO s FROM public.review_settings WHERE organisation_id=org FOR SHARE;
 IF NOT coalesce(s.enabled,false) OR s.google_url IS NULL OR NOT EXISTS(SELECT 1 FROM public.organisations WHERE id=org AND status='active') THEN RAISE EXCEPTION 'reviews_unavailable';END IF;
 SELECT * INTO a FROM public.appointments WHERE id=p_appointment AND organisation_id=org FOR SHARE;
 IF a.id IS NULL OR a.status<>'completed' OR a.start_at>CURRENT_TIMESTAMP OR a.start_at<CURRENT_TIMESTAMP-interval '30 days' THEN RAISE EXCEPTION 'review_visit_ineligible';END IF;
 SELECT live.* INTO p FROM public.patients src JOIN public.patients live ON live.id=coalesce(src.merged_into_id,src.id) AND live.organisation_id=src.organisation_id WHERE src.id=a.patient_id AND src.organisation_id=org FOR SHARE OF live;
 IF p.id IS NULL OR p.portal_closed_at IS NOT NULL THEN RAISE EXCEPTION 'review_recipient_unavailable';END IF;
 SELECT coalesce(p.phone,g.phone) INTO contact FROM (SELECT 1) x LEFT JOIN public.patients g ON g.id=p.guardian_patient_id AND g.organisation_id=org AND g.merged_into_id IS NULL AND g.portal_closed_at IS NULL;
 IF contact IS NULL THEN RAISE EXCEPTION 'review_recipient_unavailable';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(org::text||':'||contact,0));
 SELECT * INTO pref FROM public.whatsapp_opt_ins WHERE organisation_id=org AND phone=contact AND category='reviews' AND sender_phone_number_id=p_sender AND enabled FOR SHARE;
 IF pref.id IS NULL OR NOT EXISTS(SELECT 1 FROM public.users u JOIN public.memberships m ON m.user_id=u.id WHERE u.id=pref.changed_by_user_id AND u.phone=contact AND u.status='active' AND m.organisation_id=org AND m.role='patient' AND m.status='active') THEN RAISE EXCEPTION 'review_consent_required';END IF;
 IF EXISTS(SELECT 1 FROM public.review_requests r JOIN public.whatsapp_deliveries d ON d.review_request_id=r.id JOIN public.whatsapp_opt_ins o ON o.id=d.opt_in_id WHERE r.organisation_id=org AND o.phone=contact AND r.created_at>CURRENT_TIMESTAMP-s.cooldown_days*interval '1 day') THEN RAISE EXCEPTION 'review_cooldown';END IF;
 INSERT INTO public.review_requests(id,organisation_id,appointment_id,patient_id,created_by_user_id,settings_version,destination_url,created_at,expires_at) VALUES(p_id,org,a.id,p.id,p_actor,s.version,s.google_url,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval '14 days');
 INSERT INTO public.whatsapp_deliveries(id,organisation_id,sender_phone_number_id,kind,recipient_patient_id,opt_in_id,opt_in_version,due_at,expires_at,status,last_status_at,created_at,review_request_id) VALUES(p_id,org,p_sender,'review_request',p.id,pref.id,pref.version,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval '24 hours','queued',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,p_id);
END $$;
REVOKE EXECUTE ON FUNCTION enqueue_review_request(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_review_request(uuid,uuid,uuid,text) TO dhc_app;
CREATE FUNCTION messaging_claim_review_notices(p_sender text) RETURNS TABLE(id uuid) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 UPDATE public.whatsapp_deliveries SET status='uncertain',last_status_at=CURRENT_TIMESTAMP WHERE kind='review_request' AND status='sending' AND attempted_at<CURRENT_TIMESTAMP-interval '2 minutes';
 UPDATE public.whatsapp_deliveries SET status='skipped',skip_reason='expired',last_status_at=CURRENT_TIMESTAMP WHERE kind='review_request' AND status='queued' AND expires_at<=CURRENT_TIMESTAMP;
 RETURN QUERY UPDATE public.whatsapp_deliveries d SET dispatch_lease_at=CURRENT_TIMESTAMP WHERE d.id IN(SELECT x.id FROM public.whatsapp_deliveries x WHERE x.kind='review_request' AND x.sender_phone_number_id=p_sender AND x.status='queued' AND (x.dispatch_lease_at IS NULL OR x.dispatch_lease_at<CURRENT_TIMESTAMP-interval '60 seconds') ORDER BY x.created_at LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING d.id;
END $$;
CREATE FUNCTION messaging_begin_review_notice(p_id uuid,p_sender text) RETURNS TABLE(phone text,clinic_name text,expires_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.whatsapp_deliveries%ROWTYPE;r public.review_requests%ROWTYPE;s public.review_settings%ROWTYPE;p public.patients%ROWTYPE;pref public.whatsapp_opt_ins%ROWTYPE;contact text;label text;problem text;
BEGIN
 SELECT * INTO r FROM public.review_requests WHERE id=p_id FOR SHARE;IF r.id IS NULL THEN RETURN;END IF;
 SELECT * INTO s FROM public.review_settings WHERE organisation_id=r.organisation_id FOR SHARE;
 SELECT * INTO p FROM public.patients WHERE id=r.patient_id AND organisation_id=r.organisation_id AND merged_into_id IS NULL AND portal_closed_at IS NULL FOR SHARE;
 SELECT * INTO d FROM public.whatsapp_deliveries WHERE id=p_id AND kind='review_request' AND sender_phone_number_id=p_sender;
 SELECT * INTO pref FROM public.whatsapp_opt_ins WHERE id=d.opt_in_id FOR SHARE;
 SELECT coalesce(p.phone,g.phone) INTO contact FROM (SELECT 1) x LEFT JOIN public.patients g ON g.id=p.guardian_patient_id AND g.organisation_id=r.organisation_id AND g.merged_into_id IS NULL AND g.portal_closed_at IS NULL;
 SELECT name INTO label FROM public.organisations WHERE id=r.organisation_id AND status='active';
 SELECT * INTO d FROM public.whatsapp_deliveries WHERE id=p_id AND kind='review_request' AND sender_phone_number_id=p_sender FOR UPDATE;IF d.id IS NULL OR d.status<>'queued' THEN RETURN;END IF;
 problem:=CASE WHEN d.expires_at<=CURRENT_TIMESTAMP OR r.expires_at<=CURRENT_TIMESTAMP THEN 'expired' WHEN r.cancelled_at IS NOT NULL OR NOT coalesce(s.enabled,false) OR s.version<>r.settings_version OR s.google_url IS DISTINCT FROM r.destination_url OR label IS NULL THEN 'source_changed'
 WHEN p.id IS NULL OR contact IS DISTINCT FROM pref.phone OR NOT coalesce(pref.enabled,false) OR pref.category<>'reviews' OR pref.version<>d.opt_in_version OR pref.sender_phone_number_id<>p_sender OR pref.organisation_id<>r.organisation_id THEN 'consent_changed'
 WHEN NOT EXISTS(SELECT 1 FROM public.appointments a WHERE a.id=r.appointment_id AND a.organisation_id=r.organisation_id AND a.status='completed' AND coalesce((SELECT merged_into_id FROM public.patients WHERE id=a.patient_id),a.patient_id)=p.id) THEN 'source_changed'
 WHEN NOT EXISTS(SELECT 1 FROM public.users u JOIN public.memberships m ON m.user_id=u.id WHERE u.id=pref.changed_by_user_id AND u.phone=contact AND u.status='active' AND m.organisation_id=r.organisation_id AND m.role='patient' AND m.status='active') THEN 'recipient_changed' ELSE NULL END;
 IF problem IS NOT NULL THEN UPDATE public.whatsapp_deliveries SET status='skipped',skip_reason=problem,last_status_at=CURRENT_TIMESTAMP WHERE id=d.id;RETURN;END IF;
 UPDATE public.whatsapp_deliveries SET status='sending',attempted_at=CURRENT_TIMESTAMP,last_status_at=CURRENT_TIMESTAMP WHERE id=d.id;
 INSERT INTO public.audit_logs(id,organisation_id,action,entity_type,entity_id) VALUES(gen_random_uuid(),r.organisation_id,'review.send_authorized','review_request',r.id::text);
 RETURN QUERY SELECT contact,label,r.expires_at;
END $$;
CREATE FUNCTION messaging_finish_review_notice(p_id uuid,p_sender text,p_status text,p_message text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.whatsapp_deliveries%ROWTYPE;BEGIN
 IF p_status NOT IN('accepted','submission_failed','uncertain') THEN RAISE EXCEPTION 'Invalid result';END IF;
 SELECT * INTO d FROM public.whatsapp_deliveries WHERE id=p_id AND sender_phone_number_id=p_sender AND kind='review_request' FOR UPDATE;
 IF d.id IS NULL OR d.attempted_at IS NULL THEN RAISE EXCEPTION 'Review send not authorized';END IF;
 IF d.provider_message_id IS NOT NULL AND p_message IS NOT NULL AND d.provider_message_id<>p_message THEN RAISE EXCEPTION 'Message mismatch';END IF;
 UPDATE public.whatsapp_deliveries SET provider_message_id=coalesce(provider_message_id,p_message),status=CASE WHEN status='sending' THEN p_status ELSE status END,last_status_at=CASE WHEN status='sending' THEN CURRENT_TIMESTAMP ELSE last_status_at END WHERE id=d.id;
END $$;
CREATE FUNCTION review_resolve_link(p_id uuid,p_sender text,p_open boolean) RETURNS TABLE(clinic_name text,destination_url text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r public.review_requests%ROWTYPE;d public.whatsapp_deliveries%ROWTYPE;s public.review_settings%ROWTYPE;pref public.whatsapp_opt_ins%ROWTYPE;p public.patients%ROWTYPE;contact text;label text;
BEGIN
 SELECT * INTO r FROM public.review_requests WHERE id=p_id FOR UPDATE;
 IF r.id IS NULL OR r.cancelled_at IS NOT NULL OR r.expires_at<=CURRENT_TIMESTAMP THEN RETURN;END IF;
 SELECT * INTO s FROM public.review_settings WHERE organisation_id=r.organisation_id FOR SHARE;
 SELECT * INTO d FROM public.whatsapp_deliveries WHERE review_request_id=r.id AND sender_phone_number_id=p_sender;
 SELECT * INTO pref FROM public.whatsapp_opt_ins WHERE id=d.opt_in_id FOR SHARE;
 SELECT * INTO p FROM public.patients WHERE id=r.patient_id AND organisation_id=r.organisation_id AND merged_into_id IS NULL AND portal_closed_at IS NULL FOR SHARE;
 SELECT coalesce(p.phone,g.phone) INTO contact FROM (SELECT 1) x LEFT JOIN public.patients g ON g.id=p.guardian_patient_id AND g.organisation_id=r.organisation_id AND g.merged_into_id IS NULL AND g.portal_closed_at IS NULL;
 SELECT name INTO label FROM public.organisations WHERE id=r.organisation_id AND status='active';
 IF label IS NULL OR NOT coalesce(s.enabled,false) OR s.version<>r.settings_version OR s.google_url IS DISTINCT FROM r.destination_url OR d.attempted_at IS NULL OR d.status NOT IN('accepted','sent','delivered','read','uncertain') OR p.id IS NULL OR contact IS DISTINCT FROM pref.phone OR NOT coalesce(pref.enabled,false) OR pref.category<>'reviews' OR pref.version<>d.opt_in_version OR pref.sender_phone_number_id<>p_sender OR pref.organisation_id<>r.organisation_id OR NOT EXISTS(SELECT 1 FROM public.users u JOIN public.memberships m ON m.user_id=u.id WHERE u.id=pref.changed_by_user_id AND u.phone=contact AND u.status='active' AND m.organisation_id=r.organisation_id AND m.role='patient' AND m.status='active') OR NOT EXISTS(SELECT 1 FROM public.appointments a WHERE a.id=r.appointment_id AND a.organisation_id=r.organisation_id AND a.status='completed' AND coalesce((SELECT merged_into_id FROM public.patients WHERE id=a.patient_id),a.patient_id)=p.id) THEN RETURN;END IF;
 IF p_open AND r.opened_at IS NULL THEN
 UPDATE public.review_requests SET opened_at=CURRENT_TIMESTAMP WHERE id=r.id;
 INSERT INTO public.audit_logs(id,organisation_id,action,entity_type,entity_id) VALUES(gen_random_uuid(),r.organisation_id,'review.link_opened','review_request',r.id::text);
 END IF;
 RETURN QUERY SELECT label,r.destination_url;
END $$;
REVOKE EXECUTE ON FUNCTION messaging_claim_review_notices(text),messaging_begin_review_notice(uuid,text),messaging_finish_review_notice(uuid,text,text,text),review_resolve_link(uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION messaging_claim_review_notices(text),messaging_begin_review_notice(uuid,text),messaging_finish_review_notice(uuid,text,text,text),review_resolve_link(uuid,text,boolean) TO dhc_messaging;
CREATE FUNCTION cancel_review_request(p_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 UPDATE public.review_requests SET cancelled_at=coalesce(cancelled_at,CURRENT_TIMESTAMP) WHERE id=p_id AND organisation_id=public.app_current_organisation_id();
 UPDATE public.whatsapp_deliveries SET status='skipped',skip_reason='source_changed',last_status_at=CURRENT_TIMESTAMP WHERE review_request_id=p_id AND organisation_id=public.app_current_organisation_id() AND status='queued';
END $$;
REVOKE EXECUTE ON FUNCTION cancel_review_request(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cancel_review_request(uuid) TO dhc_app;
