BEGIN;
-- This slice enables private, read-only local/Azure staging only. No production grants.
CREATE TABLE agentonic.runtime_hosts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment text NOT NULL UNIQUE CHECK(environment IN ('local','azure_staging')),
 database_role text NOT NULL UNIQUE CHECK(database_role IN ('agentonic_deployer_local','agentonic_deployer_azure')),
 broker_sha256 text NOT NULL CHECK(broker_sha256 ~ '^[a-f0-9]{64}$'), runtime_sha256 text NOT NULL CHECK(runtime_sha256 ~ '^[a-f0-9]{64}$'),
 verified_at timestamptz NOT NULL, revoked_at timestamptz, heartbeat_at timestamptz,
 CHECK((environment='local')=(database_role='agentonic_deployer_local'))
);
ALTER TABLE agentonic.submission_review_decisions ADD UNIQUE(workspace_id,agent_id,submission_id,id);
CREATE TABLE agentonic.deployments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, agent_id uuid NOT NULL, code_release_id uuid NOT NULL,
 configuration_release_id uuid NOT NULL, submission_id uuid NOT NULL, approval_id uuid NOT NULL, host_id uuid NOT NULL REFERENCES agentonic.runtime_hosts(id),
 environment text NOT NULL CHECK(environment IN ('local','azure_staging')), authorized_by_member_id uuid NOT NULL, requested_by_staff_id uuid REFERENCES agentonic.platform_staff(id),
 request_id uuid NOT NULL, status text NOT NULL DEFAULT 'awaiting_activation' CHECK(status IN ('awaiting_activation','queued','preparing','running','stopped','failed','superseded')),
 desired_state text NOT NULL DEFAULT 'stopped' CHECK(desired_state IN ('running','stopped')), service_token_sha256 text, generation bigint NOT NULL DEFAULT 0,
 budget_usd numeric(20,8) NOT NULL CHECK(budget_usd BETWEEN 0.05 AND 1), committed_microusd bigint NOT NULL DEFAULT 0 CHECK(committed_microusd>=0),
 evidence_sources jsonb NOT NULL, authorized_until timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 activated_at timestamptz, heartbeat_at timestamptz, error_code text, manifest_sha256 text,
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,agent_id,id), UNIQUE(workspace_id,authorized_by_member_id,request_id),
 FOREIGN KEY(workspace_id,agent_id,code_release_id,configuration_release_id,submission_id) REFERENCES agentonic.agent_submissions(workspace_id,agent_id,code_release_id,configuration_release_id,id),
 FOREIGN KEY(workspace_id,agent_id,submission_id,approval_id) REFERENCES agentonic.submission_review_decisions(workspace_id,agent_id,submission_id,id),
 FOREIGN KEY(workspace_id,authorized_by_member_id) REFERENCES agentonic.workspace_members(workspace_id,id),
 CHECK(authorized_until>created_at AND authorized_until<=created_at+interval '7 days'),
 CHECK(service_token_sha256 IS NULL OR service_token_sha256 ~ '^[a-f0-9]{64}$'), CHECK(manifest_sha256 IS NULL OR manifest_sha256 ~ '^[a-f0-9]{64}$')
);
CREATE TABLE agentonic.agent_environments (
 workspace_id uuid NOT NULL, agent_id uuid NOT NULL, environment text NOT NULL CHECK(environment IN ('local','azure_staging')),
 current_deployment_id uuid, PRIMARY KEY(workspace_id,agent_id,environment),
 FOREIGN KEY(workspace_id,agent_id) REFERENCES agentonic.agents(workspace_id,id),
 FOREIGN KEY(workspace_id,agent_id,current_deployment_id) REFERENCES agentonic.deployments(workspace_id,agent_id,id)
);
CREATE UNIQUE INDEX deployment_preparing_slot ON agentonic.deployments(workspace_id,agent_id,environment) WHERE status IN ('queued','preparing');
CREATE UNIQUE INDEX deployment_running_slot ON agentonic.deployments(workspace_id,agent_id,environment) WHERE status='running';
CREATE TABLE agentonic.staging_conversations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, agent_id uuid NOT NULL, deployment_id uuid NOT NULL,
 owner_member_id uuid NOT NULL, title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 100),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL, closed_at timestamptz,
 UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,agent_id,deployment_id) REFERENCES agentonic.deployments(workspace_id,agent_id,id),
 FOREIGN KEY(workspace_id,owner_member_id) REFERENCES agentonic.workspace_members(workspace_id,id),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '7 days')
);
CREATE TABLE agentonic.staging_turns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, conversation_id uuid NOT NULL, request_id uuid NOT NULL,
 number integer NOT NULL CHECK(number BETWEEN 1 AND 100), query text NOT NULL CHECK(length(query)<=1000),
 answer text, citations jsonb NOT NULL DEFAULT '[]', matches jsonb NOT NULL DEFAULT '[]', insufficient_evidence boolean,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
 lease_token uuid, lease_until timestamptz, started_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 error_code text, scrubbed_at timestamptz, UNIQUE(conversation_id,request_id), UNIQUE(conversation_id,number),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES agentonic.staging_conversations(workspace_id,id)
);
CREATE UNIQUE INDEX staging_turn_serial ON agentonic.staging_turns(conversation_id) WHERE status IN ('queued','running');
ALTER TABLE agentonic.retrieval_provider_operations ADD COLUMN deployment_id uuid, ADD COLUMN conversation_id uuid;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['runtime_hosts','deployments','agent_environments','staging_conversations','staging_turns'] LOOP
 EXECUTE format('ALTER TABLE agentonic.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON agentonic.%I FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure',t);
 END LOOP;
