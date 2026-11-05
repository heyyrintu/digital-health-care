ALTER TABLE whatsapp_opt_ins DROP CONSTRAINT whatsapp_opt_ins_category_check;
ALTER TABLE whatsapp_opt_ins ADD CONSTRAINT whatsapp_opt_ins_category_check CHECK(category IN ('appointments','records','payments'));
ALTER TABLE whatsapp_deliveries ADD COLUMN financial_order_id uuid REFERENCES cashfree_orders(id) ON DELETE RESTRICT,
 ADD COLUMN receipt_payment_id uuid REFERENCES payments(id) ON DELETE RESTRICT,
 ADD COLUMN refund_entry_id uuid REFERENCES refund_entries(refund_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX whatsapp_finance_order_key ON whatsapp_deliveries(financial_order_id,sender_phone_number_id);
CREATE UNIQUE INDEX whatsapp_finance_receipt_key ON whatsapp_deliveries(receipt_payment_id,sender_phone_number_id);
CREATE UNIQUE INDEX whatsapp_finance_refund_key ON whatsapp_deliveries(refund_entry_id,sender_phone_number_id);
ALTER TABLE whatsapp_deliveries DROP CONSTRAINT whatsapp_delivery_kind_check;
ALTER TABLE whatsapp_deliveries ADD CONSTRAINT whatsapp_delivery_kind_check CHECK (
((
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
      OR (kind = 'document_ready' AND patient_document_id IS NOT NULL AND prescription_id IS NULL AND referral_letter_id IS NULL)))) AND financial_order_id IS NULL AND receipt_payment_id IS NULL AND refund_entry_id IS NULL)
OR (kind IN ('payment_link','receipt_ready','refund_ready') AND otp_challenge_id IS NULL AND appointment_id IS NULL
 AND prescription_id IS NULL AND referral_letter_id IS NULL AND patient_document_id IS NULL
 AND recipient_patient_id IS NOT NULL AND opt_in_id IS NOT NULL AND opt_in_version IS NOT NULL AND due_at IS NOT NULL AND expires_at IS NOT NULL
 AND ((kind='payment_link' AND financial_order_id IS NOT NULL AND receipt_payment_id IS NULL AND refund_entry_id IS NULL)
 OR (kind='receipt_ready' AND receipt_payment_id IS NOT NULL AND financial_order_id IS NULL AND refund_entry_id IS NULL)
 OR (kind='refund_ready' AND refund_entry_id IS NOT NULL AND financial_order_id IS NULL AND receipt_payment_id IS NULL)))
);

