BEGIN;
-- Side-by-side broker programs. Runtimes already install side by side
-- (migration 38), but the broker program was single per host, so replacing it
-- waited for every deployment to stop. A host now registers each broker
-- release it holds; the newest is current. The deployment controller runs the
-- current broker and starts every new copy of a deployment on it. A running
-- deployment on an older broker moves without interruption: a successor copy
-- starts on the current broker, and once it is ready the old copy drains,
-- finishing the turn it leased without claiming new ones. A broker no copy
-- runs any longer retires. Revocation is the emergency path: a revoked
-- broker's copies are refused at once and their deployments restored on the
-- current broker.
CREATE TABLE agentonic.runtime_host_brokers (
 host_id uuid NOT NULL REFERENCES agentonic.runtime_hosts(id),
 broker_sha256 text NOT NULL CHECK(broker_sha256 ~ '^[a-f0-9]{64}$'),
 installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 retired_at timestamptz, revoked_at timestamptz,
 PRIMARY KEY(host_id,broker_sha256),
 CHECK(retired_at IS NULL OR retired_at>=installed_at), CHECK(revoked_at IS NULL OR revoked_at>=installed_at)
);
INSERT INTO agentonic.runtime_host_brokers(host_id,broker_sha256,installed_at)
 SELECT id,broker_sha256,least(verified_at,clock_timestamp()) FROM agentonic.runtime_hosts;
-- Each deployment records the broker its serving copy runs, plus at most one
-- other copy: a successor starting on the current broker, or the previous
-- serving copy draining after a move. Tokens are hashes of per-copy secrets.
ALTER TABLE agentonic.deployments
 ADD COLUMN broker_sha256 text CHECK(broker_sha256 ~ '^[a-f0-9]{64}$'),
 ADD COLUMN successor_broker_sha256 text CHECK(successor_broker_sha256 ~ '^[a-f0-9]{64}$'),
 ADD COLUMN successor_token_sha256 text CHECK(successor_token_sha256 ~ '^[a-f0-9]{64}$'),
 ADD COLUMN draining_broker_sha256 text CHECK(draining_broker_sha256 ~ '^[a-f0-9]{64}$'),
 ADD COLUMN draining_token_sha256 text CHECK(draining_token_sha256 ~ '^[a-f0-9]{64}$'),
 ADD COLUMN draining_since timestamptz,
 ADD CONSTRAINT deployment_successor_copy CHECK((successor_broker_sha256 IS NULL)=(successor_token_sha256 IS NULL)
  AND (successor_broker_sha256 IS NULL OR (broker_sha256 IS NOT NULL AND successor_broker_sha256<>broker_sha256))),
 ADD CONSTRAINT deployment_draining_copy CHECK((draining_broker_sha256 IS NULL)=(draining_token_sha256 IS NULL) AND (draining_token_sha256 IS NULL)=(draining_since IS NULL)
  AND (draining_broker_sha256 IS NULL OR (broker_sha256 IS NOT NULL AND draining_broker_sha256<>broker_sha256))),
 ADD CONSTRAINT deployment_one_extra_copy CHECK(successor_token_sha256 IS NULL OR draining_token_sha256 IS NULL);
CREATE OR REPLACE FUNCTION agentonic.deployment_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Deployment history is retained'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','desired_state','service_token_sha256','generation','committed_microusd','requested_by_staff_id','activated_at','heartbeat_at','error_code','manifest_sha256','revoked_at',
  'broker_sha256','successor_broker_sha256','successor_token_sha256','draining_broker_sha256','draining_token_sha256','draining_since'])
 IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','desired_state','service_token_sha256','generation','committed_microusd','requested_by_staff_id','activated_at','heartbeat_at','error_code','manifest_sha256','revoked_at',
  'broker_sha256','successor_broker_sha256','successor_token_sha256','draining_broker_sha256','draining_token_sha256','draining_since']) THEN RAISE EXCEPTION 'Immutable deployment scope'; END IF;
 IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN RAISE EXCEPTION 'Irreversible deployment revocation'; END IF;
 IF OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN RAISE EXCEPTION 'Immutable activation evidence'; END IF;
 IF OLD.requested_by_staff_id IS NOT NULL AND NEW.requested_by_staff_id IS DISTINCT FROM OLD.requested_by_staff_id THEN RAISE EXCEPTION 'Immutable deployment actor'; END IF;
 RETURN NEW;
END $$;
-- A deployment that stops keeps no successor or draining copy. Named to run
-- before deployment_immutable (BEFORE triggers fire in name order).
CREATE FUNCTION agentonic.deployment_copies_end() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.status NOT IN ('preparing','running') OR NEW.desired_state<>'running' THEN
  NEW.successor_broker_sha256:=NULL;NEW.successor_token_sha256:=NULL;
  NEW.draining_broker_sha256:=NULL;NEW.draining_token_sha256:=NULL;NEW.draining_since:=NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER deployment_copies_end BEFORE UPDATE ON agentonic.deployments FOR EACH ROW EXECUTE FUNCTION agentonic.deployment_copies_end();
-- Prepared deployments ran their host's only broker.
UPDATE agentonic.deployments d SET broker_sha256=h.broker_sha256 FROM agentonic.runtime_hosts h WHERE h.id=d.host_id AND d.status IN ('preparing','running');
CREATE FUNCTION agentonic.runtime_host_broker_guard() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Broker history is retained'; END IF;
 IF (to_jsonb(NEW)-ARRAY['retired_at','revoked_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['retired_at','revoked_at']) THEN RAISE EXCEPTION 'Immutable broker registration'; END IF;
 IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN RAISE EXCEPTION 'Irreversible broker revocation'; END IF;
 -- The controller runs the current broker: install a replacement before retiring or revoking it.
 IF (NEW.retired_at IS NOT NULL OR NEW.revoked_at IS NOT NULL)
  AND EXISTS(SELECT 1 FROM agentonic.runtime_hosts h WHERE h.id=NEW.host_id AND h.broker_sha256=NEW.broker_sha256) THEN RAISE EXCEPTION 'Current broker'; END IF;
 -- Retirement is normal succession and never pulls a broker from a live copy.
 IF OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL AND NEW.revoked_at IS NULL AND EXISTS(SELECT 1 FROM agentonic.deployments d
  WHERE d.host_id=NEW.host_id AND d.status IN ('preparing','running') AND NEW.broker_sha256 IN (d.broker_sha256,d.successor_broker_sha256,d.draining_broker_sha256)) THEN
  RAISE EXCEPTION 'Broker in use';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER runtime_host_broker_guard BEFORE UPDATE OR DELETE ON agentonic.runtime_host_brokers FOR EACH ROW EXECUTE FUNCTION agentonic.runtime_host_broker_guard();
-- A host's current broker is always registered and live (checked at commit,
-- so a new host and its first broker can be inserted in one transaction).
CREATE FUNCTION agentonic.runtime_host_current_broker() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 -- Read the row as it is now: an earlier queued check may describe a superseded value.
 IF NOT EXISTS(SELECT 1 FROM agentonic.runtime_hosts h JOIN agentonic.runtime_host_brokers b ON b.host_id=h.id AND b.broker_sha256=h.broker_sha256
  WHERE h.id=NEW.id AND b.retired_at IS NULL AND b.revoked_at IS NULL) THEN
  RAISE EXCEPTION 'Current broker must be registered and live';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER runtime_host_current_broker AFTER INSERT OR UPDATE OF broker_sha256 ON agentonic.runtime_hosts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agentonic.runtime_host_current_broker();
ALTER TABLE agentonic.runtime_host_brokers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.runtime_host_brokers FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure,agentonic_runtime_local,agentonic_runtime_azure,agentonic_deployer_local,agentonic_deployer_azure;
CREATE FUNCTION agentonic.broker_live(host uuid,broker text) RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM agentonic.runtime_host_brokers b WHERE b.host_id=host AND b.broker_sha256=broker AND b.retired_at IS NULL AND b.revoked_at IS NULL)
$$;
-- Which copy of a deployment a service secret belongs to, if any: 'serving',
-- 'successor' or 'draining'. A copy whose broker is no longer live is refused.
CREATE FUNCTION agentonic.deployment_copy(d agentonic.deployments,secret text) RETURNS text LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT CASE
  WHEN d.id IS NULL OR secret IS NULL OR length(secret)<>64 OR NOT EXISTS(SELECT 1 FROM agentonic.runtime_hosts h
   WHERE h.id=d.host_id AND replace(h.database_role,'deployer','runtime')=agentonic.application_role()) THEN NULL
  WHEN d.service_token_sha256=t.hash AND agentonic.broker_live(d.host_id,d.broker_sha256) THEN 'serving'
  WHEN d.successor_token_sha256=t.hash AND agentonic.broker_live(d.host_id,d.successor_broker_sha256) THEN 'successor'
  WHEN d.draining_token_sha256=t.hash AND agentonic.broker_live(d.host_id,d.draining_broker_sha256) THEN 'draining'
 END FROM (SELECT encode(sha256(convert_to(secret,'UTF8')),'hex') hash) t
