-- Scheduled cleanup of expired Gmail data (outstanding action B3). Until now,
-- expired proposals were erased only when the same workspace next used Gmail.
-- The knowledge worker calls this sweep on a timer for every workspace. It
-- erases private arguments and keeps the content-free audit (status, hash,
-- operation). A write still executing is left alone for 15 minutes past its
-- approval window so an in-flight send can record its real outcome; after
-- that its worker is gone and the outcome is unknown.
CREATE FUNCTION agentonic.gmail_retention_sweep() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE expired int;stuck int;states int;
BEGIN
 IF agentonic.application_role()<>'agentonic_worker' THEN RAISE insufficient_privilege; END IF;
 UPDATE agentonic.gmail_invocations SET status='expired',arguments_ciphertext=NULL
 WHERE status='pending' AND expires_at<=clock_timestamp();
 GET DIAGNOSTICS expired=ROW_COUNT;
 UPDATE agentonic.gmail_invocations SET status='uncertain',arguments_ciphertext=NULL
 WHERE status='executing' AND expires_at<=clock_timestamp()-interval '15 minutes';
 GET DIAGNOSTICS stuck=ROW_COUNT;
 UPDATE agentonic.gmail_invocations SET arguments_ciphertext=NULL
 WHERE arguments_ciphertext IS NOT NULL AND status NOT IN ('pending','executing') AND expires_at<=clock_timestamp();
 DELETE FROM agentonic.gmail_oauth_states WHERE expires_at<clock_timestamp()-interval '1 hour';
 GET DIAGNOSTICS states=ROW_COUNT;
 RETURN jsonb_build_object('expired',expired,'uncertain',stuck,'oauthStates',states);
END $$;
REVOKE ALL ON FUNCTION agentonic.gmail_retention_sweep() FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer;
GRANT EXECUTE ON FUNCTION agentonic.gmail_retention_sweep() TO agentonic_worker;