END $$;
-- Approval identity needs the complete same-tenant FK target above.
CREATE FUNCTION agentonic.deployment_authorized(d agentonic.deployments) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r agentonic.configuration_releases;decision agentonic.submission_review_decisions;
BEGIN
 IF d.id IS NULL OR d.revoked_at IS NOT NULL OR d.authorized_until<=clock_timestamp() OR NOT agentonic.member_can_author(d.authorized_by_member_id,d.agent_id) THEN RETURN false; END IF;
 SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id AND workspace_id=d.workspace_id;
 SELECT * INTO decision FROM agentonic.submission_review_decisions WHERE id=d.approval_id;
 RETURN coalesce(r.retired_at IS NULL AND r.id IS NOT NULL AND r.requested_access_snapshot->'tools'='[]'
 AND decision.decision='approved' AND decision.approved_access_sha256=r.requested_access_sha256
 AND NOT EXISTS(SELECT 1 FROM agentonic.submission_review_decisions later WHERE later.submission_id=d.submission_id AND later.decision_number>decision.decision_number)
 AND EXISTS(SELECT 1 FROM agentonic.agent_submissions s WHERE s.id=d.submission_id AND s.status='approved')
 AND EXISTS(SELECT 1 FROM agentonic.evaluation_runs e WHERE e.id=(decision.assessment_snapshot->>'evaluationId')::uuid AND e.consent_revoked_at IS NULL)
 AND (decision.actor_staff_id IS NULL OR EXISTS(SELECT 1 FROM agentonic.platform_staff st JOIN agentonic.users u ON u.id=st.user_id WHERE st.id=decision.actor_staff_id AND st.disabled_at IS NULL AND st.role IN ('administrator','operator') AND u.deleted_at IS NULL))
 AND EXISTS(SELECT 1 FROM agentonic.code_releases code JOIN agentonic.workspace_code_release_grants g ON g.code_release_id=code.id AND g.workspace_id=d.workspace_id
  JOIN agentonic.code_repositories repo ON repo.id=code.code_repository_id JOIN agentonic.runtime_hosts h ON h.id=d.host_id
  WHERE code.id=d.code_release_id AND code.revoked_at IS NULL AND code.retired_at IS NULL AND g.revoked_at IS NULL
  AND repo.provisioning_status='ready' AND (repo.visibility='platform' OR repo.workspace_id=d.workspace_id)
  AND code.execution_manifest->>'previewContract'='1' AND h.environment=d.environment AND h.revoked_at IS NULL AND h.verified_at>clock_timestamp()-interval '7 days' AND h.runtime_sha256=code.artifact_sha256)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.requested_access_snapshot->'collectionIds') c WHERE NOT agentonic.member_can_collection(d.authorized_by_member_id,c::uuid,'read'))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.requested_access_snapshot->'collections') col CROSS JOIN LATERAL jsonb_array_elements(col->'sources') src
  WHERE NOT EXISTS(SELECT 1 FROM agentonic.knowledge_sources k WHERE k.id=(src->>'id')::uuid AND k.workspace_id=d.workspace_id AND k.collection_id=(col->>'id')::uuid
   AND k.definition_sha256=src->>'hash' AND k.definition_revision=(src->>'revision')::bigint AND k.environment='staging' AND k.kind='upload' AND k.access_mode='collection'
   AND k.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb AND agentonic.member_can_collection(k.authorized_by_member_id,k.collection_id,'curate')))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.evidence_sources) hit WHERE NOT EXISTS(
  SELECT 1 FROM agentonic.document_chunks c JOIN agentonic.document_versions v ON v.id=c.document_version_id JOIN agentonic.documents doc ON doc.id=v.document_id
  WHERE c.workspace_id=d.workspace_id AND c.id=(hit->>'id')::uuid AND c.content_sha256=hit->>'hash' AND v.status='ready' AND doc.active_version_id=v.id AND doc.deleted_at IS NULL)),false);
