CREATE TABLE cashfree_recon_runs (
 id uuid PRIMARY KEY,organisation_id uuid NOT NULL REFERENCES organisations(id),merchant_client_id text NOT NULL,
 environment text NOT NULL CHECK(environment IN ('sandbox','production')),from_date date NOT NULL,to_date date NOT NULL,
 nightly_key text,requested_by_user_id uuid REFERENCES users(id),status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),lease_token uuid,lease_until timestamptz(3),dispatch_lease_at timestamptz(3),retry_at timestamptz(3),
 error_code text CHECK(error_code IN ('provider_unavailable','invalid_report','limit_exceeded','binding_changed','processing_failed')),
 event_count integer NOT NULL DEFAULT 0 CHECK(event_count>=0),settlement_count integer NOT NULL DEFAULT 0 CHECK(settlement_count>=0),mismatch_count integer NOT NULL DEFAULT 0 CHECK(mismatch_count>=0),
 created_at timestamptz(3) NOT NULL DEFAULT now(),started_at timestamptz(3),completed_at timestamptz(3),
 CHECK(to_date>=from_date AND to_date-from_date<=30),CHECK(status<>'succeeded' OR completed_at IS NOT NULL),CHECK((lease_token IS NULL)=(lease_until IS NULL)),CHECK((status='running')=(lease_token IS NOT NULL)),
 CONSTRAINT cashfree_recon_nightly_key UNIQUE(organisation_id,merchant_client_id,environment,nightly_key)
);
CREATE INDEX cashfree_recon_runs_organisation_id_created_at_idx ON cashfree_recon_runs(organisation_id,created_at);
CREATE UNIQUE INDEX cashfree_recon_open_period ON cashfree_recon_runs(organisation_id,merchant_client_id,environment,from_date,to_date) WHERE status IN ('queued','running');
CREATE TABLE cashfree_recon_settlements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),run_id uuid NOT NULL REFERENCES cashfree_recon_runs(id) ON DELETE RESTRICT,organisation_id uuid NOT NULL REFERENCES organisations(id),settlement_id text NOT NULL,status text NOT NULL,utr text,
 charging_basis text NOT NULL,gross_paise bigint NOT NULL,fees_paise bigint NOT NULL,tax_paise bigint NOT NULL,adjustment_paise bigint NOT NULL,net_paise bigint NOT NULL,UNIQUE(run_id,settlement_id)
);
CREATE TABLE cashfree_recon_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),run_id uuid NOT NULL REFERENCES cashfree_recon_runs(id) ON DELETE RESTRICT,organisation_id uuid NOT NULL REFERENCES organisations(id),
 direction text,stream text NOT NULL CHECK(stream IN ('pg','settlement')),event_key text NOT NULL,kind text NOT NULL,provider_event_id text NOT NULL,status text,
 order_reference text,payment_reference text,refund_reference text,settlement_id text,currency text,amount_paise bigint,fees_paise bigint,tax_paise bigint,net_paise bigint,
 UNIQUE(run_id,stream,event_key)
);
CREATE TABLE cashfree_recon_issues (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),run_id uuid NOT NULL REFERENCES cashfree_recon_runs(id) ON DELETE RESTRICT,organisation_id uuid NOT NULL REFERENCES organisations(id),
 issue_key text NOT NULL,code text NOT NULL,severity text NOT NULL CHECK(severity IN ('attention','info')),provider_reference text,settlement_id text,order_id uuid,payment_id uuid,appointment_id uuid,expected_paise bigint,reported_paise bigint,
 reviewed_at timestamptz(3),reviewed_by_user_id uuid REFERENCES users(id),review_reason text CHECK(review_reason IN ('timing_difference','fees_explained','external_transaction','contacted_provider','other')),
 CHECK(order_id IS NOT NULL OR (payment_id IS NULL AND appointment_id IS NULL)),
 CHECK((reviewed_at IS NULL)=(reviewed_by_user_id IS NULL) AND (reviewed_at IS NULL)=(review_reason IS NULL)),UNIQUE(run_id,issue_key)
);
ALTER TABLE cashfree_recon_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashfree_recon_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashfree_recon_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashfree_recon_issues ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON cashfree_recon_runs,cashfree_recon_settlements,cashfree_recon_events,cashfree_recon_issues TO dhc_app;
GRANT INSERT,UPDATE ON cashfree_recon_runs,cashfree_recon_issues TO dhc_payments;
GRANT INSERT ON cashfree_recon_settlements,cashfree_recon_events TO dhc_payments;
CREATE POLICY tenant_isolation ON cashfree_recon_runs TO dhc_app USING(organisation_id=app_current_organisation_id()) WITH CHECK(organisation_id=app_current_organisation_id());
CREATE POLICY tenant_isolation ON cashfree_recon_settlements TO dhc_app USING(organisation_id=app_current_organisation_id()) WITH CHECK(organisation_id=app_current_organisation_id());
CREATE POLICY tenant_isolation ON cashfree_recon_events TO dhc_app USING(organisation_id=app_current_organisation_id()) WITH CHECK(organisation_id=app_current_organisation_id());
CREATE POLICY tenant_isolation ON cashfree_recon_issues TO dhc_app USING(organisation_id=app_current_organisation_id()) WITH CHECK(organisation_id=app_current_organisation_id());
CREATE FUNCTION cashfree_recon_run_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.status='succeeded' OR (NEW.id,NEW.organisation_id,NEW.merchant_client_id,NEW.environment,NEW.from_date,NEW.to_date,NEW.nightly_key,NEW.requested_by_user_id) IS DISTINCT FROM (OLD.id,OLD.organisation_id,OLD.merchant_client_id,OLD.environment,OLD.from_date,OLD.to_date,OLD.nightly_key,OLD.requested_by_user_id) THEN RAISE EXCEPTION 'reconciliation identity and completed snapshots are immutable' USING ERRCODE='23514';END IF;
 ELSIF NEW.status<>'queued' OR NEW.attempts<>0 THEN RAISE EXCEPTION 'reconciliation must start queued' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cashfree_recon_run_guard BEFORE INSERT OR UPDATE ON cashfree_recon_runs FOR EACH ROW EXECUTE FUNCTION cashfree_recon_run_guard();
