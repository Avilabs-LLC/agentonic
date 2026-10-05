BEGIN;
-- Resting agents. Every activated agent kept a running service that asked the
-- database for work every two seconds, so connections, queries and host memory
-- grew with activated agents instead of with work. A serving copy that has been
-- idle now rests: it records that it stops on purpose, then exits. The host's
-- controller starts it again when a turn waits for it. While that controller
-- keeps reporting, a resting deployment stays available to its chats. Copies
-- reach the database through one gateway per host (architecture section 42),
-- so connections no longer grow with agents either.
ALTER TABLE agentonic.deployments ADD COLUMN resting_since timestamptz;
-- Claims, waiting-turn checks and content cleanup look conversations up by deployment.
CREATE INDEX staging_conversations_deployment_id_idx ON agentonic.staging_conversations(deployment_id);
-- Whether a turn waits for the deployment: what its serving copy would claim next
-- (the conversation check includes the deployment's own authority).
CREATE FUNCTION agentonic.deployment_pending(target uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM agentonic.staging_conversations c JOIN agentonic.staging_turns t ON t.conversation_id=c.id
  WHERE c.deployment_id=target AND t.status='queued' AND agentonic.staging_conversation_authorized(c))
$$;
-- Whether a deployment can take a turn now: its copy reported within the last
-- minute, or it rests on a host whose controller reported within the last
-- minute and will start it for the turn.
CREATE FUNCTION agentonic.deployment_online(d agentonic.deployments) RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT coalesce(d.heartbeat_at>clock_timestamp()-interval '60 seconds',false) OR (d.resting_since IS NOT NULL AND EXISTS(
  SELECT 1 FROM agentonic.runtime_hosts h WHERE h.id=d.host_id AND h.revoked_at IS NULL AND h.verified_at>clock_timestamp()-interval '7 days'
   AND h.heartbeat_at>clock_timestamp()-interval '60 seconds' AND agentonic.broker_live(h.id,d.broker_sha256)))
$$;
REVOKE ALL ON FUNCTION agentonic.deployment_pending(uuid),agentonic.deployment_online(agentonic.deployments) FROM PUBLIC,anon,authenticated,service_role;
-- The functions below change only where a resting deployment differs: the
-- column list of the immutability trigger, the copy's 'rest' operation, the
-- controller's 'watch' and 'wake' operations, and availability checks that
-- now use deployment_online instead of the copy's heartbeat alone.
CREATE OR REPLACE FUNCTION agentonic.deployment_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Deployment history is retained'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','desired_state','service_token_sha256','generation','committed_microusd','requested_by_staff_id','activated_at','heartbeat_at','error_code','manifest_sha256','revoked_at',
  'broker_sha256','successor_broker_sha256','successor_token_sha256','draining_broker_sha256','draining_token_sha256','draining_since','resting_since'])
 IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','desired_state','service_token_sha256','generation','committed_microusd','requested_by_staff_id','activated_at','heartbeat_at','error_code','manifest_sha256','revoked_at',
  'broker_sha256','successor_broker_sha256','successor_token_sha256','draining_broker_sha256','draining_token_sha256','draining_since','resting_since']) THEN RAISE EXCEPTION 'Immutable deployment scope'; END IF;
 IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN RAISE EXCEPTION 'Irreversible deployment revocation'; END IF;
 IF OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN RAISE EXCEPTION 'Immutable activation evidence'; END IF;
 IF OLD.requested_by_staff_id IS NOT NULL AND NEW.requested_by_staff_id IS DISTINCT FROM OLD.requested_by_staff_id THEN RAISE EXCEPTION 'Immutable deployment actor'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION agentonic.deployment_copies_end() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.status NOT IN ('preparing','running') OR NEW.desired_state<>'running' THEN
  NEW.successor_broker_sha256:=NULL;NEW.successor_token_sha256:=NULL;
  NEW.draining_broker_sha256:=NULL;NEW.draining_token_sha256:=NULL;NEW.draining_since:=NULL;NEW.resting_since:=NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION agentonic.deployment_service(operation text,target_id uuid,secret text,payload jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d agentonic.deployments;old_id uuid;slot text;broker text;
BEGIN
 SELECT * INTO d FROM agentonic.deployments WHERE id=target_id;
 IF agentonic.deployment_copy(d,secret) IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=d.workspace_id FOR UPDATE;
 SELECT * INTO d FROM agentonic.deployments WHERE id=target_id FOR UPDATE;
 slot:=agentonic.deployment_copy(d,secret);
 IF slot IS NULL THEN RAISE insufficient_privilege; END IF;
 broker:=CASE slot WHEN 'serving' THEN d.broker_sha256 WHEN 'successor' THEN d.successor_broker_sha256 ELSE d.draining_broker_sha256 END;
 -- Copies report the program they run; a copy started from other bytes is refused.
 IF payload ? 'brokerHash' AND payload->>'brokerHash' IS DISTINCT FROM broker THEN RAISE insufficient_privilege; END IF;
 IF d.desired_state<>'running' OR d.status NOT IN ('preparing','running') OR NOT agentonic.deployment_authorized(d) THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
 IF slot='draining' THEN
  -- A replaced copy finishes the turn it leased, then stops. It is never ready again.
  IF operation='heartbeat' THEN RETURN '{"ok":true,"draining":true}'; END IF;
  RAISE insufficient_privilege;
 END IF;
 IF operation='rest' THEN
  -- An idle serving copy stops on purpose; the controller starts it again when a turn waits.
  IF slot<>'serving' OR d.status<>'running' THEN RAISE insufficient_privilege; END IF;
  IF agentonic.deployment_pending(d.id) THEN RETURN '{"ok":false,"code":"pending"}'; END IF;
  UPDATE agentonic.deployments SET resting_since=clock_timestamp() WHERE id=d.id;
  RETURN jsonb_build_object('ok',true);
 END IF;
 IF operation='ready' THEN
  IF payload->>'manifestHash' IS DISTINCT FROM d.manifest_sha256 THEN RAISE insufficient_privilege; END IF;
  IF slot='successor' THEN
   IF d.status<>'running' THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.deployments SET draining_broker_sha256=broker_sha256,draining_token_sha256=service_token_sha256,draining_since=clock_timestamp(),
    broker_sha256=successor_broker_sha256,service_token_sha256=successor_token_sha256,successor_broker_sha256=NULL,successor_token_sha256=NULL,
    generation=generation+1,heartbeat_at=clock_timestamp(),resting_since=NULL WHERE id=d.id;
   INSERT INTO agentonic.audit_events(workspace_id,action,resource_type,resource_id,outcome,request_id)
    VALUES(d.workspace_id,'deployment.broker_moved','deployment',d.id::text,'succeeded',gen_random_uuid()::text);
   RETURN jsonb_build_object('ok',true);
  END IF;
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
 -- A starting successor's heartbeat says nothing about the serving copy.
 ELSIF slot='successor' THEN RETURN jsonb_build_object('ok',true);
 END IF;
 UPDATE agentonic.deployments SET heartbeat_at=clock_timestamp(),resting_since=NULL WHERE id=d.id;
 RETURN jsonb_build_object('ok',true);
END $$;
CREATE OR REPLACE FUNCTION agentonic.deployment_host(operation text,target_id uuid,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h agentonic.runtime_hosts;d agentonic.deployments;manifest jsonb;result jsonb;brokers jsonb;
BEGIN
 SELECT * INTO h FROM agentonic.runtime_hosts WHERE database_role=agentonic.application_role() AND broker_sha256=payload->>'brokerHash' AND revoked_at IS NULL AND verified_at>clock_timestamp()-interval '7 days';
 IF h.id IS NULL OR NOT agentonic.broker_live(h.id,h.broker_sha256) THEN RAISE insufficient_privilege; END IF;
 -- 'poll' is the full pass: authority of every active deployment, content cleanup
 -- and broker retirement. 'watch' runs between polls: it rechecks deployments still
 -- starting and lists only active ones, so its cost does not grow with history.
 IF operation IN ('poll','watch') THEN
  UPDATE agentonic.runtime_hosts SET heartbeat_at=clock_timestamp() WHERE id=h.id;
  FOR d IN SELECT * FROM agentonic.deployments WHERE host_id=h.id AND status IN ('awaiting_activation','queued','preparing','running')
   AND (operation='poll' OR status IN ('queued','preparing')) LOOP
   PERFORM 1 FROM agentonic.workspaces WHERE id=d.workspace_id FOR SHARE;
   SELECT * INTO d FROM agentonic.deployments WHERE id=d.id FOR UPDATE;
   IF NOT agentonic.deployment_authorized(d) OR (d.status IN ('queued','preparing') AND NOT agentonic.deployment_activation_allowed(d)) THEN
    UPDATE agentonic.deployments SET desired_state='stopped',status='stopped',service_token_sha256=NULL,error_code='authorization_changed' WHERE id=d.id;
    UPDATE agentonic.agent_environments SET current_deployment_id=NULL WHERE current_deployment_id=d.id;
   END IF;
  END LOOP;
  IF operation='poll' THEN
  -- Content cleanup is independent of service liveness. Reads enforce the same boundary immediately.
  UPDATE agentonic.staging_turns t SET query='',answer=NULL,matches='[]',citations='[]',scrubbed_at=clock_timestamp(),
   status=CASE WHEN t.status IN ('queued','running') THEN 'cancelled' ELSE t.status END,lease_token=NULL,lease_until=NULL
  FROM agentonic.staging_conversations c JOIN agentonic.deployments dep ON dep.id=c.deployment_id
  WHERE t.conversation_id=c.id AND dep.host_id=h.id AND t.scrubbed_at IS NULL
   AND (c.closed_at IS NOT NULL OR c.expires_at<=clock_timestamp() OR NOT agentonic.deployment_authorized(dep) OR NOT agentonic.staging_conversation_authorized(c));
  UPDATE agentonic.staging_conversations c SET title='Conversación cerrada' FROM agentonic.deployments dep WHERE dep.id=c.deployment_id AND dep.host_id=h.id AND (c.closed_at IS NOT NULL OR c.expires_at<=clock_timestamp() OR NOT agentonic.deployment_authorized(dep) OR NOT agentonic.staging_conversation_authorized(c));
  -- Normal succession: an earlier broker no copy runs any longer retires.
  UPDATE agentonic.runtime_host_brokers b SET retired_at=clock_timestamp() WHERE b.host_id=h.id AND b.broker_sha256<>h.broker_sha256 AND b.retired_at IS NULL AND b.revoked_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM agentonic.deployments dep WHERE dep.host_id=h.id AND dep.status IN ('preparing','running')
    AND b.broker_sha256 IN (dep.broker_sha256,dep.successor_broker_sha256,dep.draining_broker_sha256));
  END IF;
  -- A resting deployment runs no copy; 'pending' tells the controller a turn waits for one.
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',dep.id,'workspaceId',dep.workspace_id,'agentId',dep.agent_id,'environment',dep.environment,'status',dep.status,'desired',dep.desired_state,'heartbeatAt',dep.heartbeat_at,
   'broker',dep.broker_sha256,'successorBroker',dep.successor_broker_sha256,'drainingBroker',dep.draining_broker_sha256,'drainingSince',dep.draining_since,'resting',dep.resting_since IS NOT NULL,
   'pending',CASE WHEN dep.status='running' AND dep.desired_state='running' THEN agentonic.deployment_pending(dep.id) ELSE false END) ORDER BY dep.created_at),'[]') INTO result
   FROM agentonic.deployments dep WHERE dep.host_id=h.id AND (operation='poll' OR dep.status IN ('queued','preparing','running'));
  SELECT coalesce(jsonb_agg(jsonb_build_object('sha256',broker_sha256,'live',retired_at IS NULL AND revoked_at IS NULL) ORDER BY installed_at),'[]') INTO brokers
   FROM agentonic.runtime_host_brokers WHERE host_id=h.id;
  RETURN jsonb_build_object('ok',true,'deployments',result,'brokers',brokers);
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
  UPDATE agentonic.deployments SET status='preparing',generation=generation+1,service_token_sha256=payload->>'tokenHash',broker_sha256=h.broker_sha256,
   manifest_sha256=agentonic.content_hash(manifest),heartbeat_at=clock_timestamp() WHERE id=d.id;
  RETURN jsonb_build_object('ok',true,'manifest',manifest,'manifestJson',manifest::text,'manifestHash',agentonic.content_hash(manifest),
   'configurationJson',(SELECT content::text FROM agentonic.configuration_releases WHERE id=d.configuration_release_id),'configuration',(SELECT content FROM agentonic.configuration_releases WHERE id=d.configuration_release_id));
 ELSIF operation IN ('move','restore') THEN
  -- A running deployment gets a new copy on the current broker from the same
  -- frozen manifest. 'move' keeps the serving copy until the successor is
  -- ready (one move per host at a time); 'restore' replaces a copy that can no
  -- longer run (its broker was revoked or its installation is gone) at once.
  IF d.status<>'running' OR d.desired_state<>'running' OR NOT agentonic.deployment_authorized(d)
   OR payload->>'tokenHash' IS NULL OR payload->>'tokenHash' !~ '^[a-f0-9]{64}$' THEN RAISE insufficient_privilege; END IF;
  manifest:=agentonic.deployment_manifest(d);
  IF agentonic.content_hash(manifest) IS DISTINCT FROM d.manifest_sha256 THEN RAISE insufficient_privilege; END IF;
  IF operation='move' THEN
   IF d.broker_sha256 IS NULL OR d.broker_sha256=h.broker_sha256 OR d.successor_token_sha256 IS NOT NULL OR d.draining_token_sha256 IS NOT NULL
    OR EXISTS(SELECT 1 FROM agentonic.deployments other WHERE other.host_id=h.id AND other.id<>d.id AND other.successor_token_sha256 IS NOT NULL) THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.deployments SET successor_broker_sha256=h.broker_sha256,successor_token_sha256=payload->>'tokenHash' WHERE id=d.id;
  ELSE
   UPDATE agentonic.deployments SET service_token_sha256=payload->>'tokenHash',broker_sha256=h.broker_sha256,generation=generation+1,
    successor_broker_sha256=NULL,successor_token_sha256=NULL,draining_broker_sha256=NULL,draining_token_sha256=NULL,draining_since=NULL,resting_since=NULL WHERE id=d.id;
   INSERT INTO agentonic.audit_events(workspace_id,action,resource_type,resource_id,outcome,request_id)
    VALUES(d.workspace_id,'deployment.restored','deployment',d.id::text,'succeeded',gen_random_uuid()::text);
  END IF;
  RETURN jsonb_build_object('ok',true,'manifest',manifest,'manifestJson',manifest::text,'manifestHash',agentonic.content_hash(manifest),
   'configurationJson',(SELECT content::text FROM agentonic.configuration_releases WHERE id=d.configuration_release_id),'configuration',(SELECT content FROM agentonic.configuration_releases WHERE id=d.configuration_release_id));
 ELSIF operation='wake' THEN
  -- The controller starts a resting copy for a waiting turn and vouches for it for one
  -- heartbeat interval. A copy that never reports goes offline like any silent copy.
  IF d.status<>'running' OR d.desired_state<>'running' THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.deployments SET resting_since=NULL,heartbeat_at=clock_timestamp() WHERE id=d.id AND resting_since IS NOT NULL;
  RETURN '{"ok":true}';
 ELSIF operation='abandon' THEN
  -- The successor did not become ready; the serving copy keeps serving.
  UPDATE agentonic.deployments SET successor_broker_sha256=NULL,successor_token_sha256=NULL WHERE id=d.id;
  RETURN '{"ok":true}';
 ELSIF operation='drained' THEN
  UPDATE agentonic.deployments SET draining_broker_sha256=NULL,draining_token_sha256=NULL,draining_since=NULL WHERE id=d.id;
  RETURN '{"ok":true}';
 END IF;
 RAISE insufficient_privilege;
