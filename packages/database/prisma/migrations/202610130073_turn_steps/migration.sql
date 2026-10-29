BEGIN;
-- Turn steps (architecture §74, owner decisions 13 October 2026): a chat or
-- preview turn shows what it does while it runs, step by step, and keeps the
-- steps folded above its answer.
--
-- * The broker sends the turn's whole step list after each change to a tool
--   call: the tool, what it looked for or touched (a search's terms, a
--   message's subject, a page's site, a file's name), how many items it found
--   and how it ended. The new `steps` operation of staging_worker and
--   rag_worker stores the list on the running turn the caller leases.
-- * valid_turn_steps bounds the list (40 steps of exactly four fields, known
--   tools and statuses, targets of 200 characters, counts 0-1000) in the
--   operations and in a CHECK on both columns.
-- * Chat and preview states return each turn's steps.
-- * Steps hold the person's own search terms and subjects, like the turn's
--   query and answer, so they go with them: every path that scrubs a chat
--   turn sets scrubbed_at, and a trigger clears its steps then. Preview turns
--   keep theirs as long as their query and answer.
--
-- Each function is its live definition (migration 71's, checked against
-- pg_get_functiondef) with only these changes. CREATE OR REPLACE keeps the
-- grants.

CREATE FUNCTION agentonic.valid_turn_steps(s jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT s IS NOT NULL AND jsonb_typeof(s)='array' AND jsonb_array_length(s)<=40 AND length(s::text)<=20000 AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(s) e WHERE jsonb_typeof(e)<>'object'
   OR NOT e ?& ARRAY['tool','target','count','status'] OR (e-'tool'-'target'-'count'-'status')<>'{}'::jsonb
   OR coalesce(e->>'tool' NOT IN ('gmail.search','gmail.read','gmail.drafts.list','gmail.drafts.read','gmail.drafts.create','gmail.drafts.update','gmail.drafts.delete','gmail.send','gmail.labels.apply','gmail.threads.read','drive.files.list','drive.files.read','drive.docs.create','drive.docs.update','web.search','web.read'),true)
   OR coalesce(e->>'status' NOT IN ('running','done','proposed','failed'),true)
   OR jsonb_typeof(e->'target') NOT IN ('string','null') OR coalesce(length(e->>'target')>200,false)
   OR jsonb_typeof(e->'count') NOT IN ('number','null')
   OR (jsonb_typeof(e->'count')='number' AND ((e->>'count')::numeric NOT BETWEEN 0 AND 1000 OR (e->>'count')::numeric<>trunc((e->>'count')::numeric))))
$$;

ALTER TABLE agentonic.staging_turns ADD COLUMN steps jsonb CHECK(steps IS NULL OR agentonic.valid_turn_steps(steps));
ALTER TABLE agentonic.background_jobs ADD COLUMN steps jsonb CHECK(steps IS NULL OR agentonic.valid_turn_steps(steps));

-- A scrubbed chat turn loses its steps with its query and answer.
CREATE FUNCTION agentonic.scrub_turn_steps() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.scrubbed_at IS NOT NULL THEN NEW.steps:=NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER staging_turn_steps_scrub BEFORE UPDATE ON agentonic.staging_turns FOR EACH ROW EXECUTE FUNCTION agentonic.scrub_turn_steps();

CREATE OR REPLACE FUNCTION agentonic.staging_worker(operation text, deployment_id uuid, secret text, job_id uuid, token uuid, payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
   FROM agentonic.staging_conversations conv WHERE conv.id=turn.conversation_id AND conv.deployment_id=d.id AND turn.status='running' AND (turn.lease_until<=clock_timestamp() OR turn.started_at<clock_timestamp()-agentonic.staging_turn_window(d.code_release_id));
  SELECT turn.* INTO t FROM agentonic.staging_turns turn JOIN agentonic.staging_conversations conv ON conv.id=turn.conversation_id
   WHERE conv.deployment_id=d.id AND turn.status='queued' AND agentonic.staging_conversation_authorized(conv) ORDER BY turn.created_at LIMIT 1 FOR UPDATE OF turn SKIP LOCKED;
  IF t.id IS NULL THEN RETURN NULL; END IF;
  UPDATE agentonic.staging_turns SET status='running',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '90 seconds',started_at=clock_timestamp() WHERE id=t.id RETURNING * INTO t;
  RETURN jsonb_build_object('id',t.id,'token',t.lease_token,'kind','retrieve','queuedAt',t.created_at);
 END IF;
 SELECT turn.* INTO t FROM agentonic.staging_turns turn JOIN agentonic.staging_conversations conv ON conv.id=turn.conversation_id WHERE turn.id=job_id AND conv.deployment_id=d.id FOR UPDATE OF turn;
 IF t.id IS NULL OR t.status<>'running' OR t.lease_token IS DISTINCT FROM token OR t.lease_until<=clock_timestamp() OR t.started_at<clock_timestamp()-agentonic.staging_turn_window(d.code_release_id) THEN RAISE insufficient_privilege; END IF;
 IF operation='fail' THEN
  UPDATE agentonic.staging_turns SET status='failed',error_code=CASE WHEN payload->>'code' IN ('provider_unavailable','budget_exhausted','configuration_required','runtime_mismatch') THEN payload->>'code' ELSE 'lease_lost' END,lease_token=NULL,lease_until=NULL WHERE id=t.id;
  RETURN '{"ok":true}';
 END IF;
 SELECT * INTO c FROM agentonic.staging_conversations WHERE id=t.conversation_id;
 IF NOT agentonic.staging_conversation_authorized(c) THEN RAISE insufficient_privilege; END IF;
 SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id;
 SELECT * INTO code FROM agentonic.code_releases WHERE id=d.code_release_id;
 -- The answer as it is written, shown while the turn runs (§68): batch runtimes only.
 IF operation='partial' THEN
  IF code.execution_manifest->>'mailboxBatch' IS DISTINCT FROM '1' OR jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' OR length(payload->>'text')>30000 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.staging_turns SET partial_answer=payload->>'text' WHERE id=t.id;
  RETURN '{"ok":true}';
 END IF;
 -- The turn's tool calls as its broker runs them, the whole list each time (§74).
 IF operation='steps' THEN
  IF NOT agentonic.valid_turn_steps(payload->'steps') THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.staging_turns SET steps=payload->'steps' WHERE id=t.id;
  RETURN '{"ok":true}';
 END IF;
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
   -- Batch runtimes (§67) see each earlier turn's Gmail actions, IDs and outcomes only (B8);
   -- earlier runtimes keep answers within their 12,000 characters.
   SELECT coalesce(jsonb_agg(jsonb_build_object('query',p.query,'answer',p.answer)||CASE WHEN p.actions IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('actions',p.actions) END ORDER BY p.number),'[]') INTO history
    FROM (SELECT q.query,CASE WHEN code.execution_manifest->>'mailboxBatch'='1' THEN q.answer ELSE left(q.answer,12000) END answer,q.number,
     CASE WHEN code.execution_manifest->>'mailboxBatch'='1' THEN agentonic.turn_gmail_actions(q.id) END actions
     FROM agentonic.staging_turns q WHERE q.conversation_id=c.id AND q.number<t.number AND q.status='succeeded' ORDER BY q.number DESC LIMIT 9) p;
   RETURN jsonb_build_object('previewModel',t.response_model,'reasoningLevel',t.reasoning_effort,'query',t.query,'passages',hits,'environment','staging','audience','private','expiresAt',least(c.expires_at,t.started_at+agentonic.staging_turn_window(d.code_release_id)),
    'configurationJson',r.content::text,'contentSha256',r.content_sha256,'composedPromptSha256',r.composed_prompt_sha256,'assetManifestJson',assets::text,'assetManifestSha256',r.asset_manifest_sha256,'accessJson',r.requested_access_snapshot::text,'accessSha256',r.requested_access_sha256,'history',history)
    -- The owner's writing style for batch runtimes (§68).
    ||CASE WHEN code.execution_manifest->>'mailboxBatch'='1' THEN jsonb_strip_nulls(jsonb_build_object('styleGuide',agentonic.agent_style_guide(d.agent_id,r.requested_access_snapshot))) ELSE '{}'::jsonb END;
  END IF;
  IF jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' OR length(payload->>'text') NOT BETWEEN 1 AND 30000 OR jsonb_typeof(payload->'citations') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'citations')>8 OR jsonb_typeof(payload->'insufficientEvidence') IS DISTINCT FROM 'boolean' OR payload->>'model' IS DISTINCT FROM t.response_model
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(payload->'citations') citation WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(hits) h WHERE h->>'id'=citation))
   OR (jsonb_array_length(hits)>0 AND payload->'insufficientEvidence'='false' AND jsonb_array_length(payload->'citations')=0) THEN RAISE insufficient_privilege; END IF;
  IF d.committed_microusd>d.budget_usd*1000000 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.staging_turns SET status='succeeded',answer=payload->>'text',citations=payload->'citations',insufficient_evidence=(payload->>'insufficientEvidence')::boolean,lease_token=NULL,lease_until=NULL WHERE id=t.id;
  RETURN '{"ok":true}';
 END IF;
 RAISE insufficient_privilege;