$$;
REVOKE ALL ON FUNCTION agentonic.broker_live(uuid,text),agentonic.deployment_copy(agentonic.deployments,text),agentonic.runtime_host_broker_guard(),
 agentonic.runtime_host_current_broker(),agentonic.deployment_copies_end() FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION agentonic.deployment_host(operation text,target_id uuid,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h agentonic.runtime_hosts;d agentonic.deployments;manifest jsonb;result jsonb;brokers jsonb;
BEGIN
 SELECT * INTO h FROM agentonic.runtime_hosts WHERE database_role=agentonic.application_role() AND broker_sha256=payload->>'brokerHash' AND revoked_at IS NULL AND verified_at>clock_timestamp()-interval '7 days';
 IF h.id IS NULL OR NOT agentonic.broker_live(h.id,h.broker_sha256) THEN RAISE insufficient_privilege; END IF;
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
  -- Normal succession: an earlier broker no copy runs any longer retires.
  UPDATE agentonic.runtime_host_brokers b SET retired_at=clock_timestamp() WHERE b.host_id=h.id AND b.broker_sha256<>h.broker_sha256 AND b.retired_at IS NULL AND b.revoked_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM agentonic.deployments dep WHERE dep.host_id=h.id AND dep.status IN ('preparing','running')
    AND b.broker_sha256 IN (dep.broker_sha256,dep.successor_broker_sha256,dep.draining_broker_sha256));
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'workspaceId',workspace_id,'agentId',agent_id,'environment',environment,'status',status,'desired',desired_state,'heartbeatAt',heartbeat_at,
   'broker',broker_sha256,'successorBroker',successor_broker_sha256,'drainingBroker',draining_broker_sha256,'drainingSince',draining_since) ORDER BY created_at),'[]') INTO result
   FROM agentonic.deployments WHERE host_id=h.id;
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
    successor_broker_sha256=NULL,successor_token_sha256=NULL,draining_broker_sha256=NULL,draining_token_sha256=NULL,draining_since=NULL WHERE id=d.id;
   INSERT INTO agentonic.audit_events(workspace_id,action,resource_type,resource_id,outcome,request_id)
    VALUES(d.workspace_id,'deployment.restored','deployment',d.id::text,'succeeded',gen_random_uuid()::text);
  END IF;
  RETURN jsonb_build_object('ok',true,'manifest',manifest,'manifestJson',manifest::text,'manifestHash',agentonic.content_hash(manifest),
   'configurationJson',(SELECT content::text FROM agentonic.configuration_releases WHERE id=d.configuration_release_id),'configuration',(SELECT content FROM agentonic.configuration_releases WHERE id=d.configuration_release_id));
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
 IF operation='ready' THEN
  IF payload->>'manifestHash' IS DISTINCT FROM d.manifest_sha256 THEN RAISE insufficient_privilege; END IF;
  IF slot='successor' THEN
   IF d.status<>'running' THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.deployments SET draining_broker_sha256=broker_sha256,draining_token_sha256=service_token_sha256,draining_since=clock_timestamp(),
    broker_sha256=successor_broker_sha256,service_token_sha256=successor_token_sha256,successor_broker_sha256=NULL,successor_token_sha256=NULL,
    generation=generation+1,heartbeat_at=clock_timestamp() WHERE id=d.id;
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
 UPDATE agentonic.deployments SET heartbeat_at=clock_timestamp() WHERE id=d.id;
 RETURN jsonb_build_object('ok',true);
END $$;
-- Evaluator registrations end in one of two ways. Retirement is normal
-- succession (renewal or a new release): the registration stops taking work,
-- but evidence it produced while active stays valid for approval. Revocation
-- still withdraws trust from everything the registration produced.
ALTER TABLE agentonic.evaluation_workers ADD COLUMN retired_at timestamptz;
DROP INDEX agentonic.evaluation_worker_active_role;
CREATE UNIQUE INDEX evaluation_worker_active_role ON agentonic.evaluation_workers(database_role) WHERE revoked_at IS NULL AND retired_at IS NULL;
-- The functions below are unchanged except for the copy check in
-- staging_worker and the retired/revoked distinction for evaluators.
CREATE OR REPLACE FUNCTION agentonic.staging_worker(operation text,deployment_id uuid,secret text,job_id uuid,token uuid,payload jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE d agentonic.deployments;c agentonic.staging_conversations;t agentonic.staging_turns;r agentonic.configuration_releases;code agentonic.code_releases;
 hits jsonb;assets jsonb;history jsonb;budget agentonic.retrieval_provider_budgets;meter agentonic.retrieval_provider_operations;amount bigint;slot text;
BEGIN
 SELECT * INTO d FROM agentonic.deployments WHERE id=deployment_id;
 -- The serving copy works; a draining copy only finishes the turn it leased.
 IF coalesce(agentonic.deployment_copy(d,secret) NOT IN ('serving','draining'),true) THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=d.workspace_id FOR SHARE;
 SELECT * INTO d FROM agentonic.deployments WHERE id=deployment_id FOR UPDATE;
 slot:=agentonic.deployment_copy(d,secret);
 IF coalesce(slot NOT IN ('serving','draining'),true) OR d.status<>'running' OR d.desired_state<>'running' OR NOT agentonic.deployment_authorized(d) THEN RAISE insufficient_privilege; END IF;
 IF operation='claim' THEN
  IF slot='draining' THEN RETURN NULL; END IF;
  UPDATE agentonic.staging_turns turn SET status='failed',error_code='lease_lost',lease_token=NULL,lease_until=NULL
   FROM agentonic.staging_conversations conv WHERE conv.id=turn.conversation_id AND conv.deployment_id=d.id AND turn.status='running' AND (turn.lease_until<=clock_timestamp() OR turn.started_at<clock_timestamp()-interval '2 minutes');
  SELECT turn.* INTO t FROM agentonic.staging_turns turn JOIN agentonic.staging_conversations conv ON conv.id=turn.conversation_id
   WHERE conv.deployment_id=d.id AND turn.status='queued' AND agentonic.staging_conversation_authorized(conv) ORDER BY turn.created_at LIMIT 1 FOR UPDATE OF turn SKIP LOCKED;
  IF t.id IS NULL THEN RETURN NULL; END IF;
  UPDATE agentonic.staging_turns SET status='running',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '90 seconds',started_at=clock_timestamp() WHERE id=t.id RETURNING * INTO t;
  RETURN jsonb_build_object('id',t.id,'token',t.lease_token,'kind','retrieve');
 END IF;
 SELECT turn.* INTO t FROM agentonic.staging_turns turn JOIN agentonic.staging_conversations conv ON conv.id=turn.conversation_id WHERE turn.id=job_id AND conv.deployment_id=d.id FOR UPDATE OF turn;
 IF t.id IS NULL OR t.status<>'running' OR t.lease_token IS DISTINCT FROM token OR t.lease_until<=clock_timestamp() OR t.started_at<clock_timestamp()-interval '2 minutes' THEN RAISE insufficient_privilege; END IF;
 IF operation='fail' THEN
  UPDATE agentonic.staging_turns SET status='failed',error_code=CASE WHEN payload->>'code' IN ('provider_unavailable','budget_exhausted','configuration_required','runtime_mismatch') THEN payload->>'code' ELSE 'lease_lost' END,lease_token=NULL,lease_until=NULL WHERE id=t.id;
  RETURN '{"ok":true}';
 END IF;
 SELECT * INTO c FROM agentonic.staging_conversations WHERE id=t.conversation_id;
 IF NOT agentonic.staging_conversation_authorized(c) THEN RAISE insufficient_privilege; END IF;
 SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id;
 SELECT * INTO code FROM agentonic.code_releases WHERE id=d.code_release_id;
 IF operation='heartbeat' THEN
  UPDATE agentonic.staging_turns SET lease_until=clock_timestamp()+interval '90 seconds' WHERE id=t.id;
  RETURN '{"ok":true}';
 ELSIF operation='read' THEN
  RETURN jsonb_build_object('kind','retrieve','workspaceId',d.workspace_id,'query',t.query,'retrievalQuery',concat_ws(E'\n',(SELECT string_agg(p.query,E'\n' ORDER BY p.number) FROM (SELECT query,number FROM agentonic.staging_turns WHERE conversation_id=c.id AND number<t.number AND status='succeeded' ORDER BY number DESC LIMIT 2) p),t.query),
   'generateAnswer',true,'preview',true,'hasCollections',jsonb_array_length(r.requested_access_snapshot->'collectionIds')>0,
   'runtime',jsonb_build_object('gitCommit',code.git_commit_sha,'artifactSha256',code.artifact_sha256,'manifest',code.execution_manifest));
 ELSIF operation='reserve' THEN
  IF NOT coalesce((payload->>'provider'='voyage' AND (payload->>'model'='voyage-4' OR payload->>'model'='rerank-2.5-lite')) OR (payload->>'provider'='openai' AND payload->>'model'=t.response_model),false) THEN RAISE insufficient_privilege; END IF;
  amount:=(payload->>'microusd')::bigint;
  IF amount IS NULL OR amount NOT BETWEEN 1 AND 5000000 THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO budget FROM agentonic.retrieval_provider_budgets WHERE provider=payload->>'provider' FOR UPDATE;
  IF budget.provider IS NULL THEN RAISE insufficient_privilege; END IF;
  IF d.committed_microusd+amount>d.budget_usd*1000000 OR budget.committed_microusd+amount>budget.cap_microusd THEN RETURN '{"ok":false,"code":"budget_exhausted"}'; END IF;
  INSERT INTO agentonic.retrieval_provider_operations(id,job_id,workspace_id,provider,model,reserved_microusd,agent_id,deployment_id,conversation_id)
   VALUES((payload->>'id')::uuid,t.id,d.workspace_id,budget.provider,payload->>'model',amount,d.agent_id,d.id,c.id);
  UPDATE agentonic.retrieval_provider_budgets SET committed_microusd=committed_microusd+amount,updated_at=clock_timestamp() WHERE provider=budget.provider;
  UPDATE agentonic.deployments SET committed_microusd=committed_microusd+amount WHERE id=d.id;
  RETURN '{"ok":true}';
 ELSIF operation='settle' THEN
  SELECT * INTO meter FROM agentonic.retrieval_provider_operations op WHERE op.id=(payload->>'id')::uuid AND op.job_id=t.id AND op.deployment_id=d.id AND op.status='reserved' FOR UPDATE;
  amount:=(payload->>'microusd')::bigint;
  IF meter.id IS NULL OR amount IS NULL OR amount<0 OR payload->>'tokens' IS NULL OR (payload->>'tokens')::bigint<0 OR coalesce((payload->>'outputTokens')::bigint,0)<0 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.retrieval_provider_operations SET status='settled',actual_microusd=amount,input_tokens=(payload->>'tokens')::bigint,output_tokens=coalesce((payload->>'outputTokens')::bigint,0) WHERE id=meter.id;
  UPDATE agentonic.retrieval_provider_budgets SET committed_microusd=committed_microusd-meter.reserved_microusd+amount,updated_at=clock_timestamp() WHERE provider=meter.provider;
  UPDATE agentonic.deployments SET committed_microusd=committed_microusd-meter.reserved_microusd+amount WHERE id=d.id;
  RETURN '{"ok":true}';
 ELSIF operation='empty-search' THEN
  IF jsonb_array_length(r.requested_access_snapshot->'collectionIds')<>0 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.staging_turns SET matches='[]' WHERE id=t.id; RETURN '{"ok":true}';
 ELSIF operation='search' THEN
  IF jsonb_typeof(payload->'embedding') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'embedding')<>1024 THEN RAISE insufficient_privilege; END IF;
  WITH eligible AS MATERIALIZED (
   SELECT ch.* FROM agentonic.document_chunks ch JOIN agentonic.document_versions v ON v.id=ch.document_version_id JOIN agentonic.documents doc ON doc.id=v.document_id AND doc.active_version_id=v.id
   WHERE ch.workspace_id=d.workspace_id AND v.status='ready' AND doc.deleted_at IS NULL
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.requested_access_snapshot->'collections') col CROSS JOIN LATERAL jsonb_array_elements(col->'sources') src WHERE src->>'id'=doc.source_id::text)
  ), semantic AS (
   SELECT id,row_number() OVER(ORDER BY embedding OPERATOR(public.<=>) (payload->'embedding')::text::public.vector,id) rank FROM eligible ORDER BY embedding OPERATOR(public.<=>) (payload->'embedding')::text::public.vector,id LIMIT 40
  ), lexical AS (
   SELECT id,row_number() OVER(ORDER BY ts_rank_cd(search_vector,q) DESC,id) rank FROM eligible,LATERAL(SELECT websearch_to_tsquery('pg_catalog.simple',t.query)||websearch_to_tsquery('pg_catalog.spanish',t.query)||websearch_to_tsquery('pg_catalog.english',t.query) q) query WHERE search_vector@@q ORDER BY ts_rank_cd(search_vector,q) DESC,id LIMIT 40
  ), ranked AS (
   SELECT coalesce(s.id,l.id) id,coalesce(1.0/(60+s.rank),0)+coalesce(1.0/(60+l.rank),0) score FROM semantic s FULL JOIN lexical l ON s.id=l.id ORDER BY score DESC,coalesce(s.id,l.id) LIMIT CASE WHEN payload->>'rerank'='true' THEN 32 ELSE 8 END
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',ranked.id,'hash',ch.content_sha256) ORDER BY ranked.score DESC,ranked.id),'[]') INTO hits FROM ranked JOIN agentonic.document_chunks ch ON ch.id=ranked.id;
  UPDATE agentonic.staging_turns SET matches=hits WHERE id=t.id; RETURN '{"ok":true}';
 ELSIF operation IN ('context','answer','rerank-context','select-matches') THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',ch.id,'text',ch.content) ORDER BY hit.ordinality),'[]') INTO hits
   FROM jsonb_array_elements(t.matches) WITH ORDINALITY hit(value,ordinality) JOIN agentonic.document_chunks ch ON ch.id=(hit.value->>'id')::uuid AND ch.workspace_id=d.workspace_id AND ch.content_sha256=hit.value->>'hash'
   JOIN agentonic.document_versions v ON v.id=ch.document_version_id JOIN agentonic.documents doc ON doc.id=v.document_id AND doc.active_version_id=v.id WHERE doc.deleted_at IS NULL AND v.status='ready';
  IF jsonb_array_length(hits)<>jsonb_array_length(t.matches) THEN RAISE insufficient_privilege; END IF;
  IF operation='rerank-context' THEN RETURN jsonb_build_object('passages',hits); END IF;
  IF operation='select-matches' THEN
   IF EXISTS(SELECT 1 FROM agentonic.retrieval_provider_operations op WHERE op.job_id=t.id AND op.status='reserved') THEN RAISE insufficient_privilege; END IF;
   hits:=agentonic.select_retrieval_matches(t.matches,payload->'ids');
   UPDATE agentonic.staging_turns SET matches=hits WHERE id=t.id;
   RETURN '{"ok":true}';
  END IF;
  IF jsonb_array_length(hits)>8 THEN RAISE insufficient_privilege; END IF;
  IF operation='context' THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('path','skills/'||(s->>'name')||'.md','sha256',encode(sha256(convert_to(s->>'instructions','UTF8')),'hex')) ORDER BY s->>'name'),'[]') INTO assets FROM jsonb_array_elements(r.content->'skills') s;
   assets:=jsonb_build_array(jsonb_build_object('path','prompts/system.md','sha256',encode(sha256(convert_to(r.content->>'systemPrompt','UTF8')),'hex')))||assets;
   SELECT coalesce(jsonb_agg(jsonb_build_object('query',p.query,'answer',p.answer) ORDER BY p.number),'[]') INTO history FROM (SELECT query,answer,number FROM agentonic.staging_turns WHERE conversation_id=c.id AND number<t.number AND status='succeeded' ORDER BY number DESC LIMIT 9) p;
   RETURN jsonb_build_object('previewModel',t.response_model,'reasoningLevel',t.reasoning_effort,'query',t.query,'passages',hits,'environment','staging','audience','private','expiresAt',least(c.expires_at,t.started_at+interval '2 minutes'),
    'configurationJson',r.content::text,'contentSha256',r.content_sha256,'composedPromptSha256',r.composed_prompt_sha256,'assetManifestJson',assets::text,'assetManifestSha256',r.asset_manifest_sha256,'accessJson',r.requested_access_snapshot::text,'accessSha256',r.requested_access_sha256,'history',history);
  END IF;
  IF jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' OR length(payload->>'text') NOT BETWEEN 1 AND 12000 OR jsonb_typeof(payload->'citations') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'citations')>8 OR jsonb_typeof(payload->'insufficientEvidence') IS DISTINCT FROM 'boolean' OR payload->>'model' IS DISTINCT FROM t.response_model
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(payload->'citations') citation WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(hits) h WHERE h->>'id'=citation))
   OR (jsonb_array_length(hits)>0 AND payload->'insufficientEvidence'='false' AND jsonb_array_length(payload->'citations')=0) THEN RAISE insufficient_privilege; END IF;
  IF d.committed_microusd>d.budget_usd*1000000 OR EXISTS(SELECT 1 FROM agentonic.retrieval_provider_operations op WHERE op.job_id=t.id AND op.status='reserved') THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.staging_turns SET status='succeeded',answer=payload->>'text',citations=payload->'citations',insufficient_evidence=(payload->>'insufficientEvidence')::boolean,lease_token=NULL,lease_until=NULL WHERE id=t.id;
  RETURN '{"ok":true}';
 END IF;
 RAISE insufficient_privilege;