END $$;
CREATE OR REPLACE FUNCTION agentonic.staging_chat(operation text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();c agentonic.staging_conversations;d agentonic.deployments;t agentonic.staging_turns;n integer;items jsonb;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR w IS NULL OR m IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 IF operation='list' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',c1.id,'agentId',c1.agent_id,'agentName',a.name,'deploymentId',c1.deployment_id,'title',c1.title,'expiresAt',c1.expires_at) ORDER BY c1.created_at DESC),'[]') INTO items
   FROM agentonic.staging_conversations c1 JOIN agentonic.agents a ON a.id=c1.agent_id WHERE c1.workspace_id=w AND c1.owner_member_id=m AND agentonic.staging_conversation_authorized(c1) AND agentonic.can_agent(c1.agent_id,'invoke');
  RETURN jsonb_build_object('ok',true,'conversations',items,'agents',coalesce((SELECT jsonb_agg(jsonb_build_object('id',dep.id,'agentId',dep.agent_id,'name',a.name,'environment',dep.environment)) FROM agentonic.deployments dep JOIN agentonic.agents a ON a.id=dep.agent_id WHERE dep.workspace_id=w AND dep.authorized_by_member_id=m AND dep.status='running' AND agentonic.deployment_online(dep) AND agentonic.deployment_authorized(dep) AND agentonic.can_agent(dep.agent_id,'invoke')),'[]'::jsonb));
 ELSIF operation='start' THEN
  SELECT * INTO d FROM agentonic.deployments WHERE id=(payload->>'deploymentId')::uuid AND workspace_id=w AND authorized_by_member_id=m;
  IF d.id IS NULL OR d.status<>'running' OR NOT agentonic.deployment_online(d) OR NOT agentonic.deployment_authorized(d) OR NOT agentonic.can_agent(d.agent_id,'invoke') THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
  IF (SELECT count(*) FROM agentonic.staging_conversations WHERE owner_member_id=m AND created_at>clock_timestamp()-interval '1 minute')>=5 THEN RETURN '{"ok":false,"code":"rate_limit"}'; END IF;
  INSERT INTO agentonic.staging_conversations(workspace_id,agent_id,deployment_id,owner_member_id,title,expires_at)
   VALUES(w,d.agent_id,d.id,m,btrim(payload->>'title'),least(d.authorized_until,clock_timestamp()+least(7,(SELECT (retention_policy->>'conversationsDays')::int FROM agentonic.workspaces WHERE id=w))*interval '1 day')) RETURNING * INTO c;
  RETURN jsonb_build_object('ok',true,'id',c.id);
 END IF;
 SELECT * INTO c FROM agentonic.staging_conversations WHERE id=(payload->>'conversationId')::uuid AND workspace_id=w AND owner_member_id=m FOR UPDATE;
 IF c.id IS NULL OR NOT agentonic.can_agent(c.agent_id,'invoke') THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
 IF operation='close' THEN
  UPDATE agentonic.staging_conversations SET closed_at=clock_timestamp() WHERE id=c.id;
  UPDATE agentonic.staging_turns SET query='',answer=NULL,citations='[]',matches='[]',scrubbed_at=clock_timestamp(),status=CASE WHEN status IN ('queued','running') THEN 'cancelled' ELSE status END,lease_token=NULL,lease_until=NULL WHERE conversation_id=c.id;
  RETURN '{"ok":true}';
 END IF;
 IF NOT agentonic.staging_conversation_authorized(c) THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
 SELECT * INTO d FROM agentonic.deployments WHERE id=c.deployment_id;
 IF operation='turn' THEN
  payload:=jsonb_build_object('model',agentonic.deployment_models(d)->0->>'model','reasoning',agentonic.deployment_models(d)->0->'reasoning')||payload;
  IF NOT agentonic.deployment_models(d) @> jsonb_build_array(jsonb_build_object('model',payload->>'model','reasoning',payload->'reasoning')) THEN RAISE insufficient_privilege; END IF;
  IF NOT agentonic.deployment_online(d) THEN RETURN '{"ok":false,"code":"offline"}'; END IF;
  SELECT * INTO t FROM agentonic.staging_turns WHERE conversation_id=c.id AND request_id=(payload->>'requestId')::uuid;
  IF t.id IS NOT NULL THEN
   IF t.query IS DISTINCT FROM btrim(payload->>'query') OR t.response_model IS DISTINCT FROM payload->>'model' OR t.reasoning_effort IS DISTINCT FROM payload->>'reasoning' THEN RETURN '{"ok":false,"code":"request_conflict"}'; END IF;
   RETURN jsonb_build_object('ok',true,'id',t.id); END IF;
  IF EXISTS(SELECT 1 FROM agentonic.staging_turns WHERE conversation_id=c.id AND status IN ('queued','running')) THEN RETURN '{"ok":false,"code":"busy"}'; END IF;
  IF length(btrim(payload->>'query')) NOT BETWEEN 1 AND 1000 OR payload->>'query' IS NULL THEN RAISE insufficient_privilege; END IF;
  SELECT coalesce(max(number),0)+1 INTO n FROM agentonic.staging_turns WHERE conversation_id=c.id;
  IF n>100 THEN RETURN '{"ok":false,"code":"turn_limit"}'; END IF;
  IF (SELECT count(*) FROM agentonic.staging_turns t1 JOIN agentonic.staging_conversations c1 ON c1.id=t1.conversation_id WHERE c1.owner_member_id=m AND t1.created_at>clock_timestamp()-interval '1 minute')>=10 THEN RETURN '{"ok":false,"code":"rate_limit"}'; END IF;
  INSERT INTO agentonic.staging_turns(workspace_id,conversation_id,request_id,number,query,response_model,reasoning_effort) VALUES(w,c.id,(payload->>'requestId')::uuid,n,btrim(payload->>'query'),payload->>'model',payload->>'reasoning') RETURNING * INTO t;
  RETURN jsonb_build_object('ok',true,'id',t.id);
 ELSIF operation='state' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'number',number,'model',response_model,'reasoning',reasoning_effort,'query',query,'answer',answer,'citations',citations,'status',status,'errorCode',error_code) ORDER BY number),'[]') INTO items FROM agentonic.staging_turns WHERE conversation_id=c.id;
  RETURN jsonb_build_object('ok',true,'id',c.id,'title',c.title,'agentId',c.agent_id,'expiresAt',c.expires_at,'online',agentonic.deployment_online(d),'budgetUsd',d.budget_usd,'committedMicrousd',d.committed_microusd,'turns',items,'models',agentonic.deployment_models(d));
 END IF;
 RAISE insufficient_privilege;