END $function$;

CREATE OR REPLACE FUNCTION agentonic.staging_chat(operation text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();c agentonic.staging_conversations;d agentonic.deployments;t agentonic.staging_turns;n integer;items jsonb;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR w IS NULL OR m IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 IF operation='list' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',c1.id,'agentId',c1.agent_id,'agentName',a.name,'deploymentId',c1.deployment_id,'title',c1.title,'expiresAt',c1.expires_at) ORDER BY c1.created_at DESC),'[]') INTO items
   FROM agentonic.staging_conversations c1 JOIN agentonic.agents a ON a.id=c1.agent_id WHERE c1.workspace_id=w AND c1.owner_member_id=m AND agentonic.staging_conversation_readable(c1) AND agentonic.can_agent(c1.agent_id,'invoke');
  RETURN jsonb_build_object('ok',true,'conversations',items,'agents',coalesce((SELECT jsonb_agg(jsonb_build_object('id',dep.id,'agentId',dep.agent_id,'name',a.name,'environment',dep.environment)) FROM agentonic.deployments dep JOIN agentonic.agents a ON a.id=dep.agent_id WHERE dep.workspace_id=w AND dep.authorized_by_member_id=m AND dep.status='running' AND agentonic.deployment_online(dep) AND agentonic.deployment_authorized(dep) AND agentonic.can_agent(dep.agent_id,'invoke')),'[]'::jsonb));
 ELSIF operation='start' THEN
  SELECT * INTO d FROM agentonic.deployments WHERE id=(payload->>'deploymentId')::uuid AND workspace_id=w AND authorized_by_member_id=m;
  IF d.id IS NULL OR d.status<>'running' OR NOT agentonic.deployment_online(d) OR NOT agentonic.deployment_authorized(d) OR NOT agentonic.can_agent(d.agent_id,'invoke') THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
  IF (SELECT count(*) FROM agentonic.staging_conversations WHERE owner_member_id=m AND created_at>clock_timestamp()-interval '1 minute')>=5 THEN RETURN '{"ok":false,"code":"rate_limit"}'; END IF;
  INSERT INTO agentonic.staging_conversations(workspace_id,agent_id,deployment_id,owner_member_id,title,expires_at)
   VALUES(w,d.agent_id,d.id,m,btrim(payload->>'title'),clock_timestamp()+interval '30 days') RETURNING * INTO c;
  RETURN jsonb_build_object('ok',true,'id',c.id);
 END IF;
 SELECT * INTO c FROM agentonic.staging_conversations WHERE id=(payload->>'conversationId')::uuid AND workspace_id=w AND owner_member_id=m FOR UPDATE;
 IF c.id IS NULL OR NOT agentonic.can_agent(c.agent_id,'invoke') THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
 IF operation='close' THEN
  UPDATE agentonic.staging_conversations SET closed_at=clock_timestamp() WHERE id=c.id;
  UPDATE agentonic.staging_turns SET query='',answer=NULL,citations='[]',matches='[]',scrubbed_at=clock_timestamp(),status=CASE WHEN status IN ('queued','running') THEN 'cancelled' ELSE status END,lease_token=NULL,lease_until=NULL WHERE conversation_id=c.id;
  RETURN '{"ok":true}';
 END IF;
 IF NOT agentonic.staging_conversation_readable(c) THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
 SELECT * INTO d FROM agentonic.deployments WHERE id=c.deployment_id;
 IF operation='turn' THEN
  IF NOT agentonic.staging_conversation_authorized(c) THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
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
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',t1.id,'number',t1.number,'model',t1.response_model,'reasoning',t1.reasoning_effort,'query',t1.query,'answer',t1.answer,'partial',CASE WHEN t1.status='running' THEN t1.partial_answer END,'steps',t1.steps,'citations',t1.citations,'status',t1.status,'errorCode',t1.error_code,
   'version',(SELECT count(*)::int FROM agentonic.deployments dep JOIN agentonic.configuration_releases r ON r.id=dep.configuration_release_id JOIN agentonic.configuration_releases v ON v.agent_id=r.agent_id AND (v.created_at,v.id)<=(r.created_at,r.id) WHERE dep.id=coalesce(t1.deployment_id,c.deployment_id))) ORDER BY t1.number),'[]') INTO items FROM agentonic.staging_turns t1 WHERE t1.conversation_id=c.id;
  RETURN jsonb_build_object('ok',true,'id',c.id,'title',c.title,'agentId',c.agent_id,'expiresAt',c.expires_at,'canSend',agentonic.staging_conversation_authorized(c),'online',agentonic.deployment_online(d),'budgetUsd',d.budget_usd,'committedMicrousd',d.committed_microusd,'turns',items,'models',agentonic.deployment_models(d));
 END IF;
 RAISE insufficient_privilege;