END $$;
CREATE OR REPLACE FUNCTION agentonic.evaluation_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_TABLE_NAME='evaluation_workers' THEN
  IF TG_OP='DELETE' OR to_jsonb(NEW)-ARRAY['revoked_at','retired_at'] IS DISTINCT FROM to_jsonb(OLD)-ARRAY['revoked_at','retired_at']
   OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN RAISE EXCEPTION 'Immutable worker attestation'; END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='evaluation_results' THEN
  IF TG_OP='UPDATE' AND NEW.answer='' AND NEW.citations='[]' AND NEW.evidence_sources='[]' AND NEW.assessment IS NULL
   AND to_jsonb(NEW)-ARRAY['answer','citations','evidence_sources','assessment'] IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['answer','citations','evidence_sources','assessment']
   AND EXISTS(SELECT 1 FROM agentonic.evaluation_runs e WHERE e.id=OLD.evaluation_run_id AND e.scrubbed_at IS NOT NULL) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Immutable evaluation result';
 END IF;
 IF OLD.scrubbed_at IS NULL AND NEW.scrubbed_at IS NOT NULL AND NEW.dataset_snapshot='[]'
  AND (OLD.expires_at<=clock_timestamp() OR OLD.consent_revoked_at IS NOT NULL)
  AND to_jsonb(NEW)-ARRAY['scrubbed_at','dataset_snapshot'] IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['scrubbed_at','dataset_snapshot'] THEN RETURN NEW; END IF;

 IF to_jsonb(NEW)-ARRAY['status','authorized_by_member_id','authorized_at','consent_revoked_at','committed_microusd','worker_id','lease_token','lease_until','next_case','current_matches','evidence_sha256','error_code','started_at','finished_at']
 IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','authorized_by_member_id','authorized_at','consent_revoked_at','committed_microusd','worker_id','lease_token','lease_until','next_case','current_matches','evidence_sha256','error_code','started_at','finished_at'] THEN RAISE EXCEPTION 'Immutable evaluation specification'; END IF;
 IF OLD.authorized_at IS NOT NULL AND (NEW.authorized_at IS DISTINCT FROM OLD.authorized_at OR NEW.authorized_by_member_id IS DISTINCT FROM OLD.authorized_by_member_id) THEN RAISE EXCEPTION 'Immutable consent'; END IF;
 IF OLD.consent_revoked_at IS NOT NULL AND NEW.consent_revoked_at IS DISTINCT FROM OLD.consent_revoked_at THEN RAISE EXCEPTION 'Irreversible consent revocation'; END IF;
 IF OLD.worker_id IS NOT NULL AND NEW.worker_id IS DISTINCT FROM OLD.worker_id THEN RAISE EXCEPTION 'Immutable execution worker'; END IF;
 IF OLD.status IN ('passed','failed','error','cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN RAISE EXCEPTION 'Terminal evaluation'; END IF;
 IF OLD.evidence_sha256 IS NOT NULL AND NEW.evidence_sha256 IS DISTINCT FROM OLD.evidence_sha256 THEN RAISE EXCEPTION 'Immutable evaluation evidence'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION agentonic.evaluation_approvable(e agentonic.evaluation_runs, allow_approved boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT agentonic.evaluation_batch_current(e) AND e.status='passed' AND e.environment='azure_staging' AND e.finished_at>clock_timestamp()-interval '24 hours'
 AND agentonic.evaluation_authorized(e,true,allow_approved) AND agentonic.evaluation_sources_current(e)
 AND e.evidence_sha256 IS NOT NULL AND EXISTS(SELECT 1 FROM agentonic.evaluation_workers worker JOIN agentonic.code_releases c ON c.id=e.code_release_id
 WHERE worker.id=e.worker_id AND worker.environment='azure_staging' AND worker.revoked_at IS NULL AND (worker.verified_at>clock_timestamp()-interval '7 days' OR e.finished_at<=worker.retired_at)
 AND agentonic.evaluator_runs(worker.id,c.artifact_sha256) AND worker.verification @> '{"isolation":true,"recovery":true,"artifactIntegrity":true}')
 AND (SELECT count(*) FROM agentonic.evaluation_results result WHERE result.evaluation_run_id=e.id AND result.outcome='passed')=jsonb_array_length(e.dataset_snapshot)
$$;
CREATE OR REPLACE FUNCTION agentonic.evaluation_claim(worker_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE worker agentonic.evaluation_workers; candidate agentonic.evaluation_runs; token uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO worker FROM agentonic.evaluation_workers WHERE database_role=agentonic.application_role() AND revoked_at IS NULL AND retired_at IS NULL AND worker_sha256=worker_hash AND verified_at>clock_timestamp()-interval '7 days';
 IF worker.id IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM agentonic.evaluation_cleanup();
 -- Lease loss never retries paid work. Outstanding reservations stay charged.
 FOR candidate IN SELECT e.* FROM agentonic.evaluation_runs e WHERE e.environment=worker.environment AND e.status IN ('awaiting_consent','queued','running') ORDER BY e.created_at LIMIT 50 LOOP
  PERFORM 1 FROM agentonic.workspaces WHERE id=candidate.workspace_id FOR SHARE;
  SELECT * INTO candidate FROM agentonic.evaluation_runs WHERE id=candidate.id FOR UPDATE;
  IF candidate.status IN ('awaiting_consent','queued','running') AND (NOT agentonic.evaluation_authorized(candidate,candidate.status<>'awaiting_consent') OR (candidate.status='running' AND (candidate.lease_until<=clock_timestamp() OR candidate.started_at<clock_timestamp()-interval '30 minutes'))) THEN
   UPDATE agentonic.evaluation_runs SET status='error',error_code='lease_lost',lease_token=NULL,lease_until=NULL,current_matches='[]',finished_at=clock_timestamp() WHERE id=candidate.id;
  END IF;
 END LOOP;
 FOR candidate IN SELECT e.* FROM agentonic.evaluation_runs e JOIN agentonic.code_releases c ON c.id=e.code_release_id
 WHERE e.environment=worker.environment AND e.status='queued' AND agentonic.evaluator_runs(worker.id,c.artifact_sha256) AND (e.preparation_id IS NULL OR (e.batch_id IS NULL AND worker.verification @> '{"reviewProtocol":2}') OR worker.verification @> '{"reviewProtocol":3}') AND (e.batch_id IS NULL OR worker.verification @> '{"reviewProtocol":3}') ORDER BY e.created_at LIMIT 20 LOOP
  PERFORM 1 FROM agentonic.workspaces WHERE id=candidate.workspace_id FOR SHARE;
  SELECT * INTO candidate FROM agentonic.evaluation_runs WHERE id=candidate.id AND status='queued' FOR UPDATE SKIP LOCKED;
  IF candidate.id IS NOT NULL AND agentonic.evaluation_authorized(candidate) THEN
   UPDATE agentonic.evaluation_runs SET status='running',worker_id=worker.id,lease_token=token,lease_until=clock_timestamp()+interval '90 seconds',started_at=clock_timestamp() WHERE id=candidate.id;
   RETURN jsonb_build_object('id',candidate.id,'token',token,'kind','retrieve','caseCount',jsonb_array_length(candidate.dataset_snapshot));
  END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION agentonic.review_preparation_claim(worker_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE worker agentonic.evaluation_workers;p agentonic.evaluation_preparations;t uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO worker FROM agentonic.evaluation_workers WHERE database_role=agentonic.application_role() AND environment='azure_staging' AND worker_sha256=worker_hash AND revoked_at IS NULL AND retired_at IS NULL AND verified_at>clock_timestamp()-interval '7 days' AND (verification @> '{"reviewProtocol":2}' OR verification @> '{"reviewProtocol":3}');
 IF worker.id IS NULL THEN RETURN NULL; END IF;
 FOR p IN SELECT * FROM agentonic.evaluation_preparations WHERE status IN ('queued','preparing') ORDER BY created_at LIMIT 50 LOOP
  PERFORM 1 FROM agentonic.workspaces WHERE id=p.workspace_id FOR SHARE;
  SELECT * INTO p FROM agentonic.evaluation_preparations WHERE id=p.id FOR UPDATE SKIP LOCKED;
  IF p.id IS NULL THEN CONTINUE; END IF;
  IF NOT agentonic.preparation_authorized(p) OR (p.status='preparing' AND (p.lease_until<=clock_timestamp() OR p.started_at<clock_timestamp()-interval '5 minutes')) THEN
   UPDATE agentonic.evaluation_preparations SET status='error',lease_token=NULL,lease_until=NULL,finished_at=clock_timestamp() WHERE id=p.id;
  ELSIF p.status='queued' AND EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=p.code_release_id AND agentonic.evaluator_runs(worker.id,artifact_sha256)) THEN
   UPDATE agentonic.evaluation_preparations SET status='preparing',worker_id=worker.id,lease_token=t,lease_until=clock_timestamp()+interval '90 seconds',started_at=clock_timestamp() WHERE id=p.id;
   RETURN jsonb_build_object('id',p.id,'token',t,'kind','prepare');
  END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION agentonic.evaluation_worker(operation text,run_id uuid,token uuid,payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE e agentonic.evaluation_runs; worker agentonic.evaluation_workers; config agentonic.configuration_releases; code agentonic.code_releases;
 sources jsonb; hits jsonb; assets jsonb; test_case jsonb; checks jsonb; passed boolean; amount bigint;
 budget agentonic.retrieval_provider_budgets; meter agentonic.retrieval_provider_operations; p agentonic.evaluation_preparations; assessment jsonb; decision_id uuid;
BEGIN
 SELECT * INTO worker FROM agentonic.evaluation_workers WHERE database_role=agentonic.application_role() AND revoked_at IS NULL AND retired_at IS NULL AND verified_at>clock_timestamp()-interval '7 days';
 SELECT * INTO e FROM agentonic.evaluation_runs WHERE id=run_id;
 IF worker.id IS NULL OR e.id IS NULL OR e.worker_id IS DISTINCT FROM worker.id THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=e.workspace_id FOR SHARE;
 SELECT * INTO p FROM agentonic.evaluation_preparations WHERE id=e.preparation_id FOR UPDATE;
 SELECT * INTO e FROM agentonic.evaluation_runs WHERE id=run_id FOR UPDATE;
 IF e.preparation_id IS NOT NULL AND (worker.environment<>'azure_staging' OR NOT (worker.verification @> '{"reviewProtocol":2}' OR worker.verification @> '{"reviewProtocol":3}')) THEN RAISE insufficient_privilege; END IF;
 IF e.batch_id IS NOT NULL AND NOT worker.verification @> '{"reviewProtocol":3}' THEN RAISE insufficient_privilege; END IF;
 IF e.status<>'running' OR e.lease_token IS DISTINCT FROM token OR e.lease_until<=clock_timestamp() OR e.started_at<clock_timestamp()-interval '30 minutes' THEN RAISE insufficient_privilege; END IF;
 IF operation='fail' THEN
  UPDATE agentonic.evaluation_preparations SET status='error',finished_at=clock_timestamp() WHERE id=e.preparation_id AND status='evaluating';
  UPDATE agentonic.evaluation_runs SET status='error',error_code=CASE WHEN payload->>'code' IN ('provider_unavailable','budget_exhausted','configuration_required','lease_lost','runtime_mismatch') THEN payload->>'code' ELSE 'lease_lost' END,lease_token=NULL,lease_until=NULL,current_matches='[]',finished_at=clock_timestamp() WHERE id=e.id;
  RETURN '{"ok":true}';
 END IF;
 IF NOT agentonic.evaluation_authorized(e) THEN RAISE insufficient_privilege; END IF;
 SELECT * INTO config FROM agentonic.configuration_releases WHERE id=e.configuration_release_id;
 SELECT * INTO code FROM agentonic.code_releases WHERE id=e.code_release_id;
 IF NOT agentonic.evaluator_runs(worker.id,code.artifact_sha256) THEN RAISE insufficient_privilege; END IF;
 test_case:=e.dataset_snapshot->e.next_case;
 IF operation='heartbeat' THEN
  UPDATE agentonic.evaluation_runs SET lease_until=clock_timestamp()+interval '90 seconds' WHERE id=e.id;
  RETURN '{"ok":true}';
 ELSIF operation='read' THEN
  RETURN jsonb_build_object('reviewProtocol',CASE WHEN e.preparation_id IS NULL THEN 1 ELSE 2 END,'kind','retrieve','workspaceId',e.workspace_id,'query',test_case->>'question','generateAnswer',true,'preview',true,'hasCollections',jsonb_array_length(config.requested_access_snapshot->'collectionIds')>0,
  'runtime',jsonb_build_object('gitCommit',code.git_commit_sha,'artifactSha256',code.artifact_sha256,'manifest',code.execution_manifest));
 ELSIF operation='reserve' THEN
  IF NOT coalesce((payload->>'provider'='voyage' AND (payload->>'model'='voyage-4' OR payload->>'model'='rerank-2.5-lite')) OR (payload->>'provider'='openai' AND payload->>'model' IN (e.response_model,e.grader_snapshot->>'model')),false) THEN RAISE insufficient_privilege; END IF;
  amount:=(payload->>'microusd')::bigint;
  IF amount IS NULL OR amount NOT BETWEEN 1 AND 5000000 THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO budget FROM agentonic.retrieval_provider_budgets WHERE provider=payload->>'provider' FOR UPDATE;
  IF budget.provider IS NULL THEN RAISE insufficient_privilege; END IF;
  IF (p.id IS NOT NULL AND e.batch_id IS NULL AND p.committed_microusd+amount>p.budget_usd*1000000) OR e.committed_microusd+amount>e.budget_usd*1000000 OR budget.committed_microusd+amount>budget.cap_microusd THEN RETURN '{"ok":false,"code":"budget_exhausted"}'; END IF;
  IF e.batch_id IS NOT NULL AND (SELECT coalesce(sum(committed_microusd),0) FROM agentonic.evaluation_runs WHERE batch_id=e.batch_id)+amount>e.budget_usd*1000000 THEN RETURN '{"ok":false,"code":"budget_exhausted"}'; END IF;
  INSERT INTO agentonic.retrieval_provider_operations(id,job_id,workspace_id,provider,model,reserved_microusd,agent_id) VALUES((payload->>'id')::uuid,e.id,e.workspace_id,budget.provider,payload->>'model',amount,e.agent_id);
  UPDATE agentonic.retrieval_provider_budgets SET committed_microusd=committed_microusd+amount,updated_at=clock_timestamp() WHERE provider=budget.provider;
  UPDATE agentonic.evaluation_runs SET committed_microusd=committed_microusd+amount WHERE id=e.id;
  UPDATE agentonic.evaluation_preparations SET committed_microusd=committed_microusd+amount WHERE id=p.id;
  RETURN '{"ok":true}';
 ELSIF operation='settle' THEN
  SELECT * INTO meter FROM agentonic.retrieval_provider_operations WHERE id=(payload->>'id')::uuid AND job_id=e.id AND status='reserved' FOR UPDATE;
  amount:=(payload->>'microusd')::bigint;
  IF meter.id IS NULL OR amount IS NULL OR amount<0 OR payload->>'tokens' IS NULL OR (payload->>'tokens')::bigint<0 OR coalesce((payload->>'outputTokens')::bigint,0)<0 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.retrieval_provider_operations SET status='settled',actual_microusd=amount,input_tokens=(payload->>'tokens')::bigint,output_tokens=coalesce((payload->>'outputTokens')::bigint,0) WHERE id=meter.id;
  UPDATE agentonic.retrieval_provider_budgets SET committed_microusd=committed_microusd-meter.reserved_microusd+amount,updated_at=clock_timestamp() WHERE provider=meter.provider;
  UPDATE agentonic.evaluation_runs SET committed_microusd=committed_microusd-meter.reserved_microusd+amount WHERE id=e.id;
  UPDATE agentonic.evaluation_preparations SET committed_microusd=committed_microusd-meter.reserved_microusd+amount WHERE id=p.id;
  RETURN '{"ok":true}';
 ELSIF operation='empty-search' THEN
  IF jsonb_array_length(config.requested_access_snapshot->'collectionIds')<>0 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.evaluation_runs SET current_matches='[]' WHERE id=e.id;
  RETURN '{"ok":true}';
 ELSIF operation='search' THEN
  IF jsonb_typeof(payload->'embedding') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'embedding')<>1024 THEN RAISE insufficient_privilege; END IF;
  WITH eligible AS MATERIALIZED (
   SELECT c.* FROM agentonic.document_chunks c JOIN agentonic.document_versions v ON v.id=c.document_version_id JOIN agentonic.documents d ON d.id=v.document_id AND d.active_version_id=v.id JOIN agentonic.knowledge_sources s ON s.id=d.source_id
   WHERE c.workspace_id=e.workspace_id AND d.deleted_at IS NULL AND v.status='ready'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(config.requested_access_snapshot->'collections') col CROSS JOIN LATERAL jsonb_array_elements(col->'sources') src WHERE src->>'id'=s.id::text)
  ), semantic AS (
   SELECT id,row_number() OVER(ORDER BY embedding OPERATOR(public.<=>) (payload->'embedding')::text::public.vector,id) rank FROM eligible ORDER BY embedding OPERATOR(public.<=>) (payload->'embedding')::text::public.vector,id LIMIT 40
  ), lexical AS (
   SELECT id,row_number() OVER(ORDER BY ts_rank_cd(search_vector,q) DESC,id) rank FROM eligible,LATERAL(SELECT websearch_to_tsquery('pg_catalog.simple',test_case->>'question')||websearch_to_tsquery('pg_catalog.spanish',test_case->>'question')||websearch_to_tsquery('pg_catalog.english',test_case->>'question') q) query WHERE search_vector@@q ORDER BY ts_rank_cd(search_vector,q) DESC,id LIMIT 40
  ), ranked AS (
   SELECT coalesce(s.id,l.id) id,coalesce(1.0/(60+s.rank),0)+coalesce(1.0/(60+l.rank),0) score FROM semantic s FULL JOIN lexical l ON s.id=l.id ORDER BY score DESC,coalesce(s.id,l.id) LIMIT CASE WHEN payload->>'rerank'='true' THEN 32 ELSE 8 END
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'hash',c.content_sha256) ORDER BY r.score DESC,r.id),'[]') INTO hits FROM ranked r JOIN agentonic.document_chunks c ON c.id=r.id;
  UPDATE agentonic.evaluation_runs SET current_matches=hits WHERE id=e.id;
  RETURN '{"ok":true}';
 ELSIF operation IN ('context','grade-context','answer','rerank-context','select-matches') THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'text',c.content) ORDER BY hit.ordinality),'[]') INTO hits
  FROM jsonb_array_elements(e.current_matches) WITH ORDINALITY hit(value,ordinality)
  JOIN agentonic.document_chunks c ON c.id=(hit.value->>'id')::uuid AND c.workspace_id=e.workspace_id AND c.content_sha256=hit.value->>'hash'
  JOIN agentonic.document_versions v ON v.id=c.document_version_id JOIN agentonic.documents d ON d.id=v.document_id AND d.active_version_id=v.id
  WHERE d.deleted_at IS NULL AND v.status='ready';
  IF jsonb_array_length(hits)<>jsonb_array_length(e.current_matches) THEN RAISE insufficient_privilege; END IF;
  IF operation='rerank-context' THEN RETURN jsonb_build_object('passages',hits); END IF;
  IF operation='select-matches' THEN
   IF EXISTS(SELECT 1 FROM agentonic.retrieval_provider_operations op WHERE op.job_id=e.id AND op.status='reserved') THEN RAISE insufficient_privilege; END IF;
   hits:=agentonic.select_retrieval_matches(e.current_matches,payload->'ids');
   UPDATE agentonic.evaluation_runs SET current_matches=hits WHERE id=e.id;
   RETURN '{"ok":true}';
  END IF;
  IF jsonb_array_length(hits)>8 THEN RAISE insufficient_privilege; END IF;
  IF operation='grade-context' AND p.id IS NOT NULL THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'text',c.content)),'[]') INTO sources FROM agentonic.document_chunks c
   WHERE c.workspace_id=p.workspace_id AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(test_case->'sourceIds') src WHERE src=c.id::text);
   RETURN jsonb_build_object('criterion',test_case,'passages',hits,'references',sources,'configuration',config.content,'requestedAccess',config.requested_access_snapshot,'evaluationScope','isolated-readonly','rubricVersion',e.grader_snapshot->>'version');
  END IF;
  IF operation='context' THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('path','skills/'||(s->>'name')||'.md','sha256',encode(sha256(convert_to(s->>'instructions','UTF8')),'hex')) ORDER BY s->>'name'),'[]') INTO assets FROM jsonb_array_elements(config.content->'skills') s;
   assets:=jsonb_build_array(jsonb_build_object('path','prompts/system.md','sha256',encode(sha256(convert_to(config.content->>'systemPrompt','UTF8')),'hex')))||assets;
   RETURN jsonb_build_object('previewModel',e.response_model,'reasoningLevel',e.reasoning_effort,'query',test_case->>'question','passages',hits,'environment','staging','audience','private','expiresAt',least(e.expires_at,e.started_at+interval '30 minutes'),
   'configurationJson',config.content::text,'contentSha256',config.content_sha256,'composedPromptSha256',config.composed_prompt_sha256,'assetManifestJson',assets::text,'assetManifestSha256',config.asset_manifest_sha256,'accessJson',config.requested_access_snapshot::text,'accessSha256',config.requested_access_sha256,'history','[]'::jsonb);
  END IF;
  IF jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' OR length(payload->>'text') NOT BETWEEN 1 AND 12000 OR jsonb_typeof(payload->'citations') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'citations')>8 OR jsonb_typeof(payload->'insufficientEvidence') IS DISTINCT FROM 'boolean' OR payload->>'model' IS DISTINCT FROM e.response_model
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(payload->'citations') citation WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(hits) h WHERE h->>'id'=citation)) THEN RAISE insufficient_privilege; END IF;
  IF (p.id IS NOT NULL AND e.batch_id IS NULL AND p.committed_microusd>p.budget_usd*1000000) OR e.committed_microusd>e.budget_usd*1000000 OR EXISTS(SELECT 1 FROM agentonic.retrieval_provider_operations WHERE job_id=e.id AND status='reserved') THEN RAISE insufficient_privilege; END IF;
  IF p.id IS NULL THEN
  checks:=jsonb_build_object('abstention',payload->'insufficientEvidence'=test_case->'insufficientEvidence','citations',payload->'insufficientEvidence'='true' OR jsonb_array_length(payload->'citations')>0,
  'requiredPhrases',NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(test_case->'requiredPhrases') phrase WHERE strpos(lower(payload->>'text'),lower(phrase))=0),
  'forbiddenPhrases',NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(test_case->'forbiddenPhrases') phrase WHERE strpos(lower(payload->>'text'),lower(phrase))>0));
  ELSE
   assessment:=payload->'assessment';
   IF jsonb_typeof(assessment) IS DISTINCT FROM 'object' OR NOT(assessment ?& ARRAY['verdict','explanation','suggestion','grounded','meetsExpectation','safe','routine','confidence'])
   OR assessment-ARRAY['verdict','explanation','suggestion','grounded','meetsExpectation','safe','routine','confidence']<>'{}'
   OR assessment->>'verdict' NOT IN ('passed','needs_changes','uncertain') OR assessment->>'confidence' NOT IN ('high','low')
   OR jsonb_typeof(assessment->'explanation') IS DISTINCT FROM 'string' OR length(assessment->>'explanation') NOT BETWEEN 1 AND 1500
   OR jsonb_typeof(assessment->'suggestion') IS DISTINCT FROM 'string' OR length(assessment->>'suggestion')>1500
   OR EXISTS(SELECT 1 FROM unnest(ARRAY['grounded','meetsExpectation','safe','routine']) k WHERE jsonb_typeof(assessment->k) IS DISTINCT FROM 'boolean') THEN RAISE insufficient_privilege; END IF;
   checks:=jsonb_build_object('semantic',assessment->>'verdict'='passed' AND assessment->>'confidence'='high',
   'grounded',assessment->'grounded','expectation',assessment->'meetsExpectation','safe',assessment->'safe',
   'platform',test_case->>'kind'<>'platform' OR payload->'insufficientEvidence'='true',
   'citations',payload->'insufficientEvidence'='true' OR test_case->>'kind'='platform' OR jsonb_array_length(test_case->'sourceIds')=0 OR jsonb_array_length(payload->'citations')>0);
  END IF;
  passed:=NOT EXISTS(SELECT 1 FROM jsonb_each(checks) c WHERE c.value<>'true'::jsonb);
  INSERT INTO agentonic.evaluation_results(workspace_id,evaluation_run_id,case_key,outcome,answer,citations,evidence_sources,checks,assessment)
  VALUES(e.workspace_id,e.id,test_case->>'key',CASE WHEN passed THEN 'passed' ELSE 'failed' END,payload->>'text',payload->'citations',e.current_matches,checks,assessment);
  IF e.next_case+1=jsonb_array_length(e.dataset_snapshot) THEN
   passed:=NOT EXISTS(SELECT 1 FROM agentonic.evaluation_results WHERE evaluation_run_id=e.id AND outcome<>'passed');
   SELECT jsonb_agg(jsonb_build_object('key',case_key,'outcome',outcome,'answer',answer,'citations',citations,'sources',evidence_sources,'checks',result.checks,'assessment',result.assessment) ORDER BY case_key) INTO sources FROM agentonic.evaluation_results result WHERE evaluation_run_id=e.id;
   UPDATE agentonic.evaluation_runs SET status=CASE WHEN passed THEN 'passed' ELSE 'failed' END,next_case=next_case+1,current_matches='[]',lease_token=NULL,lease_until=NULL,finished_at=clock_timestamp(),
   evidence_sha256=agentonic.content_hash(jsonb_build_object('results',sources,'dataset',e.dataset_sha256,'grader',e.grader_sha256,'configuration',e.configuration_sha256,'access',e.requested_access_sha256,'runtime',code.artifact_sha256,'worker',worker.worker_sha256,'environment',worker.environment,'executionModel',e.response_model,'reasoning',e.reasoning_effort,'batch',e.batch_id)) WHERE id=e.id;

   IF p.id IS NOT NULL AND (e.batch_id IS NULL OR NOT EXISTS(SELECT 1 FROM agentonic.evaluation_runs WHERE batch_id=e.batch_id AND status IN ('queued','running'))) THEN
    SELECT * INTO e FROM agentonic.evaluation_runs WHERE id=run_id;
    IF passed AND agentonic.review_auto_eligible(e,true) THEN
     INSERT INTO agentonic.submission_review_decisions(workspace_id,agent_id,submission_id,decision_number,decision,actor_policy_version,feedback,approval_expires_at,approved_access_sha256,assessment_snapshot)
     SELECT e.workspace_id,e.agent_id,e.submission_id,coalesce(max(decision_number),0)+1,'approved','readonly-review-v1','La versión superó los criterios confirmados y los controles de la plataforma.',least(clock_timestamp()+interval '24 hours',e.expires_at),e.requested_access_sha256,
     jsonb_build_object('version',3,'evaluationId',e.id,'evidenceHash',e.evidence_sha256,'configurationHash',e.configuration_sha256,'requestedAccessHash',e.requested_access_sha256,'evaluated',true,'humanReviewed',false,'policy','readonly-review-v1')
     FROM agentonic.submission_review_decisions WHERE submission_id=e.submission_id RETURNING id INTO decision_id;
     UPDATE agentonic.agent_submissions SET status='approved' WHERE id=e.submission_id;
     UPDATE agentonic.evaluation_preparations SET status='approved',finished_at=clock_timestamp() WHERE id=p.id;
    ELSE
     UPDATE agentonic.evaluation_preparations SET status=CASE WHEN EXISTS(SELECT 1 FROM agentonic.evaluation_results r JOIN agentonic.evaluation_runs failed_run ON failed_run.id=r.evaluation_run_id WHERE (failed_run.id=e.id OR e.batch_id IS NOT NULL AND failed_run.batch_id=e.batch_id) AND r.outcome='failed' AND r.assessment->>'verdict'='needs_changes') THEN 'needs_changes' ELSE 'needs_attention' END,finished_at=clock_timestamp() WHERE id=p.id;
    END IF;
   END IF;
  ELSE
   UPDATE agentonic.evaluation_runs SET next_case=next_case+1,current_matches='[]' WHERE id=e.id;
  END IF;
  RETURN '{"ok":true}';
 END IF;
 RAISE insufficient_privilege;