CREATE FUNCTION cashfree_recon_result_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME<>'cashfree_recon_issues' OR (to_jsonb(NEW)-ARRAY['reviewed_at','reviewed_by_user_id','review_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['reviewed_at','reviewed_by_user_id','review_reason']) OR NOT EXISTS(SELECT 1 FROM public.cashfree_recon_runs WHERE id=NEW.run_id AND status='succeeded' AND organisation_id=NEW.organisation_id) THEN RAISE EXCEPTION 'published reconciliation data is immutable' USING ERRCODE='23514';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.cashfree_recon_runs WHERE id=NEW.run_id AND organisation_id=NEW.organisation_id AND status='running') THEN RAISE EXCEPTION 'reconciliation result tenant or run state mismatch' USING ERRCODE='23514';END IF;
 END IF;
 IF TG_TABLE_NAME='cashfree_recon_issues' THEN
 IF NEW.order_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.cashfree_orders o JOIN public.bills b ON b.id=o.bill_id WHERE o.id=NEW.order_id AND o.organisation_id=NEW.organisation_id AND b.appointment_id IS NOT DISTINCT FROM NEW.appointment_id AND (NEW.payment_id IS NULL OR EXISTS(SELECT 1 FROM public.payments p WHERE p.id=NEW.payment_id AND p.cashfree_order_id=o.id))) THEN RAISE EXCEPTION 'reconciliation issue source mismatch' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cashfree_recon_settlement_guard BEFORE INSERT ON cashfree_recon_settlements FOR EACH ROW EXECUTE FUNCTION cashfree_recon_result_guard();
CREATE TRIGGER cashfree_recon_event_guard BEFORE INSERT ON cashfree_recon_events FOR EACH ROW EXECUTE FUNCTION cashfree_recon_result_guard();
CREATE TRIGGER cashfree_recon_issue_guard BEFORE INSERT OR UPDATE ON cashfree_recon_issues FOR EACH ROW EXECUTE FUNCTION cashfree_recon_result_guard();