END $function$;

CREATE OR REPLACE FUNCTION agentonic.rag_worker(operation text, job_id uuid, token uuid, payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
 ELSIF operation='partial' THEN
  -- The answer as it is written, shown while the preview turn runs (§68).
  IF c.execution_manifest->>'mailboxBatch' IS DISTINCT FROM '1' OR jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' OR length(payload->>'text')>30000 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.background_jobs SET partial_answer=payload->>'text' WHERE id=j.id;
  RETURN '{"ok":true}';
 ELSIF operation='steps' THEN
  -- The preview turn's tool calls as its broker runs them (§74).
  IF NOT agentonic.valid_turn_steps(payload->'steps') THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.background_jobs SET steps=payload->'steps' WHERE id=j.id;
  RETURN '{"ok":true}';
 ELSIF operation='context' THEN
  response:=agentonic.rag_worker_core_v8('context',job_id,token,'{}');
  SELECT coalesce(jsonb_agg(jsonb_build_object('path','skills/'||(s->>'name')||'.md','sha256',encode(sha256(convert_to(s->>'instructions','UTF8')),'hex')) ORDER BY s->>'name'),'[]') INTO assets FROM jsonb_array_elements(r.content->'skills') s;
  assets:=jsonb_build_array(jsonb_build_object('path','prompts/system.md','sha256',encode(sha256(convert_to(r.content->>'systemPrompt','UTF8')),'hex')))||assets;
  SELECT coalesce(jsonb_agg(jsonb_build_object('query',previous.payload->>'query','answer',previous.result->'answer'->>'text') ORDER BY previous.turn_number),'[]') INTO history FROM agentonic.background_jobs previous WHERE previous.preview_id=p.id AND previous.turn_number<j.turn_number AND previous.status='succeeded';
  RETURN response||jsonb_build_object('previewModel',j.response_model,'reasoningLevel',j.reasoning_effort,'environment','staging','audience','private','expiresAt',p.expires_at,'configurationJson',r.content::text,'contentSha256',r.content_sha256,'composedPromptSha256',r.composed_prompt_sha256,'assetManifestJson',assets::text,'assetManifestSha256',r.asset_manifest_sha256,'accessJson',r.requested_access_snapshot::text,'accessSha256',r.requested_access_sha256,'history',history)
    ||CASE WHEN c.execution_manifest->>'mailboxBatch'='1' THEN jsonb_strip_nulls(jsonb_build_object('styleGuide',agentonic.agent_style_guide(p.agent_id,r.requested_access_snapshot))) ELSE '{}'::jsonb END;
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
END $function$;

CREATE OR REPLACE FUNCTION agentonic.preview_command(operation text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE result jsonb;p agentonic.agent_previews;
BEGIN
 result:=agentonic.preview_command_v30(operation,payload);
 IF operation='state' AND result->>'ok'='true' THEN
  SELECT * INTO p FROM agentonic.agent_previews WHERE id=(result->>'id')::uuid;
  result:=result||jsonb_build_object('gmailEnabled',jsonb_array_length(agentonic.gmail_grants(p.execution_policy->'tools'))>0);
  -- A running turn shows its answer as it is written (§68), and every turn its steps (§74).
  result:=jsonb_set(result,'{turns}',coalesce((SELECT jsonb_agg(x.turn||CASE WHEN j.status='running' AND j.partial_answer IS NOT NULL THEN jsonb_build_object('partial',j.partial_answer) ELSE '{}'::jsonb END||CASE WHEN j.steps IS NOT NULL THEN jsonb_build_object('steps',j.steps) ELSE '{}'::jsonb END ORDER BY x.n)
   FROM jsonb_array_elements(result->'turns') WITH ORDINALITY x(turn,n) LEFT JOIN agentonic.background_jobs j ON j.id=(x.turn->>'id')::uuid AND j.preview_id=p.id),'[]'::jsonb));
 END IF;
 RETURN result;
END $function$;

-- valid_turn_steps keeps PUBLIC's EXECUTE: it reads only its argument, and
-- every role that updates either table evaluates it through the CHECK.
REVOKE ALL ON FUNCTION agentonic.scrub_turn_steps() FROM PUBLIC;
COMMIT;