END $$;
CREATE OR REPLACE FUNCTION agentonic.agent_listing() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=agentonic.workspace_id(); result jsonb;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR agentonic.actor_user_id() IS NULL OR w IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR SHARE;
 IF NOT FOUND OR agentonic.current_member() IS NULL THEN RAISE insufficient_privilege; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id',a.id,'name',a.name,'slug',a.slug,'description',a.description,'status',a.status,
  'canEdit',agentonic.can_agent(a.id,'edit'),
  'configuration',CASE WHEN agentonic.can_agent(a.id,'edit') THEN jsonb_build_object(
   -- ECMAScript whitespace, matching the shared prompt character counter.
   'promptCharacters',length(translate(coalesce(d.content->>'systemPrompt',''),U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF','')),
   'skillsCount',coalesce(jsonb_array_length(d.content->'skills'),0),
   'collectionsCount',coalesce(jsonb_array_length(d.requested_access->'collectionIds'),0),
   'toolsCount',coalesce(jsonb_array_length(d.requested_access->'tools'),0),
   -- Connections remain unavailable; observed staging deployments are separate from drafts.
   'connectionsCount',0,'liveVersion',(SELECT string_agg(r.version || ' · ' || CASE dep.environment WHEN 'local' THEN 'Pruebas locales' ELSE 'Pruebas VM' END || CASE WHEN agentonic.deployment_online(dep) THEN '' ELSE ' · Sin conexión' END, ', ' ORDER BY dep.environment)
     FROM agentonic.agent_environments ae JOIN agentonic.deployments dep ON dep.id=ae.current_deployment_id JOIN agentonic.configuration_releases r ON r.id=dep.configuration_release_id
     WHERE ae.workspace_id=w AND ae.agent_id=a.id AND dep.status='running' AND dep.desired_state='running' AND agentonic.deployment_authorized(dep)),
   'reviewVersions',coalesce((SELECT jsonb_agg(jsonb_build_object('version',r.version,'revision',r.source_draft_revision,'status',s.status) ORDER BY s.submission_number DESC)
    FROM agentonic.agent_submissions s JOIN agentonic.configuration_releases r ON r.id=s.configuration_release_id AND r.workspace_id=w AND r.agent_id=a.id
    WHERE s.workspace_id=w AND s.agent_id=a.id AND s.status IN ('submitted','in_review')),'[]'::jsonb)
  ) ELSE NULL END
 ) ORDER BY a.created_at DESC,a.id),'[]'::jsonb) INTO result
 FROM agentonic.agents a
 LEFT JOIN agentonic.configuration_drafts d ON d.agent_id=a.id AND d.workspace_id=w AND d.status='draft'
 WHERE a.workspace_id=w AND agentonic.can_agent(a.id,'read');
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION agentonic.lifecycle_state(target_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();staff uuid:=agentonic.current_staff();aid uuid;items jsonb;deploys jsonb;operator boolean;
BEGIN
 IF w IS NULL OR agentonic.application_role() NOT IN ('agentonic_admin','agentonic_customer') THEN RAISE insufficient_privilege; END IF;
 SELECT a.id INTO aid FROM agentonic.agents a WHERE a.workspace_id=w AND (a.id=target_id OR EXISTS(SELECT 1 FROM agentonic.agent_submissions s WHERE s.id=target_id AND s.agent_id=a.id));
 IF aid IS NULL THEN RETURN NULL; END IF;
 IF agentonic.application_role()='agentonic_admin' THEN
  IF staff IS NULL THEN RAISE insufficient_privilege; END IF;
 ELSE
  IF m IS NULL OR NOT agentonic.can_agent(aid,'read') THEN RAISE insufficient_privilege; END IF;
 END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR SHARE; IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 operator:=agentonic.application_role()='agentonic_admin' AND EXISTS(SELECT 1 FROM agentonic.platform_staff WHERE id=staff AND role IN ('administrator','operator'));
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'number',s.submission_number,'candidateId',s.configuration_release_id,
  'versionNumber',(SELECT count(*)::int FROM agentonic.configuration_releases v WHERE v.agent_id=aid AND (v.created_at,v.id)<=(r.created_at,r.id)),
  'approvalId',d.id,'reason',agentonic.approval_reason(d.id),'expiresAt',d.approval_expires_at,
  'renewalRequested',EXISTS(SELECT 1 FROM agentonic.approval_renewal_requests req WHERE req.submission_id=s.id),
  'renewedSubmissionId',(SELECT id FROM agentonic.agent_submissions n WHERE n.renewed_from_submission_id=s.id),
  'canRequestRenewal',operator AND s.status='approved' AND NOT coalesce(agentonic.version_approval_valid(d.id),false) AND NOT EXISTS(SELECT 1 FROM agentonic.agent_submissions n WHERE n.renewed_from_submission_id=s.id),
  'canRenew',agentonic.application_role()='agentonic_customer' AND s.submitted_by_member_id=m AND agentonic.can_agent(aid,'edit') AND s.status IN ('approved','revoked','changes_requested','rejected','withdrawn') AND NOT coalesce(agentonic.version_approval_valid(d.id),false) AND NOT EXISTS(SELECT 1 FROM agentonic.agent_submissions n WHERE n.renewed_from_submission_id=s.id),
  'canAuthorize',agentonic.application_role()='agentonic_customer' AND s.submitted_by_member_id=m AND agentonic.can_agent(aid,'edit') AND agentonic.can_agent(aid,'invoke') AND coalesce(agentonic.version_approval_valid(d.id),false)
 ) ORDER BY s.submission_number DESC),'[]') INTO items
 FROM agentonic.agent_submissions s JOIN agentonic.configuration_releases r ON r.id=s.configuration_release_id
 LEFT JOIN LATERAL(SELECT * FROM agentonic.submission_review_decisions dec WHERE dec.submission_id=s.id AND dec.decision='approved' ORDER BY dec.decision_number DESC LIMIT 1) d ON true
 WHERE s.workspace_id=w AND s.agent_id=aid;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',dep.id,'submissionId',dep.submission_id,'environment',dep.environment,'status',dep.status,
  'authorized',agentonic.deployment_authorized(dep),'online',dep.status='running' AND agentonic.deployment_authorized(dep) AND agentonic.deployment_online(dep),
  'expiresAt',dep.authorized_until,'budgetUsd',dep.budget_usd,'committedMicrousd',dep.committed_microusd,'errorCode',dep.error_code,
  'canActivate',operator AND dep.status='awaiting_activation' AND agentonic.deployment_authorized(dep) AND agentonic.version_approval_valid(dep.approval_id),
  'canStop',(operator OR dep.authorized_by_member_id=m) AND dep.status IN ('awaiting_activation','queued','preparing','running'),
  'canChat',agentonic.application_role()='agentonic_customer' AND dep.authorized_by_member_id=m AND dep.status='running' AND agentonic.deployment_authorized(dep) AND agentonic.can_agent(aid,'invoke')
 ) ORDER BY dep.created_at DESC),'[]') INTO deploys FROM agentonic.deployments dep WHERE dep.workspace_id=w AND dep.agent_id=aid;
 RETURN jsonb_build_object('agentId',aid,'submissions',items,'deployments',deploys,'hosts',coalesce((SELECT jsonb_agg(jsonb_build_object('environment',environment,'available',revoked_at IS NULL AND verified_at>clock_timestamp()-interval '7 days' AND coalesce(heartbeat_at>clock_timestamp()-interval '90 seconds',false))) FROM agentonic.runtime_hosts),'[]'::jsonb));
END $$;
COMMIT;