END $$;
CREATE FUNCTION agentonic.deployment_manifest(d agentonic.deployments) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('version',1,'deploymentId',d.id,'workspaceId',d.workspace_id,'agentId',d.agent_id,'environment',d.environment,
 'approvalId',d.approval_id,'assets',jsonb_build_array(jsonb_build_object('path','prompts/system.md','sha256',encode(sha256(convert_to(r.content->>'systemPrompt','UTF8')),'hex')))||coalesce((SELECT jsonb_agg(jsonb_build_object('path','skills/'||(skill->>'name')||'.md','sha256',encode(sha256(convert_to(skill->>'instructions','UTF8')),'hex')) ORDER BY skill->>'name') FROM jsonb_array_elements(r.content->'skills') skill),'[]'::jsonb),
 'configurationId',r.id,'configurationHash',r.content_sha256,'accessHash',r.requested_access_sha256,'assetHash',r.asset_manifest_sha256,
 'runtime',jsonb_build_object('gitCommit',c.git_commit_sha,'artifactSha256',c.artifact_sha256,'manifest',c.execution_manifest))
 FROM agentonic.configuration_releases r JOIN agentonic.code_releases c ON c.id=r.code_release_id WHERE r.id=d.configuration_release_id
$$;
CREATE FUNCTION agentonic.deployment_command(operation text,payload jsonb,trace_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();staff uuid:=agentonic.current_staff();s agentonic.agent_submissions;
 d agentonic.deployments;decision agentonic.submission_review_decisions;h agentonic.runtime_hosts;sources jsonb;
BEGIN
 IF w IS NULL OR trace_id IS NULL OR agentonic.actor_user_id() IS NULL OR agentonic.application_role() NOT IN ('agentonic_customer','agentonic_admin') THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 IF operation='authorize' THEN
  SELECT * INTO s FROM agentonic.agent_submissions WHERE id=(payload->>'submissionId')::uuid AND workspace_id=w;
  IF agentonic.application_role()<>'agentonic_customer' OR m IS NULL OR NOT agentonic.can_agent(s.agent_id,'edit') OR NOT agentonic.can_agent(s.agent_id,'invoke')
   OR s.submitted_by_member_id IS DISTINCT FROM m OR payload->'consent' IS DISTINCT FROM 'true'::jsonb OR payload->>'requestId' IS NULL THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO d FROM agentonic.deployments WHERE workspace_id=w AND authorized_by_member_id=m AND request_id=(payload->>'requestId')::uuid;
  IF d.id IS NOT NULL THEN
   IF d.submission_id IS DISTINCT FROM s.id OR d.environment IS DISTINCT FROM payload->>'environment' OR d.budget_usd IS DISTINCT FROM (payload->>'budgetUsd')::numeric THEN RAISE insufficient_privilege; END IF;
   RETURN jsonb_build_object('ok',true,'id',d.id);
  END IF;
  SELECT * INTO decision FROM agentonic.submission_review_decisions WHERE submission_id=s.id ORDER BY decision_number DESC LIMIT 1;
  IF NOT coalesce(agentonic.version_approval_valid(decision.id),false) THEN RETURN '{"ok":false,"code":"approval_required"}'; END IF;
  SELECT * INTO h FROM agentonic.runtime_hosts WHERE environment=payload->>'environment' AND revoked_at IS NULL AND verified_at>clock_timestamp()-interval '7 days' AND heartbeat_at>clock_timestamp()-interval '90 seconds';
  IF h.id IS NULL THEN RETURN '{"ok":false,"code":"host_unavailable"}'; END IF;
  SELECT coalesce(jsonb_agg(hit),'[]') INTO sources FROM agentonic.evaluation_results er CROSS JOIN LATERAL jsonb_array_elements(er.evidence_sources) hit WHERE er.evaluation_run_id=(decision.assessment_snapshot->>'evaluationId')::uuid;
  INSERT INTO agentonic.deployments(workspace_id,agent_id,code_release_id,configuration_release_id,submission_id,approval_id,host_id,environment,authorized_by_member_id,request_id,budget_usd,authorized_until,evidence_sources)
  VALUES(w,s.agent_id,s.code_release_id,s.configuration_release_id,s.id,decision.id,h.id,h.environment,m,(payload->>'requestId')::uuid,(payload->>'budgetUsd')::numeric,clock_timestamp()+interval '7 days',sources) RETURNING * INTO d;
  IF NOT agentonic.deployment_authorized(d) THEN RAISE insufficient_privilege; END IF;
 ELSIF operation IN ('activate','stop') THEN
  SELECT * INTO d FROM agentonic.deployments WHERE id=(payload->>'deploymentId')::uuid AND workspace_id=w FOR UPDATE;
  IF d.id IS NULL THEN RAISE insufficient_privilege; END IF;
  IF operation='stop' AND agentonic.application_role()='agentonic_customer' THEN
   IF d.authorized_by_member_id IS DISTINCT FROM m OR NOT agentonic.can_agent(d.agent_id,'invoke') THEN RAISE insufficient_privilege; END IF;
  ELSIF agentonic.application_role()<>'agentonic_admin' OR NOT EXISTS(SELECT 1 FROM agentonic.platform_staff WHERE id=staff AND role IN ('administrator','operator')) THEN RAISE insufficient_privilege; END IF;
  IF operation='activate' THEN
   IF d.status IN ('queued','preparing','running') THEN RETURN jsonb_build_object('ok',true,'id',d.id); END IF;
   IF d.status<>'awaiting_activation' OR NOT agentonic.deployment_authorized(d) OR NOT agentonic.version_approval_valid(d.approval_id) THEN RETURN '{"ok":false,"code":"approval_required"}'; END IF;
   UPDATE agentonic.deployments SET status='queued',desired_state='running',requested_by_staff_id=staff WHERE id=d.id;
  ELSE
   UPDATE agentonic.deployments SET desired_state='stopped',status='stopped',revoked_at=coalesce(revoked_at,clock_timestamp()),service_token_sha256=NULL WHERE id=d.id;
   UPDATE agentonic.agent_environments SET current_deployment_id=NULL WHERE current_deployment_id=d.id;
  END IF;
 ELSE RAISE insufficient_privilege;
 END IF;
 INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,action,resource_type,resource_id,outcome,request_id)
 VALUES(w,agentonic.actor_user_id(),CASE WHEN agentonic.application_role()='agentonic_customer' THEN m END,'deployment.'||operation,'deployment',d.id::text,'succeeded',trace_id::text);
 RETURN jsonb_build_object('ok',true,'id',d.id);
