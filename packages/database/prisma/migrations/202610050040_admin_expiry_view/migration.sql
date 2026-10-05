BEGIN;
-- Admin expiry view. Staff see three separate deadlines and who renews each:
-- host and evaluator verification (the Agentonic team), a deployment's
-- customer operating consent, and an approval's activation deadline (both the
-- customer's). Read-only. Validity uses the same seven-day rule the services
-- are held to, so the page never shows a renewal that has not happened.
CREATE FUNCTION agentonic.registration_state(verified_at timestamptz,revoked_at timestamptz,retired_at timestamptz) RETURNS text LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN retired_at IS NOT NULL THEN 'retired'
  WHEN verified_at<=clock_timestamp()-interval '7 days' THEN 'expired'
  WHEN verified_at<=clock_timestamp()-interval '6 days' THEN 'expiring' ELSE 'valid' END
$$;
-- Infrastructure metadata only: no workspace, customer content or secrets.
-- Evaluators report their latest registration per role, active first, as
-- staging:reverify does.
CREATE FUNCTION agentonic.runtime_registrations() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF agentonic.application_role()<>'agentonic_admin' OR agentonic.current_staff() IS NULL THEN RAISE insufficient_privilege; END IF;
 RETURN jsonb_build_object(
  'hosts',coalesce((SELECT jsonb_agg(jsonb_build_object('environment',h.environment,'verifiedAt',h.verified_at,'expiresAt',h.verified_at+interval '7 days',
   'state',agentonic.registration_state(h.verified_at,h.revoked_at,NULL)) ORDER BY h.environment) FROM agentonic.runtime_hosts h),'[]'::jsonb),
  'evaluators',coalesce((SELECT jsonb_agg(jsonb_build_object('environment',e.environment,'verifiedAt',e.verified_at,'expiresAt',e.verified_at+interval '7 days',
   'state',agentonic.registration_state(e.verified_at,e.revoked_at,e.retired_at)) ORDER BY e.environment)
   FROM (SELECT DISTINCT ON (database_role) * FROM agentonic.evaluation_workers ORDER BY database_role,(revoked_at IS NULL AND retired_at IS NULL) DESC,created_at DESC) e),'[]'::jsonb));
END $$;
-- The queue also reports the latest deployment's environment, authorization and
-- consent expiry. Everything else is unchanged from migration 23.
CREATE OR REPLACE FUNCTION agentonic.review_queue() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE row jsonb;state jsonb;result jsonb:='[]';approval jsonb;deployment jsonb;
BEGIN
 FOR row IN SELECT value FROM jsonb_array_elements(agentonic.review_queue_before_deployments()) LOOP
  state:=agentonic.lifecycle_state((row->>'id')::uuid);
  SELECT value INTO approval FROM jsonb_array_elements(state->'submissions') WHERE value->>'id'=row->>'id';
  SELECT value INTO deployment FROM jsonb_array_elements(state->'deployments') WHERE value->>'submissionId'=row->>'id' LIMIT 1;
  result:=result||jsonb_build_array(row||jsonb_build_object('approvalReason',approval->>'reason','approvalExpiresAt',approval->'expiresAt',
   'deploymentStatus',coalesce(CASE WHEN deployment->>'status'='running' THEN CASE WHEN deployment->>'online'='true' THEN 'running' ELSE 'offline' END ELSE deployment->>'status' END,'none'))
   ||CASE WHEN deployment IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('deploymentEnvironment',deployment->'environment',
    'deploymentAuthorized',deployment->'authorized','consentExpiresAt',deployment->'expiresAt') END);
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION agentonic.registration_state(timestamptz,timestamptz,timestamptz),agentonic.runtime_registrations()
 FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure,
 agentonic_runtime_local,agentonic_runtime_azure,agentonic_deployer_local,agentonic_deployer_azure;
GRANT EXECUTE ON FUNCTION agentonic.runtime_registrations() TO agentonic_admin;
COMMIT;
