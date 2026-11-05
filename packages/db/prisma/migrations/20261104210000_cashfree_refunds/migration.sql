ALTER TABLE cashfree_orders ADD COLUMN refund_review_required boolean NOT NULL DEFAULT false;
CREATE TABLE cashfree_refunds (
 id uuid PRIMARY KEY, organisation_id uuid NOT NULL REFERENCES organisations(id),
 order_id uuid NOT NULL REFERENCES cashfree_orders(id) ON DELETE RESTRICT,
 bill_id uuid NOT NULL REFERENCES bills(id) ON DELETE RESTRICT,
 payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
 merchant_refund_id text NOT NULL, provider_refund_id text,
 amount_paise integer NOT NULL CHECK(amount_paise BETWEEN 1 AND 10000000), currency text NOT NULL DEFAULT 'INR' CHECK(currency='INR'),
 origin text NOT NULL CHECK(origin IN ('app','provider')), reason text NOT NULL,
 status text NOT NULL DEFAULT 'creating' CHECK(status IN ('creating','pending','succeeded','cancelled','rejected','review')),
 requested_by_user_id uuid REFERENCES users(id),
 created_at timestamptz(3) NOT NULL DEFAULT now(), checked_at timestamptz(3), updated_at timestamptz(3) NOT NULL DEFAULT now(),
 CONSTRAINT cashfree_refund_merchant_key UNIQUE(order_id,merchant_refund_id),
 CONSTRAINT cashfree_refund_provider_key UNIQUE(order_id,provider_refund_id),
 CHECK(origin <> 'app' OR (merchant_refund_id='rf'||replace(id::text,'-','') AND requested_by_user_id IS NOT NULL AND reason IN ('service_cancelled','duplicate_payment','overcharge','other'))),
 CHECK(status <> 'succeeded' OR provider_refund_id IS NOT NULL)
);
CREATE INDEX cashfree_refunds_organisation_id_bill_id_idx ON cashfree_refunds(organisation_id,bill_id);
CREATE UNIQUE INDEX cashfree_one_open_app_refund ON cashfree_refunds(payment_id) WHERE origin='app' AND status IN ('creating','pending','review');
CREATE TABLE refund_settings (organisation_id uuid PRIMARY KEY REFERENCES organisations(id), next_number integer NOT NULL DEFAULT 1 CHECK(next_number>0));
CREATE TABLE refund_entries (
 refund_id uuid PRIMARY KEY REFERENCES cashfree_refunds(id) ON DELETE RESTRICT,
 organisation_id uuid NOT NULL REFERENCES organisations(id), bill_id uuid NOT NULL REFERENCES bills(id) ON DELETE RESTRICT,
 payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
 amount_paise integer NOT NULL CHECK(amount_paise>0), voucher_number text NOT NULL, posted_at timestamptz(3) NOT NULL,
 UNIQUE(organisation_id,voucher_number)
);
CREATE INDEX refund_entries_organisation_id_posted_at_idx ON refund_entries(organisation_id,posted_at);
CREATE TABLE cashfree_refund_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organisation_id uuid NOT NULL REFERENCES organisations(id), order_id uuid NOT NULL REFERENCES cashfree_orders(id) ON DELETE RESTRICT,
 event_hash text NOT NULL CHECK(length(event_hash)=64), merchant_refund_id text NOT NULL, provider_refund_id text NOT NULL,
 outcome text NOT NULL, received_at timestamptz(3) NOT NULL DEFAULT now(), UNIQUE(organisation_id,event_hash)
);
ALTER TABLE cashfree_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE refund_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE refund_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashfree_refund_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON cashfree_refunds,refund_entries,refund_settings,cashfree_refund_events TO dhc_app;
GRANT INSERT,UPDATE ON cashfree_refunds,refund_settings TO dhc_payments;
GRANT INSERT ON refund_entries,cashfree_refund_events TO dhc_payments;
CREATE POLICY tenant_isolation ON cashfree_refunds TO dhc_app USING(organisation_id=app_current_organisation_id()) WITH CHECK(organisation_id=app_current_organisation_id());
CREATE POLICY tenant_isolation ON refund_entries TO dhc_app USING(organisation_id=app_current_organisation_id()) WITH CHECK(organisation_id=app_current_organisation_id());
CREATE POLICY tenant_isolation ON refund_settings TO dhc_app USING(organisation_id=app_current_organisation_id()) WITH CHECK(organisation_id=app_current_organisation_id());
CREATE POLICY tenant_isolation ON cashfree_refund_events TO dhc_app USING(organisation_id=app_current_organisation_id()) WITH CHECK(organisation_id=app_current_organisation_id());
CREATE FUNCTION cashfree_refund_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p public.payments%ROWTYPE; reserved bigint;
BEGIN
 PERFORM 1 FROM public.bills WHERE id=NEW.bill_id AND organisation_id=NEW.organisation_id FOR UPDATE;
 SELECT * INTO p FROM public.payments WHERE id=NEW.payment_id AND organisation_id=NEW.organisation_id AND bill_id=NEW.bill_id AND cashfree_order_id=NEW.order_id AND mode::text='cashfree';
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.cashfree_orders o WHERE o.id=NEW.order_id AND o.status='paid' AND o.provider_payment_id=p.reference) THEN RAISE EXCEPTION 'refund source mismatch' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.organisation_id,NEW.order_id,NEW.bill_id,NEW.payment_id,NEW.merchant_refund_id,NEW.amount_paise,NEW.currency,NEW.origin,NEW.reason,NEW.requested_by_user_id) IS DISTINCT FROM (OLD.id,OLD.organisation_id,OLD.order_id,OLD.bill_id,OLD.payment_id,OLD.merchant_refund_id,OLD.amount_paise,OLD.currency,OLD.origin,OLD.reason,OLD.requested_by_user_id) OR (OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id) OR (OLD.status='succeeded' AND NEW.status<>'succeeded') THEN RAISE EXCEPTION 'refund identity and confirmed state are immutable' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='INSERT' AND NEW.origin='app' THEN
  SELECT coalesce(sum(amount_paise),0) INTO reserved FROM public.cashfree_refunds WHERE payment_id=NEW.payment_id AND status NOT IN ('cancelled','rejected');
  IF NEW.status<>'creating' OR reserved+NEW.amount_paise>p.amount_paise OR EXISTS(SELECT 1 FROM public.cashfree_refunds WHERE payment_id=NEW.payment_id AND status IN ('creating','pending','review')) THEN RAISE EXCEPTION 'refund exceeds available balance or another request is unresolved' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.amount_paise>p.amount_paise THEN RAISE EXCEPTION 'refund exceeds original payment' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cashfree_refund_guard BEFORE INSERT OR UPDATE ON cashfree_refunds FOR EACH ROW EXECUTE FUNCTION cashfree_refund_guard();