END $$;
CREATE OR REPLACE FUNCTION agentonic.review_preparation_worker(operation text,preparation_id uuid,token uuid,payload jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE p agentonic.evaluation_preparations;worker agentonic.evaluation_workers;config agentonic.configuration_releases;hits jsonb;result jsonb;previous jsonb;amount bigint;budget agentonic.retrieval_provider_budgets;meter agentonic.retrieval_provider_operations;
BEGIN
 SELECT * INTO p FROM agentonic.evaluation_preparations WHERE id=preparation_id;
 IF p.id IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=p.workspace_id FOR SHARE;
 SELECT * INTO p FROM agentonic.evaluation_preparations WHERE id=preparation_id FOR UPDATE;
 SELECT * INTO worker FROM agentonic.evaluation_workers WHERE id=p.worker_id AND database_role=agentonic.application_role() AND environment='azure_staging' AND revoked_at IS NULL AND retired_at IS NULL AND verified_at>clock_timestamp()-interval '7 days' AND (verification @> '{"reviewProtocol":2}' OR verification @> '{"reviewProtocol":3}');
 IF worker.id IS NULL OR p.status<>'preparing' OR p.lease_token IS DISTINCT FROM token OR p.lease_until<=clock_timestamp() OR p.started_at<clock_timestamp()-interval '5 minutes' THEN RAISE insufficient_privilege; END IF;
 IF operation='fail' THEN
  UPDATE agentonic.evaluation_preparations SET status='error',lease_token=NULL,lease_until=NULL,finished_at=clock_timestamp() WHERE id=p.id; RETURN '{"ok":true}';
 END IF;
 IF NOT agentonic.preparation_authorized(p) OR NOT agentonic.preparation_sources_current(p) THEN RAISE insufficient_privilege; END IF;
 SELECT * INTO config FROM agentonic.configuration_releases WHERE id=p.configuration_release_id;
 IF NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=p.code_release_id AND agentonic.evaluator_runs(worker.id,artifact_sha256)) THEN RAISE insufficient_privilege; END IF;
 IF operation='heartbeat' THEN
  UPDATE agentonic.evaluation_preparations SET lease_until=clock_timestamp()+interval '90 seconds' WHERE id=p.id; RETURN '{"ok":true}';
 ELSIF operation='reserve' THEN
  amount:=(payload->>'microusd')::bigint;
  IF payload->>'provider' IS DISTINCT FROM 'openai' OR payload->>'model' IS DISTINCT FROM 'gpt-4.1-mini-2025-04-14' OR amount IS NULL OR amount NOT BETWEEN 1 AND 1000000 THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO budget FROM agentonic.retrieval_provider_budgets WHERE provider='openai' FOR UPDATE;
  IF budget.provider IS NULL THEN RAISE insufficient_privilege; END IF;
  IF p.committed_microusd+amount>p.budget_usd*1000000 OR budget.committed_microusd+amount>budget.cap_microusd THEN RETURN '{"ok":false,"code":"budget_exhausted"}'; END IF;
  INSERT INTO agentonic.retrieval_provider_operations(id,job_id,workspace_id,provider,model,reserved_microusd,agent_id) VALUES((payload->>'id')::uuid,p.id,p.workspace_id,'openai','gpt-4.1-mini-2025-04-14',amount,p.agent_id);
  UPDATE agentonic.retrieval_provider_budgets SET committed_microusd=committed_microusd+amount,updated_at=clock_timestamp() WHERE provider='openai';
  UPDATE agentonic.evaluation_preparations SET committed_microusd=committed_microusd+amount WHERE id=p.id; RETURN '{"ok":true}';
 ELSIF operation='settle' THEN
  SELECT * INTO meter FROM agentonic.retrieval_provider_operations WHERE id=(payload->>'id')::uuid AND job_id=p.id AND status='reserved' FOR UPDATE;
  amount:=(payload->>'microusd')::bigint;
  IF meter.id IS NULL OR amount IS NULL OR amount<0 OR payload->>'tokens' IS NULL OR (payload->>'tokens')::bigint<0 OR coalesce((payload->>'outputTokens')::bigint,0)<0 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.retrieval_provider_operations SET status='settled',actual_microusd=amount,input_tokens=(payload->>'tokens')::bigint,output_tokens=coalesce((payload->>'outputTokens')::bigint,0) WHERE id=meter.id;
  UPDATE agentonic.retrieval_provider_budgets SET committed_microusd=committed_microusd-meter.reserved_microusd+amount,updated_at=clock_timestamp() WHERE provider=meter.provider;
  UPDATE agentonic.evaluation_preparations SET committed_microusd=committed_microusd-meter.reserved_microusd+amount WHERE id=p.id; RETURN '{"ok":true}';
 ELSIF operation='read' THEN
  IF p.source_snapshot='[]' THEN
   WITH eligible AS (
    SELECT c.id,c.content_sha256,c.document_version_id,row_number() OVER(PARTITION BY c.document_version_id ORDER BY c.ordinal) n
    FROM agentonic.document_chunks c JOIN agentonic.document_versions v ON v.id=c.document_version_id JOIN agentonic.documents d ON d.id=v.document_id AND d.active_version_id=v.id
    WHERE c.workspace_id=p.workspace_id AND v.status='ready' AND d.deleted_at IS NULL
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(config.requested_access_snapshot->'collections') col CROSS JOIN LATERAL jsonb_array_elements(col->'sources') src WHERE src->>'id'=d.source_id::text)
   ),sample AS(SELECT * FROM eligible ORDER BY n,document_version_id,id LIMIT 24)
   SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'hash',content_sha256) ORDER BY n,document_version_id,id),'[]') INTO hits FROM sample;
   UPDATE agentonic.evaluation_preparations SET source_snapshot=hits WHERE id=p.id; p.source_snapshot:=hits;
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'text',c.content) ORDER BY ord),'[]') INTO result FROM jsonb_array_elements(p.source_snapshot) WITH ORDINALITY x(hit,ord) JOIN agentonic.document_chunks c ON c.id=(hit->>'id')::uuid AND c.workspace_id=p.workspace_id;
  SELECT prior.criteria INTO previous FROM agentonic.evaluation_preparations prior WHERE prior.agent_id=p.agent_id AND prior.workspace_id=p.workspace_id AND prior.id<>p.id AND prior.confirmed_at IS NOT NULL AND agentonic.preparation_authorized(prior,true) AND agentonic.preparation_sources_current(prior) ORDER BY prior.created_at DESC LIMIT 1;
  RETURN jsonb_build_object('configuration',config.content,'sources',result,'previousCriteria',coalesce(previous,'[]'::jsonb));
 ELSIF operation='prepared' THEN
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'criteria') c WHERE c ? 'reviewDecision') OR NOT agentonic.valid_review_criteria(payload->'criteria') OR payload->>'risk' IS NULL OR payload->>'risk' NOT IN ('routine','sensitive','uncertain') OR payload-ARRAY['criteria','risk']<>'{}'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'criteria') c WHERE c->'excluded'<>'false' OR c->>'notes'<>'' OR c->>'exclusionReason'<>''
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(c->'sourceIds') source_id WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.source_snapshot) h WHERE h->>'id'=source_id)))
  OR NOT EXISTS(SELECT 1 FROM agentonic.retrieval_provider_operations WHERE job_id=p.id AND status='settled')
  OR EXISTS(SELECT 1 FROM agentonic.retrieval_provider_operations WHERE job_id=p.id AND status='reserved') OR p.committed_microusd>p.budget_usd*1000000 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.evaluation_preparations SET status='criteria_ready',generated_criteria=payload->'criteria',criteria=payload->'criteria',risk=payload->>'risk',lease_token=NULL,lease_until=NULL,finished_at=clock_timestamp() WHERE id=p.id;
  INSERT INTO agentonic.evaluation_criteria_revisions(workspace_id,preparation_id,revision,criteria,content_sha256,edited_by_member_id) VALUES(p.workspace_id,p.id,0,payload->'criteria',agentonic.content_hash(payload->'criteria'),p.authorized_by_member_id);
  RETURN '{"ok":true}';
 END IF;
 RAISE insufficient_privilege;
