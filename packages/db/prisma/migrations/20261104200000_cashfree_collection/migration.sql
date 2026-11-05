ALTER TYPE "PaymentMode" ADD VALUE 'cashfree';
DO $$ BEGIN CREATE ROLE dhc_payments NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT dhc_app TO dhc_payments;
CREATE TABLE cashfree_orders (
  id uuid PRIMARY KEY, organisation_id uuid NOT NULL REFERENCES organisations(id),
  bill_id uuid NOT NULL REFERENCES bills(id) ON DELETE RESTRICT,
  provider_order_id text NOT NULL UNIQUE, merchant_client_id text NOT NULL,
  environment text NOT NULL CHECK(environment IN ('sandbox','production')),
  amount_paise integer NOT NULL CHECK(amount_paise BETWEEN 100 AND 10000000),
  currency text NOT NULL DEFAULT 'INR' CHECK(currency = 'INR'),
  status text NOT NULL DEFAULT 'creating' CHECK(status IN ('creating','active','closing','paid','expired','terminated','review')),
  request_cipher text NOT NULL, session_cipher text, provider_payment_id text,
  created_by_user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz(3) NOT NULL,
  checked_at timestamptz(3), created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT cashfree_provider_payment_key UNIQUE(merchant_client_id, environment, provider_payment_id),
  CHECK(provider_order_id = 'dhc_' || replace(id::text, '-', '')),
  CHECK(status <> 'paid' OR provider_payment_id IS NOT NULL)
);
CREATE INDEX cashfree_orders_organisation_id_bill_id_idx ON cashfree_orders(organisation_id,bill_id);
CREATE UNIQUE INDEX cashfree_one_open_order ON cashfree_orders(bill_id) WHERE status IN ('creating','active','closing','review');
CREATE TABLE cashfree_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organisation_id uuid NOT NULL REFERENCES organisations(id),
  order_id uuid NOT NULL REFERENCES cashfree_orders(id) ON DELETE RESTRICT,
  provider_payment_id text, amount_paise integer, currency text,
  event_hash text NOT NULL CHECK(length(event_hash) = 64), kind text NOT NULL,
  outcome text NOT NULL, received_at timestamptz(3) NOT NULL DEFAULT now(), UNIQUE(organisation_id,event_hash)
);
ALTER TABLE payments ADD COLUMN cashfree_order_id uuid UNIQUE REFERENCES cashfree_orders(id) ON DELETE RESTRICT;
-- Text comparison avoids using a newly added enum literal before transaction commit.
ALTER TABLE payments ADD CONSTRAINT cashfree_payment_source CHECK ((mode::text = 'cashfree') = (cashfree_order_id IS NOT NULL));
ALTER TABLE cashfree_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashfree_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON cashfree_orders, cashfree_events TO dhc_app;
GRANT INSERT, UPDATE ON cashfree_orders TO dhc_payments;
GRANT INSERT ON cashfree_events TO dhc_payments;
CREATE POLICY tenant_isolation ON cashfree_orders TO dhc_app USING (organisation_id = app_current_organisation_id()) WITH CHECK (organisation_id = app_current_organisation_id());
CREATE POLICY tenant_isolation ON cashfree_events TO dhc_app USING (organisation_id = app_current_organisation_id()) WITH CHECK (organisation_id = app_current_organisation_id());
CREATE FUNCTION auth_cashfree_order(p_id text) RETURNS TABLE(id uuid, organisation_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT c.id, c.organisation_id FROM public.cashfree_orders c WHERE c.provider_order_id = p_id;
$$;
REVOKE EXECUTE ON FUNCTION auth_cashfree_order(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_cashfree_order(text) TO dhc_auth;

CREATE FUNCTION cashfree_order_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.bills WHERE id = NEW.bill_id AND organisation_id = NEW.organisation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'order does not match bill' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id,NEW.organisation_id,NEW.bill_id,NEW.provider_order_id,NEW.merchant_client_id,NEW.environment,NEW.amount_paise,NEW.currency,NEW.created_by_user_id,NEW.expires_at,NEW.request_cipher)
    IS DISTINCT FROM (OLD.id,OLD.organisation_id,OLD.bill_id,OLD.provider_order_id,OLD.merchant_client_id,OLD.environment,OLD.amount_paise,OLD.currency,OLD.created_by_user_id,OLD.expires_at,OLD.request_cipher) THEN
    RAISE EXCEPTION 'payment order identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND (NEW.status <> 'creating' OR NOT EXISTS(SELECT 1 FROM public.bills b WHERE b.id = NEW.bill_id AND b.total_paise - b.paid_paise = NEW.amount_paise)) THEN
    RAISE EXCEPTION 'order does not match balance' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'paid' AND (NEW.status <> 'paid' OR NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id) THEN
    RAISE EXCEPTION 'verified payment cannot regress' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cashfree_order_guard BEFORE INSERT OR UPDATE ON cashfree_orders FOR EACH ROW EXECUTE FUNCTION cashfree_order_guard();
CREATE FUNCTION cashfree_bill_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF current_user = 'dhc_payments' AND (to_jsonb(NEW) - ARRAY['paid_paise','status','revision','updated_at']) = (to_jsonb(OLD) - ARRAY['paid_paise','status','revision','updated_at']) THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM public.cashfree_orders o WHERE o.bill_id = OLD.id AND o.status IN ('creating','active','closing','review')) THEN
    RAISE EXCEPTION 'check or close the online payment before changing this bill' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cashfree_bill_guard BEFORE UPDATE ON bills FOR EACH ROW EXECUTE FUNCTION cashfree_bill_guard();
CREATE FUNCTION cashfree_line_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE target uuid;
BEGIN
  target := CASE WHEN TG_OP = 'INSERT' THEN NEW.bill_id ELSE OLD.bill_id END;
  PERFORM 1 FROM public.bills WHERE id = target FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.cashfree_orders o WHERE o.bill_id IN (OLD.bill_id,NEW.bill_id) AND o.status IN ('creating','active','closing','review')) THEN
    RAISE EXCEPTION 'bill has an open online payment' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cashfree_line_guard BEFORE INSERT OR UPDATE OR DELETE ON bill_items FOR EACH ROW EXECUTE FUNCTION cashfree_line_guard();
CREATE FUNCTION cashfree_payment_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.bills WHERE id = NEW.bill_id FOR UPDATE;
  IF NEW.mode::text = 'cashfree' THEN
    IF current_user <> 'dhc_payments' OR NOT EXISTS(SELECT 1 FROM public.cashfree_orders o WHERE o.id = NEW.cashfree_order_id AND o.organisation_id = NEW.organisation_id AND o.bill_id = NEW.bill_id AND o.status = 'paid' AND o.amount_paise = NEW.amount_paise AND o.provider_payment_id = NEW.reference) THEN
      RAISE EXCEPTION 'online receipt requires verified internal processing' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW.mode::text <> 'cashfree' AND EXISTS(SELECT 1 FROM public.cashfree_orders o WHERE o.bill_id = NEW.bill_id AND o.status IN ('creating','active','closing','review')) THEN
    RAISE EXCEPTION 'bill has an open online payment' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cashfree_payment_guard BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION cashfree_payment_guard();
CREATE FUNCTION cashfree_event_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.cashfree_orders o WHERE o.id = NEW.order_id AND o.organisation_id = NEW.organisation_id) THEN RAISE EXCEPTION 'event tenant mismatch' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cashfree_event_guard BEFORE INSERT ON cashfree_events FOR EACH ROW EXECUTE FUNCTION cashfree_event_guard();
