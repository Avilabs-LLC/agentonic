BEGIN;
-- Stopped and superseded deployments must scrub content too; costs remain.
CREATE OR REPLACE FUNCTION agentonic.deployment_host(operation text,target_id uuid,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h agentonic.runtime_hosts;d agentonic.deployments;manifest jsonb;result jsonb;
BEGIN
 SELECT * INTO h FROM agentonic.runtime_hosts WHERE database_role=agentonic.application_role() AND broker_sha256=payload->>'brokerHash' AND revoked_at IS NULL AND verified_at>clock_timestamp()-interval '7 days';
 IF h.id IS NULL THEN RAISE insufficient_privilege; END IF;
 IF operation='poll' THEN
  UPDATE agentonic.runtime_hosts SET heartbeat_at=clock_timestamp() WHERE id=h.id;
  FOR d IN SELECT * FROM agentonic.deployments WHERE host_id=h.id AND status IN ('awaiting_activation','queued','preparing','running') LOOP
   PERFORM 1 FROM agentonic.workspaces WHERE id=d.workspace_id FOR SHARE;
   SELECT * INTO d FROM agentonic.deployments WHERE id=d.id FOR UPDATE;
   IF NOT agentonic.deployment_authorized(d) OR (d.status IN ('queued','preparing') AND NOT agentonic.deployment_activation_allowed(d)) THEN
    UPDATE agentonic.deployments SET desired_state='stopped',status='stopped',service_token_sha256=NULL,error_code='authorization_changed' WHERE id=d.id;
    UPDATE agentonic.agent_environments SET current_deployment_id=NULL WHERE current_deployment_id=d.id;
   END IF;
  END LOOP;
  -- Content cleanup is independent of service liveness. Reads enforce the same boundary immediately.
  UPDATE agentonic.staging_turns t SET query='',answer=NULL,matches='[]',citations='[]',scrubbed_at=clock_timestamp(),
   status=CASE WHEN t.status IN ('queued','running') THEN 'cancelled' ELSE t.status END,lease_token=NULL,lease_until=NULL
  FROM agentonic.staging_conversations c JOIN agentonic.deployments dep ON dep.id=c.deployment_id
  WHERE t.conversation_id=c.id AND dep.host_id=h.id AND t.scrubbed_at IS NULL
   AND (c.closed_at IS NOT NULL OR c.expires_at<=clock_timestamp() OR NOT agentonic.deployment_authorized(dep) OR NOT agentonic.staging_conversation_authorized(c));
  UPDATE agentonic.staging_conversations c SET title='Conversación cerrada' FROM agentonic.deployments dep WHERE dep.id=c.deployment_id AND dep.host_id=h.id AND (c.closed_at IS NOT NULL OR c.expires_at<=clock_timestamp() OR NOT agentonic.deployment_authorized(dep) OR NOT agentonic.staging_conversation_authorized(c));
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'workspaceId',workspace_id,'agentId',agent_id,'environment',environment,'status',status,'desired',desired_state,'heartbeatAt',heartbeat_at) ORDER BY created_at),'[]') INTO result
   FROM agentonic.deployments WHERE host_id=h.id;
  RETURN jsonb_build_object('ok',true,'deployments',result);
 END IF;
 SELECT * INTO d FROM agentonic.deployments WHERE id=target_id AND host_id=h.id;
 IF d.id IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=d.workspace_id FOR SHARE;
 SELECT * INTO d FROM agentonic.deployments WHERE id=target_id FOR UPDATE;
 IF operation='fail' THEN
  IF d.status IN ('queued','preparing') THEN
   UPDATE agentonic.deployments SET status='failed',desired_state='stopped',service_token_sha256=NULL,error_code='installation_failed' WHERE id=d.id;
  END IF;
  RETURN '{"ok":true}';
 ELSIF operation='prepare' THEN
  IF d.status<>'queued' OR d.desired_state<>'running' OR NOT agentonic.deployment_authorized(d) OR NOT agentonic.deployment_activation_allowed(d)
   OR payload->>'tokenHash' IS NULL OR payload->>'tokenHash' !~ '^[a-f0-9]{64}$' THEN RAISE insufficient_privilege; END IF;
  manifest:=agentonic.deployment_manifest(d);
  UPDATE agentonic.deployments SET status='preparing',generation=generation+1,service_token_sha256=payload->>'tokenHash',manifest_sha256=agentonic.content_hash(manifest),heartbeat_at=clock_timestamp() WHERE id=d.id;
  RETURN jsonb_build_object('ok',true,'manifest',manifest,'manifestJson',manifest::text,'manifestHash',agentonic.content_hash(manifest),
   'configurationJson',(SELECT content::text FROM agentonic.configuration_releases WHERE id=d.configuration_release_id),'configuration',(SELECT content FROM agentonic.configuration_releases WHERE id=d.configuration_release_id));
 END IF;
 RAISE insufficient_privilege;
END $$;

COMMIT;