END $$;
CREATE OR REPLACE FUNCTION agentonic.review_flow_command(operation text,payload jsonb,trace_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();s agentonic.agent_submissions;r agentonic.configuration_releases;p agentonic.evaluation_preparations; result_id uuid;allowed text[];dataset jsonb; batch agentonic.evaluation_batches; choice jsonb;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR agentonic.actor_user_id() IS NULL OR m IS NULL OR w IS NULL OR trace_id IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 allowed:=CASE operation WHEN 'prepare' THEN ARRAY['submissionId','budgetUsd','consent','requestId'] WHEN 'save' THEN ARRAY['preparationId','revision','criteria'] WHEN 'confirm' THEN ARRAY['preparationId','revision','consent'] WHEN 'run' THEN ARRAY['preparationId','revision','models','budgetUsd','consent','requestId'] WHEN 'cancel' THEN ARRAY['preparationId'] END;
 IF allowed IS NULL OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR payload-allowed<>'{}' OR NOT(payload ?& allowed) THEN RAISE insufficient_privilege; END IF;
 IF operation='prepare' THEN
  SELECT * INTO s FROM agentonic.agent_submissions WHERE id=(payload->>'submissionId')::uuid AND workspace_id=w;
  IF s.submitted_by_member_id IS DISTINCT FROM m OR s.status NOT IN ('submitted','in_review') OR payload->'consent' IS DISTINCT FROM 'true'::jsonb THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO p FROM agentonic.evaluation_preparations WHERE workspace_id=w AND authorized_by_member_id=m AND request_id=(payload->>'requestId')::uuid;
  IF p.id IS NOT NULL THEN
   IF p.submission_id IS DISTINCT FROM s.id OR p.budget_usd IS DISTINCT FROM (payload->>'budgetUsd')::numeric THEN RAISE insufficient_privilege; END IF;
   RETURN jsonb_build_object('ok',true,'id',p.id);
  END IF;
  IF EXISTS(SELECT 1 FROM agentonic.evaluation_runs WHERE submission_id=s.id AND status IN ('awaiting_consent','queued','running')) THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO r FROM agentonic.configuration_releases WHERE id=s.configuration_release_id;
  INSERT INTO agentonic.evaluation_preparations(workspace_id,agent_id,submission_id,code_release_id,configuration_release_id,authorized_by_member_id,request_id,configuration_sha256,requested_access_sha256,budget_usd,expires_at)
  VALUES(w,s.agent_id,s.id,s.code_release_id,s.configuration_release_id,m,(payload->>'requestId')::uuid,r.content_sha256,r.requested_access_sha256,(payload->>'budgetUsd')::numeric,least(clock_timestamp()+interval '7 days',(s.review_consent->>'expiresAt')::timestamptz)) RETURNING * INTO p;
  IF NOT agentonic.preparation_authorized(p) THEN RAISE insufficient_privilege; END IF;
  result_id:=p.id;
 ELSE
  SELECT * INTO p FROM agentonic.evaluation_preparations WHERE id=(payload->>'preparationId')::uuid AND workspace_id=w FOR UPDATE;
  IF p.id IS NULL OR p.authorized_by_member_id IS DISTINCT FROM m OR NOT agentonic.member_can_author(m,p.agent_id) THEN RAISE insufficient_privilege; END IF;
  result_id:=p.id;
  IF operation='cancel' THEN
   UPDATE agentonic.evaluation_preparations SET status='cancelled',consent_revoked_at=coalesce(consent_revoked_at,clock_timestamp()),lease_token=NULL,lease_until=NULL WHERE id=p.id;
   UPDATE agentonic.evaluation_runs SET consent_revoked_at=coalesce(consent_revoked_at,clock_timestamp()),status=CASE WHEN status IN ('awaiting_consent','queued','running') THEN 'cancelled' ELSE status END,lease_token=NULL,lease_until=NULL,current_matches='[]' WHERE preparation_id=p.id;
  ELSE
   IF p.status IN ('queued','preparing','cancelled') OR NOT agentonic.preparation_authorized(p,true) OR NOT agentonic.preparation_sources_current(p) THEN RAISE insufficient_privilege; END IF;
   IF operation='run' THEN
    SELECT * INTO batch FROM agentonic.evaluation_batches WHERE preparation_id=p.id AND request_id=(payload->>'requestId')::uuid;
    IF batch.id IS NOT NULL THEN
     IF batch.revision IS DISTINCT FROM (payload->>'revision')::integer OR batch.models IS DISTINCT FROM payload->'models' OR batch.budget_usd IS DISTINCT FROM (payload->>'budgetUsd')::numeric OR payload->'consent' IS DISTINCT FROM 'true'::jsonb THEN RAISE insufficient_privilege; END IF;
     RETURN jsonb_build_object('ok',true,'id',batch.id);
    END IF;
   END IF;
   IF EXISTS(SELECT 1 FROM agentonic.evaluation_runs WHERE submission_id=p.submission_id AND status IN ('queued','running','awaiting_consent')) THEN RETURN '{"ok":false,"code":"busy"}'; END IF;
   IF (payload->>'revision')::integer IS DISTINCT FROM p.revision THEN RETURN '{"ok":false,"code":"conflict"}'; END IF;
   IF operation='save' THEN
    IF NOT agentonic.valid_review_criteria(payload->'criteria') THEN RAISE insufficient_privilege; END IF;
    -- Existing suggestions must remain, with an explicit exclusion reason. Users may
    -- edit expectations/add cases but cannot rewrite provenance or platform checks.
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(p.generated_criteria) original WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'criteria') edited WHERE edited->>'key'=original->>'key' AND edited->'basis'=original->'basis' AND edited->'sourceIds'=original->'sourceIds'))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'criteria') edited WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.generated_criteria) original WHERE original->>'key'=edited->>'key') AND (edited->'sourceIds'<>'[]' OR edited->>'basis'<>'Aportado por el cliente.')) THEN RAISE insufficient_privilege; END IF;
    UPDATE agentonic.evaluation_preparations SET criteria=payload->'criteria',revision=revision+1,confirmed_revision=NULL WHERE id=p.id;
    INSERT INTO agentonic.evaluation_criteria_revisions(workspace_id,preparation_id,revision,criteria,content_sha256,edited_by_member_id) VALUES(w,p.id,p.revision+1,payload->'criteria',agentonic.content_hash(payload->'criteria'),m);
   ELSIF operation='confirm' THEN
    IF payload->'consent' IS DISTINCT FROM 'true'::jsonb THEN RAISE insufficient_privilege; END IF;
    IF NOT agentonic.valid_review_criteria(p.criteria,true) THEN RETURN '{"ok":false,"code":"criteria_required"}'; END IF;
    UPDATE agentonic.evaluation_preparations SET confirmed_revision=revision,confirmed_at=coalesce(confirmed_at,clock_timestamp()) WHERE id=p.id;
   ELSIF operation='run' THEN
    IF payload->'consent' IS DISTINCT FROM 'true'::jsonb OR p.confirmed_revision IS DISTINCT FROM p.revision OR NOT agentonic.valid_review_criteria(p.criteria,true) THEN RETURN '{"ok":false,"code":"criteria_required"}'; END IF;
    IF jsonb_typeof(payload->'models') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'models') NOT BETWEEN 1 AND 16 THEN RAISE insufficient_privilege; END IF;
    IF (SELECT count(DISTINCT value) FROM jsonb_array_elements(payload->'models'))<>jsonb_array_length(payload->'models') THEN RAISE insufficient_privilege; END IF;
    FOR choice IN SELECT value FROM jsonb_array_elements(payload->'models') LOOP
     IF jsonb_typeof(choice) IS DISTINCT FROM 'object' OR choice-ARRAY['model','reasoning']<>'{}' OR NOT(choice ?& ARRAY['model','reasoning']) OR NOT agentonic.valid_model_configuration(choice->>'model',choice->>'reasoning') THEN RAISE insufficient_privilege; END IF;
    END LOOP;
    IF NOT EXISTS(SELECT 1 FROM agentonic.evaluation_workers worker JOIN agentonic.code_releases code ON code.id=p.code_release_id AND agentonic.evaluator_runs(worker.id,code.artifact_sha256) WHERE worker.environment='azure_staging' AND worker.revoked_at IS NULL AND worker.retired_at IS NULL AND worker.verified_at>clock_timestamp()-interval '7 days' AND worker.verification @> '{"reviewProtocol":3}') THEN RETURN '{"ok":false,"code":"worker_unavailable"}'; END IF;
    INSERT INTO agentonic.evaluation_batches(workspace_id,preparation_id,request_id,revision,criteria_sha256,models,budget_usd)
    VALUES(w,p.id,(payload->>'requestId')::uuid,p.revision,agentonic.content_hash(p.criteria),payload->'models',(payload->>'budgetUsd')::numeric) RETURNING * INTO batch;
    SELECT jsonb_agg((c-ARRAY['excluded','exclusionReason','needsInput','reviewDecision'])||'{"kind":"business"}'::jsonb ORDER BY n) INTO dataset FROM jsonb_array_elements(p.criteria) WITH ORDINALITY x(c,n) WHERE c->'excluded'='false';
    dataset:=dataset||agentonic.platform_review_cases();
    FOR choice IN SELECT value FROM jsonb_array_elements(batch.models) LOOP
     INSERT INTO agentonic.evaluation_runs(workspace_id,agent_id,submission_id,code_release_id,configuration_release_id,preparation_id,batch_id,response_model,reasoning_effort,authorized_by_member_id,authorized_at,environment,status,dataset_snapshot,dataset_sha256,grader_snapshot,grader_sha256,configuration_sha256,requested_access_sha256,budget_usd,expires_at)
     VALUES(w,p.agent_id,p.submission_id,p.code_release_id,p.configuration_release_id,p.id,batch.id,choice->>'model',choice->>'reasoning',m,batch.created_at,'azure_staging','queued',dataset,agentonic.content_hash(dataset),'{"version":"grounded-review-v3","model":"gpt-4.1-mini-2025-04-14","policy":"readonly-review-v1"}',agentonic.content_hash('{"version":"grounded-review-v3","model":"gpt-4.1-mini-2025-04-14","policy":"readonly-review-v1"}'),p.configuration_sha256,p.requested_access_sha256,batch.budget_usd,p.expires_at) RETURNING id INTO result_id;
    END LOOP;
    UPDATE agentonic.evaluation_preparations SET status='evaluating',evaluation_id=result_id,finished_at=NULL WHERE id=p.id;
    result_id:=batch.id;
   END IF;
  END IF;
 END IF;
 INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,action,resource_type,resource_id,outcome,request_id)
 VALUES(w,agentonic.actor_user_id(),m,'review_flow.'||operation,'evaluation_preparation',p.id::text,'succeeded',trace_id::text);
 RETURN jsonb_build_object('ok',true,'id',result_id);