END $$;
CREATE FUNCTION agentonic.deployment_host(operation text,target_id uuid,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE h agentonic.runtime_hosts;d agentonic.deployments;manifest jsonb;result jsonb;
BEGIN
 SELECT * INTO h FROM agentonic.runtime_hosts WHERE database_role=agentonic.application_role() AND broker_sha256=payload->>'brokerHash' AND revoked_at IS NULL AND verified_at>clock_timestamp()-interval '7 days';
 IF h.id IS NULL THEN RAISE insufficient_privilege; END IF;
 IF operation='poll' THEN
  UPDATE agentonic.runtime_hosts SET heartbeat_at=clock_timestamp() WHERE id=h.id;
  FOR d IN SELECT * FROM agentonic.deployments WHERE host_id=h.id AND status IN ('awaiting_activation','queued','preparing','running') LOOP
   PERFORM 1 FROM agentonic.workspaces WHERE id=d.workspace_id FOR SHARE;
   SELECT * INTO d FROM agentonic.deployments WHERE id=d.id FOR UPDATE;
   IF NOT agentonic.deployment_authorized(d) OR (d.status IN ('queued','preparing') AND NOT agentonic.version_approval_valid(d.approval_id)) THEN
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
  IF d.status<>'queued' OR d.desired_state<>'running' OR NOT agentonic.deployment_authorized(d) OR NOT agentonic.version_approval_valid(d.approval_id)
   OR payload->>'tokenHash' IS NULL OR payload->>'tokenHash' !~ '^[a-f0-9]{64}$' THEN RAISE insufficient_privilege; END IF;
  manifest:=agentonic.deployment_manifest(d);
  UPDATE agentonic.deployments SET status='preparing',generation=generation+1,service_token_sha256=payload->>'tokenHash',manifest_sha256=agentonic.content_hash(manifest),heartbeat_at=clock_timestamp() WHERE id=d.id;
  RETURN jsonb_build_object('ok',true,'manifest',manifest,'manifestJson',manifest::text,'manifestHash',agentonic.content_hash(manifest),
   'configurationJson',(SELECT content::text FROM agentonic.configuration_releases WHERE id=d.configuration_release_id),'configuration',(SELECT content FROM agentonic.configuration_releases WHERE id=d.configuration_release_id));
 END IF;
 RAISE insufficient_privilege;
END $$;
CREATE FUNCTION agentonic.deployment_service(operation text,target_id uuid,secret text,payload jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
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
  IF d.activated_at IS NULL AND NOT agentonic.version_approval_valid(d.approval_id) THEN RETURN '{"ok":false,"code":"approval_required"}'; END IF;
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
CREATE FUNCTION agentonic.staging_conversation_authorized(c agentonic.staging_conversations) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE d agentonic.deployments;
BEGIN
 SELECT * INTO d FROM agentonic.deployments WHERE id=c.deployment_id;
 RETURN coalesce(c.id IS NOT NULL AND c.closed_at IS NULL AND c.expires_at>clock_timestamp() AND c.owner_member_id=d.authorized_by_member_id
 AND d.status='running' AND d.desired_state='running' AND agentonic.deployment_authorized(d)
 AND EXISTS(SELECT 1 FROM agentonic.agent_environments WHERE current_deployment_id=d.id)
 AND NOT EXISTS(SELECT 1 FROM agentonic.staging_turns t CROSS JOIN LATERAL jsonb_array_elements(t.matches) hit WHERE t.conversation_id=c.id AND NOT EXISTS(
 SELECT 1 FROM agentonic.document_chunks ch JOIN agentonic.document_versions v ON v.id=ch.document_version_id JOIN agentonic.documents doc ON doc.id=v.document_id
 WHERE ch.workspace_id=c.workspace_id AND ch.id=(hit->>'id')::uuid AND ch.content_sha256=hit->>'hash' AND v.status='ready' AND doc.active_version_id=v.id AND doc.deleted_at IS NULL)),false);
END $$;
CREATE FUNCTION agentonic.staging_chat(operation text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();c agentonic.staging_conversations;d agentonic.deployments;t agentonic.staging_turns;n integer;items jsonb;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR w IS NULL OR m IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 IF operation='list' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',c1.id,'agentId',c1.agent_id,'agentName',a.name,'deploymentId',c1.deployment_id,'title',c1.title,'expiresAt',c1.expires_at) ORDER BY c1.created_at DESC),'[]') INTO items
   FROM agentonic.staging_conversations c1 JOIN agentonic.agents a ON a.id=c1.agent_id WHERE c1.workspace_id=w AND c1.owner_member_id=m AND agentonic.staging_conversation_authorized(c1) AND agentonic.can_agent(c1.agent_id,'invoke');
  RETURN jsonb_build_object('ok',true,'conversations',items,'agents',coalesce((SELECT jsonb_agg(jsonb_build_object('id',dep.id,'agentId',dep.agent_id,'name',a.name,'environment',dep.environment)) FROM agentonic.deployments dep JOIN agentonic.agents a ON a.id=dep.agent_id WHERE dep.workspace_id=w AND dep.authorized_by_member_id=m AND dep.status='running' AND dep.heartbeat_at>clock_timestamp()-interval '60 seconds' AND agentonic.deployment_authorized(dep) AND agentonic.can_agent(dep.agent_id,'invoke')),'[]'::jsonb));
 ELSIF operation='start' THEN
  SELECT * INTO d FROM agentonic.deployments WHERE id=(payload->>'deploymentId')::uuid AND workspace_id=w AND authorized_by_member_id=m;
  IF d.id IS NULL OR d.status<>'running' OR d.heartbeat_at IS NULL OR d.heartbeat_at<=clock_timestamp()-interval '60 seconds' OR NOT agentonic.deployment_authorized(d) OR NOT agentonic.can_agent(d.agent_id,'invoke') THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
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
  IF d.heartbeat_at IS NULL OR d.heartbeat_at<=clock_timestamp()-interval '60 seconds' THEN RETURN '{"ok":false,"code":"offline"}'; END IF;
  SELECT * INTO t FROM agentonic.staging_turns WHERE conversation_id=c.id AND request_id=(payload->>'requestId')::uuid;
  IF t.id IS NOT NULL THEN RETURN jsonb_build_object('ok',true,'id',t.id); END IF;
  IF EXISTS(SELECT 1 FROM agentonic.staging_turns WHERE conversation_id=c.id AND status IN ('queued','running')) THEN RETURN '{"ok":false,"code":"busy"}'; END IF;
  IF length(btrim(payload->>'query')) NOT BETWEEN 1 AND 1000 OR payload->>'query' IS NULL THEN RAISE insufficient_privilege; END IF;
  SELECT coalesce(max(number),0)+1 INTO n FROM agentonic.staging_turns WHERE conversation_id=c.id;
  IF n>100 THEN RETURN '{"ok":false,"code":"turn_limit"}'; END IF;
  IF (SELECT count(*) FROM agentonic.staging_turns t1 JOIN agentonic.staging_conversations c1 ON c1.id=t1.conversation_id WHERE c1.owner_member_id=m AND t1.created_at>clock_timestamp()-interval '1 minute')>=10 THEN RETURN '{"ok":false,"code":"rate_limit"}'; END IF;
  INSERT INTO agentonic.staging_turns(workspace_id,conversation_id,request_id,number,query) VALUES(w,c.id,(payload->>'requestId')::uuid,n,btrim(payload->>'query')) RETURNING * INTO t;
  RETURN jsonb_build_object('ok',true,'id',t.id);
 ELSIF operation='state' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'number',number,'query',query,'answer',answer,'citations',citations,'status',status,'errorCode',error_code) ORDER BY number),'[]') INTO items FROM agentonic.staging_turns WHERE conversation_id=c.id;
  RETURN jsonb_build_object('ok',true,'id',c.id,'title',c.title,'agentId',c.agent_id,'expiresAt',c.expires_at,'online',coalesce(d.heartbeat_at>clock_timestamp()-interval '60 seconds',false),'budgetUsd',d.budget_usd,'committedMicrousd',d.committed_microusd,'turns',items);
 END IF;
 RAISE insufficient_privilege;
