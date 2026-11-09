-- Numeric Meta rejection codes only. Keep the two-argument function for older images.
CREATE FUNCTION auth_fail_whatsapp_delivery(p_id uuid, p_at timestamptz, p_error integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_error IS NOT NULL AND p_error < 0 THEN
    RAISE EXCEPTION 'Invalid provider error code' USING ERRCODE = '23514';
  END IF;
  UPDATE public.whatsapp_deliveries
  SET status = 'submission_failed', last_status_at = p_at, error_code = p_error
  WHERE id = p_id AND kind = 'otp' AND otp_challenge_id IS NOT NULL
    AND status IN ('pending', 'accepted');
END $$;
REVOKE EXECUTE ON FUNCTION auth_fail_whatsapp_delivery(uuid, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_fail_whatsapp_delivery(uuid, timestamptz, integer) TO dhc_auth;
