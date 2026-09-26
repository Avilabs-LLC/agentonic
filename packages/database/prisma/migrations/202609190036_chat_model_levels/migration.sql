BEGIN;
ALTER TABLE agentonic.background_jobs ADD COLUMN reasoning_effort text;
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='agentonic.background_jobs'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%response_model%' LOOP
 EXECUTE format('ALTER TABLE agentonic.background_jobs DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
-- Existing Astra turns predate configurable effort and used low reasoning.
UPDATE agentonic.background_jobs SET reasoning_effort='low' WHERE response_model='gpt-6-astra';
ALTER TABLE agentonic.background_jobs ADD CHECK(agentonic.valid_model_configuration(response_model,reasoning_effort) AND (preview_id IS NOT NULL OR response_model='gpt-4.1-mini-2025-04-14'));
ALTER TABLE agentonic.staging_turns ADD COLUMN response_model text NOT NULL DEFAULT 'gpt-4.1-mini-2025-04-14', ADD COLUMN reasoning_effort text,
 ADD CHECK(agentonic.valid_model_configuration(response_model,reasoning_effort));
CREATE FUNCTION agentonic.deployment_models(d agentonic.deployments) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce((SELECT b.models FROM agentonic.submission_review_decisions approval
 JOIN agentonic.evaluation_runs e ON e.id=(approval.assessment_snapshot->>'evaluationId')::uuid AND e.submission_id=d.submission_id
 JOIN agentonic.evaluation_batches b ON b.id=e.batch_id
 WHERE approval.id=d.approval_id AND approval.decision='approved'), '[{"model":"gpt-4.1-mini-2025-04-14","reasoning":null}]'::jsonb)
$$;
CREATE OR REPLACE FUNCTION agentonic.preview_command_v30(operation text,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE w uuid:=agentonic.workspace_id(); m uuid:=agentonic.current_member(); p agentonic.agent_previews; r agentonic.configuration_releases;
 j agentonic.background_jobs; turns jsonb:='[]'; response jsonb; n integer;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR m IS NULL OR w IS NULL THEN RAISE insufficient_privilege; END IF;
 -- Exclusive workspace lock serializes starts/turns with revocation and deletion.
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 IF operation='start' THEN
  payload:=jsonb_build_object('enableTools',false,'budgetUsd',0.25)||payload;
  IF (payload->>'budgetUsd')::numeric NOT IN (0.25,3) THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO r FROM agentonic.configuration_releases WHERE id=(payload->>'candidateId')::uuid AND agent_id=(payload->>'agentId')::uuid AND workspace_id=w;
  IF r.id IS NULL OR NOT agentonic.can_agent(r.agent_id,'edit') OR NOT agentonic.can_use_code(r.code_release_id) THEN RAISE insufficient_privilege; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.requested_access_snapshot->'collectionIds') c WHERE NOT agentonic.can_collection(c::uuid,'read')) THEN RAISE insufficient_privilege; END IF;
  IF NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=r.code_release_id AND execution_manifest->>'previewContract'='1') THEN RETURN '{"ok":false,"code":"runtime_unavailable"}'; END IF;
  SELECT * INTO p FROM agentonic.agent_previews WHERE workspace_id=w AND agent_id=r.agent_id AND configuration_release_id=r.id AND requested_by_member_id=m AND budget_usd=(payload->>'budgetUsd')::numeric AND status='running' AND expires_at>clock_timestamp() AND (jsonb_array_length(execution_policy->'tools')>0)=((payload->>'enableTools'='true') AND jsonb_array_length(r.requested_access_snapshot->'tools')>0) ORDER BY created_at DESC LIMIT 1;
  IF p.id IS NOT NULL AND agentonic.preview_authorized(p) THEN RETURN jsonb_build_object('ok',true,'id',p.id); END IF;
  IF (SELECT count(*) FROM agentonic.agent_previews WHERE workspace_id=w AND requested_by_member_id=m AND created_at>clock_timestamp()-interval '1 minute')>=3 THEN RETURN '{"ok":false,"code":"rate_limit"}'; END IF;
  INSERT INTO agentonic.agent_previews(workspace_id,agent_id,code_release_id,configuration_release_id,requested_by_member_id,budget_usd,execution_policy)
  VALUES(w,r.agent_id,r.code_release_id,r.id,m,(payload->>'budgetUsd')::numeric,jsonb_build_object('audience','private','tools',CASE WHEN payload->>'enableTools'='true' THEN r.requested_access_snapshot->'tools' ELSE '[]'::jsonb END,'collections',r.requested_access_snapshot->'collections')) RETURNING * INTO p;
  IF NOT agentonic.preview_authorized(p) THEN RAISE insufficient_privilege; END IF;
  RETURN jsonb_build_object('ok',true,'id',p.id);
 END IF;
 SELECT * INTO p FROM agentonic.agent_previews WHERE id=(payload->>'previewId')::uuid AND workspace_id=w AND requested_by_member_id=m AND agent_id=(payload->>'agentId')::uuid FOR UPDATE;
 IF p.id IS NULL THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
 IF operation='cancel' THEN
  UPDATE agentonic.agent_previews SET status='cancelled' WHERE id=p.id;
  UPDATE agentonic.background_jobs SET status='cancelled',payload='{}',result='{}',lease_token=NULL,lease_until=NULL WHERE preview_id=p.id;
  RETURN '{"ok":true}';
 END IF;
 IF NOT agentonic.preview_authorized(p) THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
 IF operation='turn' THEN
  payload:=jsonb_build_object('model','gpt-5.4-mini')||payload;
  IF NOT payload ? 'reasoning' THEN payload:=payload||jsonb_build_object('reasoning',CASE WHEN payload->>'model'='gpt-4.1-mini-2025-04-14' THEN NULL WHEN payload->>'model'='gpt-6-astra' THEN 'low' ELSE 'medium' END); END IF;
  IF NOT agentonic.valid_model_configuration(payload->>'model',payload->>'reasoning') THEN RAISE insufficient_privilege; END IF;
  IF length(btrim(payload->>'query')) NOT BETWEEN 1 AND 1000 OR payload->>'query' IS NULL OR payload->>'requestKey' IS NULL THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO j FROM agentonic.background_jobs WHERE preview_id=p.id AND request_key=(payload->>'requestKey')::uuid;
  IF j.id IS NOT NULL THEN
   IF j.reasoning_effort IS DISTINCT FROM payload->>'reasoning' OR j.response_model IS DISTINCT FROM payload->>'model' OR j.payload->>'query' IS DISTINCT FROM btrim(payload->>'query') THEN RETURN '{"ok":false,"code":"request_conflict"}'; END IF;
   RETURN jsonb_build_object('ok',true,'id',j.id);
  END IF;
  IF EXISTS(SELECT 1 FROM agentonic.background_jobs WHERE preview_id=p.id AND status IN ('queued','running')) THEN RETURN '{"ok":false,"code":"busy"}'; END IF;
  SELECT coalesce(max(turn_number),0)+1 INTO n FROM agentonic.background_jobs WHERE preview_id=p.id;
  IF n>10 THEN RETURN '{"ok":false,"code":"turn_limit"}'; END IF;
  INSERT INTO agentonic.background_jobs(workspace_id,member_id,kind,preview_id,turn_number,request_key,response_model,reasoning_effort,payload)
  SELECT w,m,'retrieve',p.id,n,(payload->>'requestKey')::uuid,payload->>'model',payload->>'reasoning',jsonb_build_object('query',btrim(payload->>'query'),'collectionIds',frozen.requested_access_snapshot->'collectionIds','generateAnswer',true)
  FROM agentonic.configuration_releases frozen WHERE frozen.id=p.configuration_release_id RETURNING * INTO j;
  RETURN jsonb_build_object('ok',true,'id',j.id);
 ELSIF operation='state' THEN
  FOR j IN SELECT * FROM agentonic.background_jobs WHERE preview_id=p.id ORDER BY turn_number LOOP
   response:=agentonic.rag_command('result',jsonb_build_object('id',j.id));
   IF response->>'status'='unavailable' THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
   turns:=turns||jsonb_build_array(response||jsonb_build_object('id',j.id,'number',j.turn_number,'model',j.response_model,'reasoning',j.reasoning_effort,'query',j.payload->>'query'));
  END LOOP;
  RETURN jsonb_build_object('ok',true,'id',p.id,'expiresAt',p.expires_at,'budgetUsd',p.budget_usd,'committedMicrousd',p.committed_microusd,'toolsEnabled',jsonb_array_length(p.execution_policy->'tools')>0,'turns',turns);
 END IF;
 RAISE insufficient_privilege;