END $$;
CREATE FUNCTION agentonic.staging_worker(operation text,deployment_id uuid,secret text,job_id uuid,token uuid,payload jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE d agentonic.deployments;c agentonic.staging_conversations;t agentonic.staging_turns;r agentonic.configuration_releases;code agentonic.code_releases;
 hits jsonb;assets jsonb;history jsonb;budget agentonic.retrieval_provider_budgets;meter agentonic.retrieval_provider_operations;amount bigint;
BEGIN
 SELECT * INTO d FROM agentonic.deployments WHERE id=deployment_id;
 IF d.id IS NULL OR secret IS NULL OR length(secret)<>64 OR d.service_token_sha256 IS DISTINCT FROM encode(sha256(convert_to(secret,'UTF8')),'hex')
  OR NOT EXISTS(SELECT 1 FROM agentonic.runtime_hosts WHERE id=d.host_id AND replace(database_role,'deployer','runtime')=agentonic.application_role()) THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=d.workspace_id FOR SHARE;
 SELECT * INTO d FROM agentonic.deployments WHERE id=deployment_id FOR UPDATE;
 IF d.status<>'running' OR d.desired_state<>'running' OR NOT agentonic.deployment_authorized(d) THEN RAISE insufficient_privilege; END IF;
 IF operation='claim' THEN
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
  IF NOT coalesce((payload->>'provider'='voyage' AND payload->>'model'='voyage-4') OR (payload->>'provider'='openai' AND payload->>'model'='gpt-4.1-mini-2025-04-14'),false) THEN RAISE insufficient_privilege; END IF;
  amount:=(payload->>'microusd')::bigint;
  IF amount IS NULL OR amount NOT BETWEEN 1 AND 1000000 THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO budget FROM agentonic.retrieval_provider_budgets WHERE provider=payload->>'provider' FOR UPDATE;
  IF budget.provider IS NULL THEN RAISE insufficient_privilege; END IF;
  IF d.committed_microusd+amount>d.budget_usd*1000000 OR budget.committed_microusd+amount>budget.cap_microusd THEN RETURN '{"ok":false,"code":"budget_exhausted"}'; END IF;
  INSERT INTO agentonic.retrieval_provider_operations(id,job_id,workspace_id,provider,model,reserved_microusd,agent_id,deployment_id,conversation_id)
   VALUES((payload->>'id')::uuid,t.id,d.workspace_id,budget.provider,payload->>'model',amount,d.agent_id,d.id,c.id);
  UPDATE agentonic.retrieval_provider_budgets SET committed_microusd=committed_microusd+amount,updated_at=clock_timestamp() WHERE provider=budget.provider;
  UPDATE agentonic.deployments SET committed_microusd=committed_microusd+amount WHERE id=d.id;
  RETURN '{"ok":true}';
 ELSIF operation='settle' THEN
  SELECT * INTO meter FROM agentonic.retrieval_provider_operations WHERE id=(payload->>'id')::uuid AND job_id=t.id AND deployment_id=d.id AND status='reserved' FOR UPDATE;
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
   SELECT coalesce(s.id,l.id) id,coalesce(1.0/(60+s.rank),0)+coalesce(1.0/(60+l.rank),0) score FROM semantic s FULL JOIN lexical l ON s.id=l.id ORDER BY score DESC,coalesce(s.id,l.id) LIMIT 8
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',ranked.id,'hash',ch.content_sha256) ORDER BY ranked.score DESC,ranked.id),'[]') INTO hits FROM ranked JOIN agentonic.document_chunks ch ON ch.id=ranked.id;
  UPDATE agentonic.staging_turns SET matches=hits WHERE id=t.id; RETURN '{"ok":true}';
 ELSIF operation IN ('context','answer') THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',ch.id,'text',ch.content) ORDER BY hit.ordinality),'[]') INTO hits
   FROM jsonb_array_elements(t.matches) WITH ORDINALITY hit(value,ordinality) JOIN agentonic.document_chunks ch ON ch.id=(hit.value->>'id')::uuid AND ch.workspace_id=d.workspace_id AND ch.content_sha256=hit.value->>'hash'
   JOIN agentonic.document_versions v ON v.id=ch.document_version_id JOIN agentonic.documents doc ON doc.id=v.document_id AND doc.active_version_id=v.id WHERE doc.deleted_at IS NULL AND v.status='ready';
  IF jsonb_array_length(hits)<>jsonb_array_length(t.matches) THEN RAISE insufficient_privilege; END IF;
  IF operation='context' THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('path','skills/'||(s->>'name')||'.md','sha256',encode(sha256(convert_to(s->>'instructions','UTF8')),'hex')) ORDER BY s->>'name'),'[]') INTO assets FROM jsonb_array_elements(r.content->'skills') s;
   assets:=jsonb_build_array(jsonb_build_object('path','prompts/system.md','sha256',encode(sha256(convert_to(r.content->>'systemPrompt','UTF8')),'hex')))||assets;
   SELECT coalesce(jsonb_agg(jsonb_build_object('query',p.query,'answer',p.answer) ORDER BY p.number),'[]') INTO history FROM (SELECT query,answer,number FROM agentonic.staging_turns WHERE conversation_id=c.id AND number<t.number AND status='succeeded' ORDER BY number DESC LIMIT 10) p;
   RETURN jsonb_build_object('query',t.query,'passages',hits,'environment','staging','audience','private','expiresAt',least(c.expires_at,t.started_at+interval '2 minutes'),
    'configurationJson',r.content::text,'contentSha256',r.content_sha256,'composedPromptSha256',r.composed_prompt_sha256,'assetManifestJson',assets::text,'assetManifestSha256',r.asset_manifest_sha256,'accessJson',r.requested_access_snapshot::text,'accessSha256',r.requested_access_sha256,'history',history);
  END IF;
  IF jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' OR length(payload->>'text') NOT BETWEEN 1 AND 12000 OR jsonb_typeof(payload->'citations') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'citations')>8 OR jsonb_typeof(payload->'insufficientEvidence') IS DISTINCT FROM 'boolean' OR payload->>'model' IS DISTINCT FROM 'gpt-4.1-mini-2025-04-14'
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(payload->'citations') citation WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(hits) h WHERE h->>'id'=citation))
   OR (jsonb_array_length(hits)>0 AND payload->'insufficientEvidence'='false' AND jsonb_array_length(payload->'citations')=0) THEN RAISE insufficient_privilege; END IF;
  IF d.committed_microusd>d.budget_usd*1000000 OR EXISTS(SELECT 1 FROM agentonic.retrieval_provider_operations WHERE job_id=t.id AND status='reserved') THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.staging_turns SET status='succeeded',answer=payload->>'text',citations=payload->'citations',insufficient_evidence=(payload->>'insufficientEvidence')::boolean,lease_token=NULL,lease_until=NULL WHERE id=t.id;
  RETURN '{"ok":true}';
 END IF;
 RAISE insufficient_privilege;