CREATE FUNCTION enqueue_whatsapp_finance(p_kind text,p_id uuid,p_org uuid,p_patient uuid,p_expiry timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE pref public.whatsapp_opt_ins%ROWTYPE; contact text; recipient uuid;
BEGIN
 SELECT live.id,coalesce(live.phone,g.phone) INTO recipient,contact FROM public.patients p
 JOIN public.patients live ON live.id=coalesce(p.merged_into_id,p.id) AND live.organisation_id=p.organisation_id AND live.merged_into_id IS NULL
 LEFT JOIN public.patients g ON g.id=live.guardian_patient_id AND g.organisation_id=live.organisation_id AND g.merged_into_id IS NULL
 WHERE p.id=p_patient AND p.organisation_id=p_org;
 IF recipient IS NULL OR contact IS NULL OR p_expiry<=CURRENT_TIMESTAMP THEN RETURN;END IF;
 FOR pref IN SELECT * FROM public.whatsapp_opt_ins WHERE organisation_id=p_org AND phone=contact AND category='payments' AND enabled LOOP
  INSERT INTO public.whatsapp_deliveries(id,organisation_id,sender_phone_number_id,kind,recipient_patient_id,opt_in_id,opt_in_version,financial_order_id,receipt_payment_id,refund_entry_id,due_at,expires_at,status,last_status_at,created_at)
  VALUES(gen_random_uuid(),p_org,pref.sender_phone_number_id,p_kind,recipient,pref.id,pref.version,
   CASE WHEN p_kind='payment_link' THEN p_id END,CASE WHEN p_kind='receipt_ready' THEN p_id END,CASE WHEN p_kind='refund_ready' THEN p_id END,
   CURRENT_TIMESTAMP,p_expiry,'queued',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING;
 END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION enqueue_whatsapp_finance(text,uuid,uuid,uuid,timestamptz) FROM PUBLIC;
CREATE FUNCTION whatsapp_finance_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE patient uuid;
BEGIN
 IF TG_TABLE_NAME='cashfree_orders' THEN
  IF NEW.status='active' AND OLD.status='creating' THEN
   SELECT patient_id INTO patient FROM public.bills WHERE id=NEW.bill_id AND organisation_id=NEW.organisation_id;
   PERFORM public.enqueue_whatsapp_finance('payment_link',NEW.id,NEW.organisation_id,patient,NEW.expires_at);
  END IF;
 ELSIF TG_TABLE_NAME='payments' THEN
  SELECT patient_id INTO patient FROM public.bills WHERE id=NEW.bill_id AND organisation_id=NEW.organisation_id;
  PERFORM public.enqueue_whatsapp_finance('receipt_ready',NEW.id,NEW.organisation_id,patient,CURRENT_TIMESTAMP+interval '24 hours');
 ELSE
  SELECT patient_id INTO patient FROM public.bills WHERE id=NEW.bill_id AND organisation_id=NEW.organisation_id;
  PERFORM public.enqueue_whatsapp_finance('refund_ready',NEW.refund_id,NEW.organisation_id,patient,CURRENT_TIMESTAMP+interval '24 hours');
 END IF;RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION whatsapp_finance_event() FROM PUBLIC;
CREATE TRIGGER whatsapp_finance_order AFTER UPDATE OF status ON cashfree_orders FOR EACH ROW EXECUTE FUNCTION whatsapp_finance_event();
CREATE TRIGGER whatsapp_finance_receipt AFTER INSERT ON payments FOR EACH ROW EXECUTE FUNCTION whatsapp_finance_event();
CREATE TRIGGER whatsapp_finance_refund AFTER INSERT ON refund_entries FOR EACH ROW EXECUTE FUNCTION whatsapp_finance_event();
CREATE FUNCTION messaging_claim_payment_notices(p_sender text) RETURNS TABLE(id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 UPDATE public.whatsapp_deliveries SET status='skipped',skip_reason='expired',last_status_at=CURRENT_TIMESTAMP WHERE kind IN ('payment_link','receipt_ready','refund_ready') AND status='queued' AND expires_at<=CURRENT_TIMESTAMP;
 UPDATE public.whatsapp_deliveries SET status='uncertain',last_status_at=CURRENT_TIMESTAMP WHERE kind IN ('payment_link','receipt_ready','refund_ready') AND status='sending' AND attempted_at<CURRENT_TIMESTAMP-interval '2 minutes';
 RETURN QUERY UPDATE public.whatsapp_deliveries d SET dispatch_lease_at=CURRENT_TIMESTAMP WHERE d.id IN
 (SELECT n.id FROM public.whatsapp_deliveries n WHERE n.sender_phone_number_id=p_sender AND n.kind IN ('payment_link','receipt_ready','refund_ready') AND n.status='queued' AND n.due_at<=CURRENT_TIMESTAMP AND n.expires_at>CURRENT_TIMESTAMP
 AND(n.dispatch_lease_at IS NULL OR n.dispatch_lease_at<CURRENT_TIMESTAMP-interval '60 seconds') ORDER BY n.dispatch_lease_at NULLS FIRST,n.due_at,n.id LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING d.id;
END $$;
CREATE FUNCTION messaging_begin_payment_notice(p_id uuid,p_sender text) RETURNS TABLE(phone text,organisation_slug text,link_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.whatsapp_deliveries%ROWTYPE;pref public.whatsapp_opt_ins%ROWTYPE; source_patient uuid; recipient uuid;contact text;slug text;valid boolean:=false;problem text;
BEGIN
 SELECT * INTO d FROM public.whatsapp_deliveries WHERE id=p_id;
 IF NOT FOUND OR d.kind NOT IN ('payment_link','receipt_ready','refund_ready') OR d.sender_phone_number_id<>p_sender OR d.status<>'queued' OR d.due_at>CURRENT_TIMESTAMP THEN RETURN;END IF;
 SELECT * INTO pref FROM public.whatsapp_opt_ins WHERE id=d.opt_in_id FOR SHARE;
 IF d.kind='payment_link' THEN
  SELECT b.patient_id,o.status='active' AND o.expires_at>CURRENT_TIMESTAMP AND b.total_paise-b.paid_paise=o.amount_paise INTO source_patient,valid
  FROM public.cashfree_orders o JOIN public.bills b ON b.id=o.bill_id AND b.organisation_id=o.organisation_id WHERE o.id=d.financial_order_id AND o.organisation_id=d.organisation_id;
 ELSIF d.kind='receipt_ready' THEN
  SELECT b.patient_id,true INTO source_patient,valid FROM public.payments p JOIN public.bills b ON b.id=p.bill_id AND b.organisation_id=p.organisation_id WHERE p.id=d.receipt_payment_id AND p.organisation_id=d.organisation_id;
 ELSE
  SELECT b.patient_id,true INTO source_patient,valid FROM public.refund_entries r JOIN public.bills b ON b.id=r.bill_id AND b.organisation_id=r.organisation_id WHERE r.refund_id=d.refund_entry_id AND r.organisation_id=d.organisation_id;
 END IF;
 SELECT live.id,coalesce(live.phone,g.phone) INTO recipient,contact FROM public.patients p
 JOIN public.patients live ON live.id=coalesce(p.merged_into_id,p.id) AND live.organisation_id=p.organisation_id AND live.merged_into_id IS NULL
 LEFT JOIN public.patients g ON g.id=live.guardian_patient_id AND g.organisation_id=live.organisation_id AND g.merged_into_id IS NULL
 WHERE p.id=source_patient AND p.organisation_id=d.organisation_id FOR SHARE OF live;
 SELECT o.slug INTO slug FROM public.organisations o WHERE o.id=d.organisation_id AND o.status='active';
 SELECT * INTO d FROM public.whatsapp_deliveries WHERE id=p_id FOR UPDATE;
 IF d.status<>'queued' THEN RETURN;END IF;
 problem:=CASE WHEN d.expires_at<=CURRENT_TIMESTAMP THEN 'expired'
 WHEN slug IS NULL OR NOT coalesce(valid,false) OR recipient IS DISTINCT FROM d.recipient_patient_id THEN 'record_changed'
 WHEN contact IS NULL OR contact IS DISTINCT FROM pref.phone THEN 'recipient_changed'
 WHEN pref.id IS NULL OR NOT pref.enabled OR pref.category<>'payments' OR pref.version<>d.opt_in_version OR pref.organisation_id<>d.organisation_id OR pref.sender_phone_number_id<>p_sender THEN 'consent_changed' ELSE NULL END;
 IF problem IS NOT NULL THEN UPDATE public.whatsapp_deliveries SET status='skipped',skip_reason=problem,last_status_at=CURRENT_TIMESTAMP WHERE id=d.id;RETURN;END IF;
 UPDATE public.whatsapp_deliveries SET status='sending',attempted_at=CURRENT_TIMESTAMP,last_status_at=CURRENT_TIMESTAMP,link_expires_at=least(CURRENT_TIMESTAMP+interval '1 hour',d.expires_at) WHERE id=d.id;
 INSERT INTO public.audit_logs(id,organisation_id,action,entity_type,entity_id,metadata) VALUES(gen_random_uuid(),d.organisation_id,'messaging.send_started','whatsapp_delivery',d.id::text,jsonb_build_object('kind',d.kind));
 RETURN QUERY SELECT contact,slug,x.link_expires_at FROM public.whatsapp_deliveries x WHERE x.id=d.id;
END $$;
CREATE FUNCTION messaging_finish_payment_notice(p_id uuid, p_sender text, p_status text, p_message text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.whatsapp_deliveries%ROWTYPE;
BEGIN
  IF p_status NOT IN ('accepted','submission_failed','uncertain') THEN RAISE EXCEPTION 'invalid send result' USING ERRCODE = '23514'; END IF;
  SELECT * INTO STRICT d FROM public.whatsapp_deliveries WHERE id = p_id AND sender_phone_number_id = p_sender FOR UPDATE;
  IF d.kind NOT IN ('payment_link','receipt_ready','refund_ready') OR d.attempted_at IS NULL THEN
    RAISE EXCEPTION 'payment notice has not started' USING ERRCODE = '23514'; END IF;
  IF p_message IS NOT NULL AND d.provider_message_id IS NOT NULL AND d.provider_message_id <> p_message THEN
    RAISE EXCEPTION 'WhatsApp message does not match' USING ERRCODE = '23514'; END IF;
  UPDATE public.whatsapp_deliveries SET provider_message_id = coalesce(provider_message_id, p_message),
    status = CASE WHEN status = 'sending' THEN p_status ELSE status END,
    last_status_at = CASE WHEN status = 'sending' THEN CURRENT_TIMESTAMP ELSE last_status_at END WHERE id = d.id;
  INSERT INTO public.audit_logs(id, organisation_id, action, entity_type, entity_id, metadata)
    VALUES(gen_random_uuid(), d.organisation_id, 'messaging.send_finished', 'whatsapp_delivery', d.id::text, jsonb_build_object('result', p_status));
END $$;
REVOKE EXECUTE ON FUNCTION messaging_claim_payment_notices(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION messaging_begin_payment_notice(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION messaging_finish_payment_notice(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION messaging_claim_payment_notices(text), messaging_begin_payment_notice(uuid, text),
  messaging_finish_payment_notice(uuid, text, text, text) TO dhc_messaging;

REVOKE EXECUTE ON FUNCTION messaging_claim_payment_notices(text),messaging_begin_payment_notice(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION messaging_claim_payment_notices(text),messaging_begin_payment_notice(uuid,text) TO dhc_messaging;

CREATE FUNCTION whatsapp_finance_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source_patient uuid; recipient uuid;
BEGIN
 IF NEW.kind NOT IN ('payment_link','receipt_ready','refund_ready') THEN
  IF TG_OP='UPDATE' THEN IF OLD.kind IN ('payment_link','receipt_ready','refund_ready') THEN RAISE EXCEPTION 'financial notice identity is immutable' USING ERRCODE='23514';END IF;END IF;
  RETURN NEW;END IF;
 IF TG_OP='UPDATE' AND (NEW.organisation_id,NEW.kind,NEW.recipient_patient_id,NEW.financial_order_id,NEW.receipt_payment_id,NEW.refund_entry_id,NEW.opt_in_id,NEW.opt_in_version,NEW.sender_phone_number_id) IS DISTINCT FROM (OLD.organisation_id,OLD.kind,OLD.recipient_patient_id,OLD.financial_order_id,OLD.receipt_payment_id,OLD.refund_entry_id,OLD.opt_in_id,OLD.opt_in_version,OLD.sender_phone_number_id) THEN RAISE EXCEPTION 'financial notice identity is immutable' USING ERRCODE='23514';END IF;
 IF NEW.kind='payment_link' THEN SELECT b.patient_id INTO source_patient FROM public.cashfree_orders o JOIN public.bills b ON b.id=o.bill_id AND b.organisation_id=o.organisation_id WHERE o.id=NEW.financial_order_id AND o.organisation_id=NEW.organisation_id;
 ELSIF NEW.kind='receipt_ready' THEN SELECT b.patient_id INTO source_patient FROM public.payments p JOIN public.bills b ON b.id=p.bill_id AND b.organisation_id=p.organisation_id WHERE p.id=NEW.receipt_payment_id AND p.organisation_id=NEW.organisation_id;
 ELSE SELECT b.patient_id INTO source_patient FROM public.refund_entries r JOIN public.bills b ON b.id=r.bill_id AND b.organisation_id=r.organisation_id WHERE r.refund_id=NEW.refund_entry_id AND r.organisation_id=NEW.organisation_id;END IF;
 SELECT coalesce(p.merged_into_id,p.id) INTO recipient FROM public.patients p WHERE p.id=source_patient AND p.organisation_id=NEW.organisation_id;
 IF recipient IS DISTINCT FROM NEW.recipient_patient_id OR NOT EXISTS(SELECT 1 FROM public.whatsapp_opt_ins WHERE id=NEW.opt_in_id AND organisation_id=NEW.organisation_id AND category='payments' AND sender_phone_number_id=NEW.sender_phone_number_id) THEN RAISE EXCEPTION 'financial notice source mismatch' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER whatsapp_finance_source_guard BEFORE INSERT OR UPDATE OF organisation_id,kind,recipient_patient_id,financial_order_id,receipt_payment_id,refund_entry_id,opt_in_id,opt_in_version,sender_phone_number_id ON whatsapp_deliveries FOR EACH ROW EXECUTE FUNCTION whatsapp_finance_source_guard();
REVOKE EXECUTE ON FUNCTION whatsapp_finance_source_guard() FROM PUBLIC;
