-- An unpaid reservation holds an ordinary pending slot; only verified internal work may release/confirm it.
CREATE TABLE cashfree_bookings (
 id uuid PRIMARY KEY, organisation_id uuid NOT NULL REFERENCES organisations(id),
 appointment_id uuid NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE RESTRICT,
 order_id uuid NOT NULL UNIQUE REFERENCES cashfree_orders(id) ON DELETE RESTRICT,
 created_by_user_id uuid NOT NULL REFERENCES users(id), auto_confirm boolean NOT NULL DEFAULT true, request_hash text NOT NULL,
 expires_at timestamptz(3) NOT NULL, state text NOT NULL DEFAULT 'held' CHECK(state IN ('held','confirmed','released','review')),
 next_check_at timestamptz(3) NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT now(),CHECK(id=order_id)
);
CREATE INDEX cashfree_bookings_organisation_id_state_next_check_at_idx ON cashfree_bookings(organisation_id,state,next_check_at);
ALTER TABLE cashfree_bookings ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON cashfree_bookings TO dhc_app;
GRANT INSERT,UPDATE ON cashfree_bookings TO dhc_payments;
CREATE POLICY tenant_isolation ON cashfree_bookings TO dhc_app USING(organisation_id=app_current_organisation_id()) WITH CHECK(organisation_id=app_current_organisation_id());
CREATE FUNCTION prepaid_booking_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.cashfree_orders o JOIN public.bills b ON b.id=o.bill_id JOIN public.appointments a ON a.id=b.appointment_id WHERE o.id=NEW.order_id AND a.id=NEW.appointment_id AND a.organisation_id=NEW.organisation_id AND o.organisation_id=NEW.organisation_id AND o.created_by_user_id=NEW.created_by_user_id AND o.expires_at=NEW.expires_at AND o.amount_paise=b.total_paise) THEN RAISE EXCEPTION 'prepaid booking source mismatch' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'held' OR NOT EXISTS(SELECT 1 FROM public.appointments WHERE id=NEW.appointment_id AND status='pending') THEN RAISE EXCEPTION 'prepaid booking must start held' USING ERRCODE='23514';END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','next_check_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','next_check_at']) THEN RAISE EXCEPTION 'prepaid booking identity is immutable' USING ERRCODE='23514';END IF;
  IF NEW.state<>OLD.state AND NOT ((OLD.state='held' AND NEW.state IN ('confirmed','released','review')) OR (OLD.state='released' AND NEW.state='review')) THEN RAISE EXCEPTION 'invalid prepaid booking transition' USING ERRCODE='23514';END IF;
  IF NEW.state='confirmed' AND NOT EXISTS(SELECT 1 FROM public.cashfree_orders o JOIN public.payments p ON p.cashfree_order_id=o.id WHERE o.id=NEW.order_id AND o.status='paid' AND p.amount_paise=o.amount_paise) THEN RAISE EXCEPTION 'booking confirmation needs a verified receipt' USING ERRCODE='23514';END IF;
  IF NEW.state='released' AND NOT EXISTS(SELECT 1 FROM public.cashfree_orders WHERE id=NEW.order_id AND status IN ('terminated','expired')) THEN RAISE EXCEPTION 'release requires provider-confirmed closure' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prepaid_booking_guard BEFORE INSERT OR UPDATE ON cashfree_bookings FOR EACH ROW EXECUTE FUNCTION prepaid_booking_guard();
CREATE FUNCTION prepaid_appointment_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE held text;
BEGIN
 SELECT state INTO held FROM public.cashfree_bookings WHERE appointment_id=OLD.id;
 IF held IS NULL THEN RETURN NEW;END IF;
 IF (NEW.patient_id,NEW.doctor_user_id,NEW.clinic_id,NEW.consultation_type_id,NEW.start_at,NEW.end_at,NEW.date,NEW.source) IS DISTINCT FROM (OLD.patient_id,OLD.doctor_user_id,OLD.clinic_id,OLD.consultation_type_id,OLD.start_at,OLD.end_at,OLD.date,OLD.source) THEN RAISE EXCEPTION 'prepaid booking cannot be moved; cancel and review refund' USING ERRCODE='23514';END IF;
 IF NEW.status<>OLD.status AND ((held='held') OR (OLD.status='pending' AND held='review' AND NEW.status<>'cancelled') OR (held IN ('released','review') AND NEW.status IN ('confirmed','checked_in','in_consultation','completed'))) THEN RAISE EXCEPTION 'prepaid booking payment is not confirmed' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prepaid_appointment_guard BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION prepaid_appointment_guard();
CREATE FUNCTION prepaid_bill_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.cashfree_bookings WHERE appointment_id=OLD.appointment_id) AND (to_jsonb(NEW)-ARRAY['paid_paise','status','revision','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['paid_paise','status','revision','updated_at']) THEN RAISE EXCEPTION 'prepaid quote is immutable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prepaid_bill_guard BEFORE UPDATE ON bills FOR EACH ROW EXECUTE FUNCTION prepaid_bill_guard();
CREATE FUNCTION prepaid_line_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.cashfree_bookings h JOIN public.bills b ON b.appointment_id=h.appointment_id WHERE b.id=OLD.bill_id OR b.id=NEW.bill_id) THEN RAISE EXCEPTION 'prepaid quote lines are immutable' USING ERRCODE='23514';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;RETURN NEW;
END $$;
CREATE TRIGGER prepaid_line_guard BEFORE INSERT OR UPDATE OR DELETE ON bill_items FOR EACH ROW EXECUTE FUNCTION prepaid_line_guard();
CREATE FUNCTION prepaid_counter_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.mode::text<>'cashfree' AND EXISTS(SELECT 1 FROM public.bills b JOIN public.cashfree_bookings h ON h.appointment_id=b.appointment_id WHERE b.id=NEW.bill_id) THEN RAISE EXCEPTION 'prepaid reservation uses its original online order' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER prepaid_counter_guard BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION prepaid_counter_guard();