END $$;
CREATE FUNCTION agentonic.deployment_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Deployment history is retained'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','desired_state','service_token_sha256','generation','committed_microusd','requested_by_staff_id','activated_at','heartbeat_at','error_code','manifest_sha256','revoked_at'])
 IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','desired_state','service_token_sha256','generation','committed_microusd','requested_by_staff_id','activated_at','heartbeat_at','error_code','manifest_sha256','revoked_at']) THEN RAISE EXCEPTION 'Immutable deployment scope'; END IF;
 IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN RAISE EXCEPTION 'Irreversible deployment revocation'; END IF;
 IF OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN RAISE EXCEPTION 'Immutable activation evidence'; END IF;
 IF OLD.requested_by_staff_id IS NOT NULL AND NEW.requested_by_staff_id IS DISTINCT FROM OLD.requested_by_staff_id THEN RAISE EXCEPTION 'Immutable deployment actor'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER deployment_immutable BEFORE UPDATE OR DELETE ON agentonic.deployments FOR EACH ROW EXECUTE FUNCTION agentonic.deployment_immutable();
CREATE FUNCTION agentonic.lifecycle_state(target_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
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
  'authorized',agentonic.deployment_authorized(dep),'online',dep.status='running' AND agentonic.deployment_authorized(dep) AND coalesce(dep.heartbeat_at>clock_timestamp()-interval '60 seconds',false),
  'expiresAt',dep.authorized_until,'budgetUsd',dep.budget_usd,'committedMicrousd',dep.committed_microusd,'errorCode',dep.error_code,
  'canActivate',operator AND dep.status='awaiting_activation' AND agentonic.deployment_authorized(dep) AND agentonic.version_approval_valid(dep.approval_id),
  'canStop',(operator OR dep.authorized_by_member_id=m) AND dep.status IN ('awaiting_activation','queued','preparing','running'),
  'canChat',agentonic.application_role()='agentonic_customer' AND dep.authorized_by_member_id=m AND dep.status='running' AND agentonic.deployment_authorized(dep) AND agentonic.can_agent(aid,'invoke')
 ) ORDER BY dep.created_at DESC),'[]') INTO deploys FROM agentonic.deployments dep WHERE dep.workspace_id=w AND dep.agent_id=aid;
 RETURN jsonb_build_object('agentId',aid,'submissions',items,'deployments',deploys,'hosts',coalesce((SELECT jsonb_agg(jsonb_build_object('environment',environment,'available',revoked_at IS NULL AND verified_at>clock_timestamp()-interval '7 days' AND coalesce(heartbeat_at>clock_timestamp()-interval '90 seconds',false))) FROM agentonic.runtime_hosts),'[]'::jsonb));
