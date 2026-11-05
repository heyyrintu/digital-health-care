-- No OTP, recipient phone, provider error text or raw webhook body is stored here.
CREATE TABLE whatsapp_deliveries (
  id uuid PRIMARY KEY,
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT,
  otp_challenge_id uuid NOT NULL UNIQUE REFERENCES otp_challenges(id) ON DELETE RESTRICT,
  sender_phone_number_id text NOT NULL CHECK (sender_phone_number_id ~ '^[0-9]+$'),
  provider_message_id text CHECK (length(provider_message_id) BETWEEN 1 AND 512),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending', 'accepted', 'submission_failed', 'sent', 'delivered', 'read', 'failed')),
  last_status_at timestamptz(3) NOT NULL,
  error_code integer,
  created_at timestamptz(3) NOT NULL,
  UNIQUE(sender_phone_number_id, provider_message_id)
);
CREATE INDEX whatsapp_deliveries_organisation_id_created_at_id_idx
  ON whatsapp_deliveries(organisation_id, created_at, id);
CREATE TABLE whatsapp_status_events (
  id uuid PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES whatsapp_deliveries(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  occurred_at timestamptz(3) NOT NULL,
  error_code integer,
  received_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_enqueued_at timestamptz(3),
  processed_at timestamptz(3),
  UNIQUE(delivery_id, status, occurred_at)
);
CREATE INDEX whatsapp_status_events_processed_at_last_enqueued_at_idx
  ON whatsapp_status_events(processed_at, last_enqueued_at);

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dhc_messaging') THEN
    CREATE ROLE dhc_messaging NOLOGIN;
  END IF;
END $$;
GRANT dhc_messaging TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO dhc_messaging;
-- The callback and worker role can only call the restricted functions below.
REVOKE ALL ON whatsapp_deliveries, whatsapp_status_events FROM PUBLIC, dhc_auth, dhc_app, dhc_platform, dhc_messaging;
ALTER TABLE whatsapp_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_status_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON whatsapp_deliveries TO dhc_app;
CREATE POLICY tenant_isolation ON whatsapp_deliveries TO dhc_app
  USING (organisation_id = app_current_organisation_id());
-- No application role may select raw inbox rows or write directly to either table.

CREATE FUNCTION auth_create_whatsapp_delivery(p_challenge uuid, p_id uuid, p_sender text, p_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.whatsapp_deliveries(id, organisation_id, otp_challenge_id,
    sender_phone_number_id, last_status_at, created_at)
  SELECT p_id, c.organisation_id, c.id, p_sender, p_at, p_at
  FROM public.otp_challenges c WHERE c.id = p_challenge AND c.consumed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'OTP challenge is unavailable' USING ERRCODE = '23514'; END IF;
END $$;

CREATE FUNCTION auth_accept_whatsapp_delivery(p_id uuid, p_message text, p_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.whatsapp_deliveries%ROWTYPE;
BEGIN
  SELECT * INTO STRICT d FROM public.whatsapp_deliveries WHERE id = p_id FOR UPDATE;
  IF d.provider_message_id IS NOT NULL AND d.provider_message_id <> p_message THEN
    RAISE EXCEPTION 'WhatsApp message does not match' USING ERRCODE = '23514';
  END IF;
  UPDATE public.whatsapp_deliveries SET provider_message_id = p_message,
    status = CASE WHEN status = 'pending' THEN 'accepted' ELSE status END,
    last_status_at = CASE WHEN status = 'pending' THEN p_at ELSE last_status_at END
  WHERE id = p_id;
END $$;

CREATE FUNCTION auth_fail_whatsapp_delivery(p_id uuid, p_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.whatsapp_deliveries SET status = 'submission_failed', last_status_at = p_at
  WHERE id = p_id AND status IN ('pending', 'accepted');
END $$;

-- Routing comes from a known outbound message/correlation ID AND its configured sender.
-- A callback cannot name an organisation; recipient_id is never accepted as a routing key.
CREATE FUNCTION messaging_receive_status(p_id uuid, p_sender text, p_message text,
  p_correlation uuid, p_status text, p_at timestamptz, p_error integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE d public.whatsapp_deliveries%ROWTYPE; result uuid;
BEGIN
  IF p_status NOT IN ('sent', 'delivered', 'read', 'failed') THEN RETURN NULL; END IF;
  SELECT * INTO d FROM public.whatsapp_deliveries
  WHERE sender_phone_number_id = p_sender
    AND (provider_message_id = p_message OR (p_correlation IS NOT NULL AND id = p_correlation))
  ORDER BY (provider_message_id = p_message) DESC NULLS LAST LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR (d.provider_message_id IS NOT NULL AND d.provider_message_id <> p_message)
    OR (p_correlation IS NOT NULL AND d.id <> p_correlation) THEN RETURN NULL; END IF;
  -- A callback may arrive before the sending request records Meta's response.
  UPDATE public.whatsapp_deliveries SET provider_message_id = p_message WHERE id = d.id;
  INSERT INTO public.whatsapp_status_events(id, delivery_id, status, occurred_at, error_code)
  VALUES(p_id, d.id, p_status, p_at, CASE WHEN p_status = 'failed' THEN p_error ELSE NULL END)
  ON CONFLICT (delivery_id, status, occurred_at) DO NOTHING RETURNING id INTO result;
  RETURN result;
END $$;

-- Durable inbox/queue bridge: lease a rotating batch, then publish IDs to BullMQ.
-- A crash or Redis outage loses no receipt: the lease expires after 60 seconds.
CREATE FUNCTION messaging_claim_status_events() RETURNS TABLE(id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  UPDATE public.whatsapp_status_events e SET last_enqueued_at = CURRENT_TIMESTAMP
  WHERE e.id IN (
    SELECT s.id FROM public.whatsapp_status_events s WHERE s.processed_at IS NULL
      AND (s.last_enqueued_at IS NULL OR s.last_enqueued_at < CURRENT_TIMESTAMP - interval '60 seconds')
    ORDER BY s.last_enqueued_at NULLS FIRST, s.received_at, s.id LIMIT 100 FOR UPDATE SKIP LOCKED
  ) RETURNING e.id;
$$;

CREATE FUNCTION messaging_process_status(p_id uuid) RETURNS void
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
    WHEN 'sent' THEN d.status IN ('pending', 'accepted', 'submission_failed')
    WHEN 'failed' THEN d.status IN ('pending', 'accepted', 'submission_failed')
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

REVOKE EXECUTE ON FUNCTION auth_create_whatsapp_delivery(uuid, uuid, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION auth_accept_whatsapp_delivery(uuid, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION auth_fail_whatsapp_delivery(uuid, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION messaging_receive_status(uuid, text, text, uuid, text, timestamptz, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION messaging_claim_status_events() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION messaging_process_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_create_whatsapp_delivery(uuid, uuid, text, timestamptz),
  auth_accept_whatsapp_delivery(uuid, text, timestamptz), auth_fail_whatsapp_delivery(uuid, timestamptz) TO dhc_auth;
GRANT EXECUTE ON FUNCTION messaging_receive_status(uuid, text, text, uuid, text, timestamptz, integer),
  messaging_claim_status_events(), messaging_process_status(uuid) TO dhc_messaging;