CREATE FUNCTION refund_entry_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r public.cashfree_refunds%ROWTYPE; total bigint; paid integer;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'refund ledger is append only' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM public.bills WHERE id=NEW.bill_id FOR UPDATE;
 SELECT * INTO r FROM public.cashfree_refunds WHERE id=NEW.refund_id AND organisation_id=NEW.organisation_id AND bill_id=NEW.bill_id AND payment_id=NEW.payment_id AND amount_paise=NEW.amount_paise AND status='succeeded';
 IF current_user<>'dhc_payments' OR NOT FOUND THEN RAISE EXCEPTION 'refund ledger requires verified internal processing' USING ERRCODE='23514'; END IF;
 SELECT amount_paise INTO paid FROM public.payments WHERE id=NEW.payment_id;
 SELECT coalesce(sum(amount_paise),0) INTO total FROM public.refund_entries WHERE payment_id=NEW.payment_id;
 IF total+NEW.amount_paise>paid THEN RAISE EXCEPTION 'refund ledger exceeds original payment' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER refund_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON refund_entries FOR EACH ROW EXECUTE FUNCTION refund_entry_guard();
CREATE FUNCTION cashfree_refund_event_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.cashfree_orders WHERE id=NEW.order_id AND organisation_id=NEW.organisation_id) THEN RAISE EXCEPTION 'refund event tenant mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cashfree_refund_event_guard BEFORE INSERT ON cashfree_refund_events FOR EACH ROW EXECUTE FUNCTION cashfree_refund_event_guard();
-- A confirmed state must commit with its append-only money entry, never on its own.
CREATE FUNCTION cashfree_refund_has_entry() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.cashfree_refunds WHERE id=NEW.id AND status='succeeded') AND NOT EXISTS(SELECT 1 FROM public.refund_entries WHERE refund_id=NEW.id) THEN RAISE EXCEPTION 'confirmed refund requires a ledger entry' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER cashfree_refund_has_entry AFTER INSERT OR UPDATE ON cashfree_refunds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cashfree_refund_has_entry();