END $$;
CREATE OR REPLACE FUNCTION agentonic.rag_worker(operation text,job_id uuid,token uuid,payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE j agentonic.background_jobs; p agentonic.agent_previews; r agentonic.configuration_releases; c agentonic.code_releases;
 response jsonb; assets jsonb; history jsonb; before_amount bigint; meter agentonic.retrieval_provider_operations;
BEGIN
 IF agentonic.application_role()<>'agentonic_worker' THEN RAISE insufficient_privilege; END IF;
 SELECT * INTO j FROM agentonic.background_jobs WHERE id=job_id;
 IF j.id IS NULL THEN RAISE insufficient_privilege; END IF;
 IF j.preview_id IS NULL THEN RETURN agentonic.rag_worker_core_v8(operation,job_id,token,payload); END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=j.workspace_id FOR SHARE;
 SELECT * INTO p FROM agentonic.agent_previews WHERE id=j.preview_id FOR UPDATE;
 SELECT * INTO j FROM agentonic.background_jobs WHERE id=job_id FOR UPDATE;
 IF j.status<>'running' OR j.lease_token IS DISTINCT FROM token OR j.lease_until<=clock_timestamp() OR NOT agentonic.rag_job_authorized(j) THEN RAISE insufficient_privilege; END IF;
 SELECT * INTO r FROM agentonic.configuration_releases WHERE id=p.configuration_release_id;
 SELECT * INTO c FROM agentonic.code_releases WHERE id=p.code_release_id;
 IF operation='read' THEN
  RETURN jsonb_build_object('kind','retrieve','workspaceId',j.workspace_id,'query',j.payload->>'query','retrievalQuery',concat_ws(E'\n',(SELECT string_agg(previous.payload->>'query',E'\n' ORDER BY previous.turn_number) FROM (SELECT prior.payload,prior.turn_number FROM agentonic.background_jobs prior WHERE prior.preview_id=p.id AND prior.turn_number<j.turn_number AND prior.status='succeeded' ORDER BY prior.turn_number DESC LIMIT 2) previous),j.payload->>'query'),'generateAnswer',true,'preview',true,'hasCollections',jsonb_array_length(j.payload->'collectionIds')>0,
   'runtime',jsonb_build_object('gitCommit',c.git_commit_sha,'artifactSha256',c.artifact_sha256,'manifest',c.execution_manifest));
 ELSIF operation='empty-search' THEN
  IF jsonb_array_length(j.payload->'collectionIds')<>0 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.background_jobs SET result='{"matches":[]}' WHERE id=j.id;
  RETURN '{"ok":true}';
 ELSIF operation='context' THEN
  response:=agentonic.rag_worker_core_v8('context',job_id,token,'{}');
  SELECT coalesce(jsonb_agg(jsonb_build_object('path','skills/'||(s->>'name')||'.md','sha256',encode(sha256(convert_to(s->>'instructions','UTF8')),'hex')) ORDER BY s->>'name'),'[]') INTO assets FROM jsonb_array_elements(r.content->'skills') s;
  assets:=jsonb_build_array(jsonb_build_object('path','prompts/system.md','sha256',encode(sha256(convert_to(r.content->>'systemPrompt','UTF8')),'hex')))||assets;
  SELECT coalesce(jsonb_agg(jsonb_build_object('query',previous.payload->>'query','answer',previous.result->'answer'->>'text') ORDER BY previous.turn_number),'[]') INTO history FROM agentonic.background_jobs previous WHERE previous.preview_id=p.id AND previous.turn_number<j.turn_number AND previous.status='succeeded';
  RETURN response||jsonb_build_object('previewModel',j.response_model,'reasoningLevel',j.reasoning_effort,'environment','staging','audience','private','expiresAt',p.expires_at,'configurationJson',r.content::text,'contentSha256',r.content_sha256,'composedPromptSha256',r.composed_prompt_sha256,'assetManifestJson',assets::text,'assetManifestSha256',r.asset_manifest_sha256,'accessJson',r.requested_access_snapshot::text,'accessSha256',r.requested_access_sha256,'history',history);
 ELSIF operation='reserve' THEN
  IF p.committed_microusd+(payload->>'microusd')::bigint>p.budget_usd*1000000 THEN RETURN '{"ok":false,"code":"budget_exhausted"}'; END IF;
  response:=agentonic.rag_worker_core_v8(operation,job_id,token,payload);
  IF response->>'ok'='true' THEN
   UPDATE agentonic.agent_previews SET committed_microusd=committed_microusd+(payload->>'microusd')::bigint WHERE id=p.id;
   UPDATE agentonic.retrieval_provider_operations SET preview_id=p.id,agent_id=p.agent_id WHERE id=(payload->>'id')::uuid;
  END IF;
  RETURN response;
 ELSIF operation='settle' THEN
  SELECT * INTO meter FROM agentonic.retrieval_provider_operations WHERE id=(payload->>'id')::uuid AND job_id=j.id;
  response:=agentonic.rag_worker_core_v8(operation,job_id,token,payload);
  UPDATE agentonic.agent_previews SET committed_microusd=committed_microusd-meter.reserved_microusd+(payload->>'microusd')::bigint WHERE id=p.id;
  RETURN response;
 END IF;
 RETURN agentonic.rag_worker_core_v8(operation,job_id,token,payload);
END $$;
CREATE OR REPLACE FUNCTION agentonic.staging_chat(operation text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
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
  payload:=jsonb_build_object('model',agentonic.deployment_models(d)->0->>'model','reasoning',agentonic.deployment_models(d)->0->'reasoning')||payload;
  IF NOT agentonic.deployment_models(d) @> jsonb_build_array(jsonb_build_object('model',payload->>'model','reasoning',payload->'reasoning')) THEN RAISE insufficient_privilege; END IF;
  IF d.heartbeat_at IS NULL OR d.heartbeat_at<=clock_timestamp()-interval '60 seconds' THEN RETURN '{"ok":false,"code":"offline"}'; END IF;
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
  RETURN jsonb_build_object('ok',true,'id',c.id,'title',c.title,'agentId',c.agent_id,'expiresAt',c.expires_at,'online',coalesce(d.heartbeat_at>clock_timestamp()-interval '60 seconds',false),'budgetUsd',d.budget_usd,'committedMicrousd',d.committed_microusd,'turns',items,'models',agentonic.deployment_models(d));
 END IF;
 RAISE insufficient_privilege;
END $$;
CREATE OR REPLACE FUNCTION agentonic.staging_worker(operation text,deployment_id uuid,secret text,job_id uuid,token uuid,payload jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
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
REVOKE ALL ON FUNCTION agentonic.deployment_models(agentonic.deployments) FROM PUBLIC,anon,authenticated,service_role,agentonic_customer,agentonic_admin,agentonic_worker,agentonic_eval_local,agentonic_eval_azure;
COMMIT;