END $$;
CREATE OR REPLACE FUNCTION agentonic.review_flow_state(target_id uuid,grant_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member(); customer boolean:=agentonic.application_role()='agentonic_customer';result jsonb;available boolean;
BEGIN
 IF agentonic.actor_user_id() IS NULL OR w IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR SHARE;
 IF NOT FOUND OR NOT ((customer AND agentonic.can_agent(target_id,'edit')) OR (agentonic.application_role()='agentonic_admin' AND agentonic.can_review(target_id,grant_id))) THEN RAISE insufficient_privilege; END IF;
 SELECT customer AND EXISTS(SELECT 1 FROM agentonic.agent_submissions s JOIN agentonic.code_releases code ON code.id=s.code_release_id
 WHERE s.agent_id=target_id AND s.workspace_id=w AND s.submitted_by_member_id=m AND s.status IN ('submitted','in_review') AND (s.review_consent->>'expiresAt')::timestamptz>clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM agentonic.evaluation_preparations p WHERE p.submission_id=s.id AND p.status IN ('queued','preparing','criteria_ready','evaluating'))
 AND NOT EXISTS(SELECT 1 FROM agentonic.evaluation_runs e WHERE e.submission_id=s.id AND e.status IN ('awaiting_consent','queued','running'))
 AND EXISTS(SELECT 1 FROM agentonic.evaluation_workers worker WHERE worker.environment='azure_staging' AND agentonic.evaluator_runs(worker.id,code.artifact_sha256) AND worker.revoked_at IS NULL AND worker.retired_at IS NULL AND worker.verified_at>clock_timestamp()-interval '7 days' AND (worker.verification @> '{"reviewProtocol":2}' OR worker.verification @> '{"reviewProtocol":3}'))) INTO available;
 WITH versions AS (
  SELECT id,workspace_id,agent_id,(row_number() OVER(PARTITION BY agent_id ORDER BY created_at,id))::integer AS number
  FROM agentonic.configuration_releases WHERE workspace_id=w
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object(
 'id',p.id,'submissionId',p.submission_id,'status',display_status,'revision',p.revision,'confirmedRevision',p.confirmed_revision,'batches',CASE WHEN live THEN agentonic.evaluation_batch_state(p) ELSE '[]'::jsonb END,'canRun',customer AND p.authorized_by_member_id=m AND live AND p.confirmed_revision=p.revision AND NOT EXISTS(SELECT 1 FROM agentonic.evaluation_runs active WHERE active.submission_id=p.submission_id AND active.status IN ('queued','running','awaiting_consent')),'criteria',CASE WHEN live THEN p.criteria ELSE '[]'::jsonb END,
 'agentName',CASE WHEN live THEN a.name ELSE NULL END,'versionNumber',CASE WHEN live THEN v.number ELSE NULL END,
 'originalCriteria',CASE WHEN live THEN coalesce((SELECT jsonb_agg(jsonb_build_object('key',original->>'key','question',original->>'question','expectedAnswer',original->>'expectedAnswer') ORDER BY ordinal)
   FROM jsonb_array_elements(p.generated_criteria) WITH ORDINALITY AS generated(original,ordinal)),'[]'::jsonb) ELSE '[]'::jsonb END,
 'budgetUsd',p.budget_usd,'committedMicrousd',p.committed_microusd,'expiresAt',p.expires_at,'evaluationId',p.evaluation_id,
 'canEdit',customer AND p.authorized_by_member_id=m AND p.status NOT IN ('queued','preparing','cancelled') AND live AND NOT EXISTS(SELECT 1 FROM agentonic.evaluation_runs active WHERE active.submission_id=p.submission_id AND active.status IN ('queued','running','awaiting_consent')),
 'canCancel',customer AND p.authorized_by_member_id=m AND p.consent_revoked_at IS NULL AND p.expires_at>clock_timestamp(),
 'canApprove',NOT customer AND p.status='needs_attention' AND agentonic.evaluation_approvable(e) AND EXISTS(SELECT 1 FROM agentonic.platform_staff WHERE id=agentonic.current_staff() AND role IN ('administrator','operator') AND disabled_at IS NULL),
 'evidenceHash',e.evidence_sha256,
 'summary',CASE WHEN NOT live THEN 'El acceso a esta revisión ya no está vigente. El consumo y el historial se conservan.' WHEN display_status='expired' THEN 'La aprobación de esta versión ya no está vigente. Se necesita evidencia vigente antes de activar la versión.' WHEN display_status='approved' THEN 'Esta versión superó los criterios confirmados y los controles de la plataforma. La aprobación no activa un despliegue.' WHEN p.status='needs_changes' THEN 'La evaluación encontró ajustes concretos. Revisa las observaciones y prepara una nueva versión.' WHEN p.status='needs_attention' THEN CASE WHEN p.risk='sensitive' THEN 'Por el alcance de este agente, el equipo debe revisar el resultado antes de aprobar.' WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(p.criteria) c WHERE c->'excluded'='true') THEN 'Hay situaciones excluidas por el cliente. El equipo revisará sus motivos antes de decidir.' ELSE 'La evaluación requiere aclarar el alcance o la evidencia. El equipo revisará las observaciones; no tienes que volver a revisar cada respuesta.' END WHEN p.status='error' THEN 'La revisión se interrumpió. Se conserva el consumo realizado; no se repetirá automáticamente.' WHEN p.status='criteria_ready' THEN 'La IA propone situaciones basadas en tus instrucciones y una muestra del conocimiento autorizado. Ajusta lo que esperas del agente antes de evaluar.' WHEN p.status='evaluating' THEN 'Estamos probando la versión y comparando sus respuestas con tus criterios y los controles de la plataforma.' ELSE 'La IA preparará una propuesta de criterios dentro del límite autorizado.' END,
 'results',CASE WHEN live AND agentonic.evaluation_sources_current(e) THEN coalesce((SELECT jsonb_agg(jsonb_build_object('key',r.case_key,'kind',test->>'kind','question',test->>'question','expectedAnswer',test->>'expectedAnswer','outcome',r.outcome,'answer',r.answer,'explanation',r.assessment->>'explanation','suggestion',r.assessment->>'suggestion','sources',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'text',c.content)) FROM agentonic.document_chunks c WHERE c.workspace_id=w AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.evidence_sources) src WHERE src->>'id'=c.id::text AND src->>'hash'=c.content_sha256)),'[]'::jsonb)) ORDER BY r.created_at,r.case_key) FROM agentonic.evaluation_results r CROSS JOIN LATERAL jsonb_array_elements(e.dataset_snapshot) test WHERE r.evaluation_run_id=e.id AND test->>'key'=r.case_key),'[]'::jsonb) ELSE '[]'::jsonb END,
 'sources',CASE WHEN live THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'text',c.content)) FROM agentonic.document_chunks c WHERE c.workspace_id=w AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.source_snapshot) src WHERE src->>'id'=c.id::text AND src->>'hash'=c.content_sha256)),'[]'::jsonb) ELSE '[]'::jsonb END
 ) ORDER BY p.created_at DESC),'[]'::jsonb) INTO result
 FROM agentonic.evaluation_preparations p
 JOIN agentonic.agents a ON a.id=p.agent_id AND a.workspace_id=p.workspace_id
 JOIN versions v ON v.id=p.configuration_release_id AND v.workspace_id=p.workspace_id AND v.agent_id=p.agent_id
 LEFT JOIN agentonic.evaluation_runs e ON e.id=p.evaluation_id
 CROSS JOIN LATERAL(SELECT CASE
 WHEN p.consent_revoked_at IS NOT NULL THEN 'cancelled'
 WHEN EXISTS(SELECT 1 FROM agentonic.agent_submissions s WHERE s.id=p.submission_id AND s.status='revoked') THEN 'revoked'
 WHEN EXISTS(SELECT 1 FROM agentonic.submission_review_decisions d JOIN agentonic.agent_submissions s ON s.id=d.submission_id WHERE s.id=p.submission_id AND s.status='approved' AND d.decision='approved' AND d.assessment_snapshot->>'evaluationId'=e.id::text) THEN CASE WHEN EXISTS(SELECT 1 FROM agentonic.submission_review_decisions d WHERE d.submission_id=p.submission_id AND d.decision='approved' AND d.assessment_snapshot->>'evaluationId'=e.id::text AND agentonic.version_approval_valid(d.id)) THEN 'approved' ELSE 'expired' END
 WHEN EXISTS(SELECT 1 FROM agentonic.evaluation_runs r WHERE r.preparation_id=p.id AND r.status IN ('queued','running')) THEN 'evaluating' WHEN p.status='evaluating' THEN 'error' ELSE p.status END display_status) presentation
 CROSS JOIN LATERAL(SELECT agentonic.preparation_authorized(p,true) AND agentonic.preparation_sources_current(p) live) access
 WHERE p.workspace_id=w AND (p.agent_id=target_id OR p.submission_id=target_id) AND (customer AND p.authorized_by_member_id=m OR NOT customer AND agentonic.can_review(p.submission_id,grant_id));
 RETURN jsonb_build_object('canPrepare',available,'canDecide',CASE WHEN customer THEN false ELSE agentonic.can_record_review_decision(target_id,grant_id) END,'preparations',result);
END $$;
COMMIT;
