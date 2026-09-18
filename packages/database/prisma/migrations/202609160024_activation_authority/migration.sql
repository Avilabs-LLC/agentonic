BEGIN;
-- A queued activation cannot outlive the current authority of its staff initiator.
-- Already observed running releases use their separate customer operating consent.
CREATE FUNCTION agentonic.deployment_activation_allowed(d agentonic.deployments) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT agentonic.deployment_authorized(d) AND agentonic.version_approval_valid(d.approval_id)
 AND EXISTS(SELECT 1 FROM agentonic.platform_staff st JOIN agentonic.users u ON u.id=st.user_id
 WHERE st.id=d.requested_by_staff_id AND st.disabled_at IS NULL AND st.role IN ('administrator','operator') AND u.deleted_at IS NULL)
$$;
REVOKE ALL ON FUNCTION agentonic.deployment_activation_allowed(agentonic.deployments) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure;
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
   AND (c.closed_at IS NOT NULL OR c.expires_at<=clock_timestamp() OR NOT agentonic.deployment_authorized(dep) OR (dep.status='running' AND NOT agentonic.staging_conversation_authorized(c)));
  UPDATE agentonic.staging_conversations c SET title='Conversación cerrada' FROM agentonic.deployments dep WHERE dep.id=c.deployment_id AND dep.host_id=h.id AND (c.closed_at IS NOT NULL OR c.expires_at<=clock_timestamp() OR NOT agentonic.deployment_authorized(dep) OR (dep.status='running' AND NOT agentonic.staging_conversation_authorized(c)));
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
CREATE OR REPLACE FUNCTION agentonic.deployment_service(operation text,target_id uuid,secret text,payload jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d agentonic.deployments;old_id uuid;
BEGIN
 SELECT * INTO d FROM agentonic.deployments WHERE id=target_id;
 IF d.id IS NULL OR secret IS NULL OR length(secret)<>64 OR d.service_token_sha256 IS DISTINCT FROM encode(sha256(convert_to(secret,'UTF8')),'hex')
  OR NOT EXISTS(SELECT 1 FROM agentonic.runtime_hosts WHERE id=d.host_id AND replace(database_role,'deployer','runtime')=agentonic.application_role()) THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=d.workspace_id FOR UPDATE;
 SELECT * INTO d FROM agentonic.deployments WHERE id=target_id FOR UPDATE;
 IF d.desired_state<>'running' OR d.status NOT IN ('preparing','running') OR NOT agentonic.deployment_authorized(d) THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
 IF operation='ready' THEN
  IF payload->>'manifestHash' IS DISTINCT FROM d.manifest_sha256 THEN RAISE insufficient_privilege; END IF;
  IF d.activated_at IS NULL AND NOT agentonic.deployment_activation_allowed(d) THEN RETURN '{"ok":false,"code":"approval_required"}'; END IF;
  IF d.status='preparing' THEN
   SELECT current_deployment_id INTO old_id FROM agentonic.agent_environments WHERE workspace_id=d.workspace_id AND agent_id=d.agent_id AND environment=d.environment FOR UPDATE;
   UPDATE agentonic.deployments SET status='superseded',desired_state='stopped',service_token_sha256=NULL WHERE id=old_id AND id<>d.id;
   UPDATE agentonic.deployments SET status='running',activated_at=coalesce(activated_at,clock_timestamp()),heartbeat_at=clock_timestamp() WHERE id=d.id;
   INSERT INTO agentonic.agent_environments(workspace_id,agent_id,environment,current_deployment_id) VALUES(d.workspace_id,d.agent_id,d.environment,d.id)
    ON CONFLICT(workspace_id,agent_id,environment) DO UPDATE SET current_deployment_id=excluded.current_deployment_id;
   INSERT INTO agentonic.audit_events(workspace_id,action,resource_type,resource_id,outcome,request_id)
    VALUES(d.workspace_id,'deployment.activated','deployment',d.id::text,'succeeded',gen_random_uuid()::text);
  END IF;
 ELSIF operation<>'heartbeat' THEN RAISE insufficient_privilege;
 END IF;
 UPDATE agentonic.deployments SET heartbeat_at=clock_timestamp() WHERE id=d.id;
 RETURN jsonb_build_object('ok',true);
END $$;
COMMIT;