END $$;
-- Queue/receipt expose operational state; they never grant deployment or transcript access.
ALTER FUNCTION agentonic.review_queue() RENAME TO review_queue_before_deployments;
CREATE FUNCTION agentonic.review_queue() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE row jsonb;state jsonb;result jsonb:='[]';approval jsonb;
BEGIN
 FOR row IN SELECT value FROM jsonb_array_elements(agentonic.review_queue_before_deployments()) LOOP
  state:=agentonic.lifecycle_state((row->>'id')::uuid);
  SELECT value INTO approval FROM jsonb_array_elements(state->'submissions') WHERE value->>'id'=row->>'id';
  result:=result||jsonb_build_array(row||jsonb_build_object('approvalReason',approval->>'reason','approvalExpiresAt',approval->'expiresAt',
   'deploymentStatus',coalesce((SELECT CASE WHEN value->>'status'='running' THEN CASE WHEN value->>'online'='true' THEN 'running' ELSE 'offline' END ELSE value->>'status' END FROM jsonb_array_elements(state->'deployments') WHERE value->>'submissionId'=row->>'id' LIMIT 1),'none')));
 END LOOP;
 RETURN result;
END $$;
ALTER FUNCTION agentonic.approved_review_receipt(uuid,uuid) RENAME TO approved_review_receipt_before_deployments;
CREATE FUNCTION agentonic.approved_review_receipt(target_id uuid,trace_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 result:=agentonic.approved_review_receipt_before_deployments(target_id,trace_id);
 IF result IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_set(result,'{approval,reason}',to_jsonb(agentonic.approval_reason((result->'approval'->>'id')::uuid)));
END $$;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='agentonic'::regnamespace AND proname IN (
 'deployment_authorized','deployment_manifest','deployment_command','deployment_host','deployment_service','staging_conversation_authorized','staging_chat','staging_worker','deployment_immutable','lifecycle_state','review_queue','approved_review_receipt') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure',f.signature);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION agentonic.deployment_command(text,jsonb,uuid),agentonic.lifecycle_state(uuid) TO agentonic_admin,agentonic_customer;
GRANT EXECUTE ON FUNCTION agentonic.staging_chat(text,jsonb) TO agentonic_customer;
GRANT EXECUTE ON FUNCTION agentonic.review_queue(),agentonic.approved_review_receipt(uuid,uuid) TO agentonic_admin;
GRANT USAGE ON SCHEMA agentonic TO agentonic_runtime_local,agentonic_runtime_azure,agentonic_deployer_local,agentonic_deployer_azure;
GRANT EXECUTE ON FUNCTION agentonic.deployment_host(text,uuid,jsonb) TO agentonic_deployer_local,agentonic_deployer_azure;
GRANT EXECUTE ON FUNCTION agentonic.deployment_service(text,uuid,text,jsonb),agentonic.staging_worker(text,uuid,text,uuid,uuid,jsonb) TO agentonic_runtime_local,agentonic_runtime_azure;
COMMIT;
