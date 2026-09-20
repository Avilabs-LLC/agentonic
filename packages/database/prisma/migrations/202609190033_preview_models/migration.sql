BEGIN;
-- Preview-only, explicit per-turn model selection. Frozen candidates, evaluations
-- and deployed chats retain their published model contract. No budget is reset.
ALTER TABLE agentonic.background_jobs ADD COLUMN response_model text NOT NULL DEFAULT 'gpt-4.1-mini-2025-04-14'
 CHECK(response_model='gpt-4.1-mini-2025-04-14' OR (preview_id IS NOT NULL AND kind='retrieve' AND response_model='gpt-6-astra'));
ALTER TABLE agentonic.agent_previews DROP CONSTRAINT agent_previews_budget_usd_check;
ALTER TABLE agentonic.agent_previews ADD CONSTRAINT agent_previews_budget_usd_check CHECK(budget_usd IN (0.25,3));
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
  payload:=jsonb_build_object('model','gpt-4.1-mini-2025-04-14')||payload;
  IF NOT coalesce(payload->>'model' IN ('gpt-4.1-mini-2025-04-14','gpt-6-astra'),false) THEN RAISE insufficient_privilege; END IF;
  IF length(btrim(payload->>'query')) NOT BETWEEN 1 AND 1000 OR payload->>'query' IS NULL OR payload->>'requestKey' IS NULL THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO j FROM agentonic.background_jobs WHERE preview_id=p.id AND request_key=(payload->>'requestKey')::uuid;
  IF j.id IS NOT NULL THEN
   IF j.response_model IS DISTINCT FROM payload->>'model' OR j.payload->>'query' IS DISTINCT FROM btrim(payload->>'query') THEN RETURN '{"ok":false,"code":"request_conflict"}'; END IF;
   RETURN jsonb_build_object('ok',true,'id',j.id);
  END IF;
  IF EXISTS(SELECT 1 FROM agentonic.background_jobs WHERE preview_id=p.id AND status IN ('queued','running')) THEN RETURN '{"ok":false,"code":"busy"}'; END IF;
  SELECT coalesce(max(turn_number),0)+1 INTO n FROM agentonic.background_jobs WHERE preview_id=p.id;
  IF n>10 THEN RETURN '{"ok":false,"code":"turn_limit"}'; END IF;
  INSERT INTO agentonic.background_jobs(workspace_id,member_id,kind,preview_id,turn_number,request_key,response_model,payload)
  SELECT w,m,'retrieve',p.id,n,(payload->>'requestKey')::uuid,payload->>'model',jsonb_build_object('query',btrim(payload->>'query'),'collectionIds',frozen.requested_access_snapshot->'collectionIds','generateAnswer',true)
  FROM agentonic.configuration_releases frozen WHERE frozen.id=p.configuration_release_id RETURNING * INTO j;
  RETURN jsonb_build_object('ok',true,'id',j.id);
 ELSIF operation='state' THEN
  FOR j IN SELECT * FROM agentonic.background_jobs WHERE preview_id=p.id ORDER BY turn_number LOOP
   response:=agentonic.rag_command('result',jsonb_build_object('id',j.id));
   IF response->>'status'='unavailable' THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
   turns:=turns||jsonb_build_array(response||jsonb_build_object('id',j.id,'number',j.turn_number,'model',j.response_model,'query',j.payload->>'query'));
  END LOOP;
  RETURN jsonb_build_object('ok',true,'id',p.id,'expiresAt',p.expires_at,'budgetUsd',p.budget_usd,'committedMicrousd',p.committed_microusd,'toolsEnabled',jsonb_array_length(p.execution_policy->'tools')>0,'turns',turns);
 END IF;
 RAISE insufficient_privilege;
END $$;

CREATE OR REPLACE FUNCTION agentonic.rag_worker_core_v8(operation text,job_id uuid,token uuid,payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE j agentonic.background_jobs; o agentonic.stored_objects; v agentonic.document_versions; d agentonic.documents;
 profile uuid; item jsonb; result jsonb; hits jsonb; src uuid; ordinal integer:=0; amount bigint; budget agentonic.retrieval_provider_budgets; meter agentonic.retrieval_provider_operations;
BEGIN
 IF agentonic.application_role()<>'agentonic_worker' THEN RAISE insufficient_privilege; END IF;
 -- Consistent workspace-before-job ordering with customer mutations.
 SELECT * INTO j FROM agentonic.background_jobs WHERE id=job_id;
 IF j.id IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=j.workspace_id FOR SHARE;
 SELECT * INTO j FROM agentonic.background_jobs WHERE id=job_id FOR UPDATE;
 IF j.status<>'running' OR j.lease_token IS DISTINCT FROM token OR j.lease_until<=clock_timestamp() OR NOT agentonic.rag_job_authorized(j) THEN RAISE insufficient_privilege; END IF;
 IF operation='heartbeat' THEN
  UPDATE agentonic.background_jobs SET lease_until=clock_timestamp()+interval '90 seconds' WHERE id=j.id;
  RETURN '{"ok":true}';
 ELSIF operation='read' THEN
  IF j.kind='retrieve' THEN RETURN jsonb_build_object('kind',j.kind,'workspaceId',j.workspace_id,'query',j.payload->>'query','generateAnswer',j.payload->'generateAnswer'); END IF;
  SELECT * INTO o FROM agentonic.stored_objects WHERE id=j.object_id AND workspace_id=j.workspace_id;
  RETURN jsonb_build_object('kind',j.kind,'workspaceId',j.workspace_id,'objectId',o.id,'objectKey',o.object_key,'contentType',o.content_type,'sha256',o.content_sha256,'size',o.size_bytes);
 ELSIF operation='reserve' THEN
  IF j.kind='purge' OR NOT coalesce((payload->>'provider'='voyage' AND (payload->>'model'='voyage-4' OR j.kind='retrieve' AND payload->>'model'='rerank-2.5-lite')) OR (j.kind='retrieve' AND j.payload->>'generateAnswer'='true' AND payload->>'provider'='openai' AND payload->>'model'=j.response_model),false) THEN RAISE insufficient_privilege; END IF;
  amount:=(payload->>'microusd')::bigint;
  IF amount NOT BETWEEN 1 AND 1000000 THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO budget FROM agentonic.retrieval_provider_budgets WHERE provider=payload->>'provider' FOR UPDATE;
  IF budget.committed_microusd+amount>budget.cap_microusd THEN RETURN '{"ok":false,"code":"budget_exhausted"}'; END IF;
  INSERT INTO agentonic.retrieval_provider_operations(id,job_id,workspace_id,provider,model,reserved_microusd) VALUES((payload->>'id')::uuid,j.id,j.workspace_id,budget.provider,payload->>'model',amount);
  UPDATE agentonic.retrieval_provider_budgets SET committed_microusd=committed_microusd+amount,updated_at=clock_timestamp() WHERE provider=budget.provider;
  RETURN '{"ok":true}';
 ELSIF operation='settle' THEN
  SELECT * INTO meter FROM agentonic.retrieval_provider_operations WHERE id=(payload->>'id')::uuid AND workspace_id=j.workspace_id AND job_id=j.id FOR UPDATE;
  IF meter.id IS NULL OR meter.status<>'reserved' THEN RAISE insufficient_privilege; END IF;
  amount:=(payload->>'microusd')::bigint;
  IF amount<0 OR (payload->>'tokens')::bigint<0 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.retrieval_provider_operations SET actual_microusd=amount,input_tokens=(payload->>'tokens')::bigint,output_tokens=coalesce((payload->>'outputTokens')::bigint,0),status='settled' WHERE id=meter.id;
  UPDATE agentonic.retrieval_provider_budgets SET committed_microusd=committed_microusd-meter.reserved_microusd+amount,updated_at=clock_timestamp() WHERE provider=meter.provider;
  RETURN '{"ok":true}';
 ELSIF operation='publish' AND j.kind='ingest' THEN
  SELECT * INTO v FROM agentonic.document_versions WHERE object_id=j.object_id AND workspace_id=j.workspace_id FOR UPDATE;
  IF v.id IS NULL OR jsonb_typeof(payload->'chunks') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'chunks') NOT BETWEEN 1 AND 1000 OR payload->>'parser' NOT IN ('text-v1','pdf-parse-2.4.5') THEN RAISE insufficient_privilege; END IF;
  SELECT id INTO profile FROM agentonic.retrieval_profile WHERE model_identifier='voyage-4' AND dimensions=1024;
  DELETE FROM agentonic.document_chunks WHERE document_version_id=v.id;
  FOR item IN SELECT value FROM jsonb_array_elements(payload->'chunks') LOOP
   IF jsonb_array_length(item->'embedding')<>1024 OR length(item->>'text') NOT BETWEEN 1 AND 12000 THEN RAISE insufficient_privilege; END IF;
   INSERT INTO agentonic.document_chunks(workspace_id,document_version_id,ordinal,content,content_sha256,locator,search_vector,embedding,embedding_profile_id)
   VALUES(j.workspace_id,v.id,ordinal,item->>'text',encode(sha256(convert_to(item->>'text','UTF8')),'hex'),item->'locator',
    to_tsvector('pg_catalog.simple',item->>'text')||to_tsvector('pg_catalog.spanish',item->>'text')||to_tsvector('pg_catalog.english',item->>'text'),(item->'embedding')::text::public.vector,profile);
   ordinal:=ordinal+1;
  END LOOP;
  UPDATE agentonic.document_versions SET status='ready',parser_version=payload->>'parser',chunker_version='sections-v1',metadata=metadata-'processingError' WHERE id=v.id;
  UPDATE agentonic.documents SET active_version_id=v.id WHERE id=v.document_id AND deleted_at IS NULL;
  UPDATE agentonic.background_jobs SET status='succeeded',payload='{}',result='{}',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=j.id;
  RETURN jsonb_build_object('ok',true,'chunks',ordinal);
 ELSIF operation='search' AND j.kind='retrieve' THEN
  IF jsonb_array_length(payload->'embedding')<>1024 THEN RAISE insufficient_privilege; END IF;
  -- Materialize authorized active versions BEFORE either ranking operation.
  WITH eligible AS MATERIALIZED (
   SELECT c.* FROM agentonic.document_chunks c JOIN agentonic.document_versions dv ON dv.id=c.document_version_id JOIN agentonic.documents dd ON dd.id=dv.document_id AND dd.active_version_id=dv.id JOIN agentonic.knowledge_sources s ON s.id=dd.source_id
   WHERE c.workspace_id=j.workspace_id AND dd.deleted_at IS NULL AND dv.status='ready' AND s.environment='staging' AND s.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb AND j.payload->'collectionIds' @> to_jsonb(s.collection_id::text) AND agentonic.member_can_collection(j.member_id,s.collection_id,'read') AND (j.preview_id IS NULL OR EXISTS(SELECT 1 FROM agentonic.agent_previews p WHERE p.id=j.preview_id AND agentonic.preview_source_allowed(p,s.id)))
  ), semantic AS (
   SELECT id,row_number() OVER(ORDER BY embedding OPERATOR(public.<=>) (payload->'embedding')::text::public.vector,id) AS rank FROM eligible ORDER BY embedding OPERATOR(public.<=>) (payload->'embedding')::text::public.vector,id LIMIT 40
  ), lexical AS (
   SELECT id,row_number() OVER(ORDER BY ts_rank_cd(search_vector,q) DESC,id) AS rank FROM eligible, LATERAL(SELECT websearch_to_tsquery('pg_catalog.simple',j.payload->>'query')||websearch_to_tsquery('pg_catalog.spanish',j.payload->>'query')||websearch_to_tsquery('pg_catalog.english',j.payload->>'query') AS q) query
   WHERE search_vector@@q ORDER BY ts_rank_cd(search_vector,q) DESC,id LIMIT 40
  ), ranked AS (
   SELECT coalesce(s.id,l.id) id,coalesce(1.0/(60+s.rank),0)+coalesce(1.0/(60+l.rank),0) score FROM semantic s FULL JOIN lexical l ON s.id=l.id ORDER BY score DESC,coalesce(s.id,l.id) LIMIT CASE WHEN payload->>'rerank'='true' THEN 32 ELSE 8 END
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'score',score) ORDER BY score DESC,id),'[]') INTO hits FROM ranked;
  UPDATE agentonic.background_jobs SET status=CASE WHEN (j.payload->>'generateAnswer'='true' OR payload->>'rerank'='true') THEN 'running' ELSE 'succeeded' END,payload=CASE WHEN (j.payload->>'generateAnswer'='true' OR payload->>'rerank'='true') THEN j.payload ELSE CASE WHEN j.preview_id IS NULL THEN j.payload-'query' ELSE j.payload END END,result=jsonb_build_object('matches',hits),lease_token=CASE WHEN (j.payload->>'generateAnswer'='true' OR payload->>'rerank'='true') THEN j.lease_token ELSE NULL END,lease_until=CASE WHEN (j.payload->>'generateAnswer'='true' OR payload->>'rerank'='true') THEN j.lease_until ELSE NULL END,updated_at=clock_timestamp() WHERE id=j.id;
  RETURN '{"ok":true}';
 ELSIF operation IN ('context','answer','rerank-context','select-matches') AND j.kind='retrieve' AND (j.payload->>'generateAnswer'='true' OR operation IN ('rerank-context','select-matches')) THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'text',c.content) ORDER BY hit.ordinality),'[]') INTO hits
  FROM jsonb_array_elements(coalesce(j.result->'matches','[]')) WITH ORDINALITY hit(value,ordinality)
  JOIN agentonic.document_chunks c ON c.id=(hit.value->>'id')::uuid AND c.workspace_id=j.workspace_id
  JOIN agentonic.document_versions dv ON dv.id=c.document_version_id
  JOIN agentonic.documents dd ON dd.id=dv.document_id AND dd.active_version_id=dv.id
  JOIN agentonic.knowledge_sources s ON s.id=dd.source_id
  WHERE dd.deleted_at IS NULL AND dv.status='ready' AND s.environment='staging' AND s.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb
  AND j.payload->'collectionIds' @> to_jsonb(s.collection_id::text) AND agentonic.member_can_collection(j.member_id,s.collection_id,'read') AND (j.preview_id IS NULL OR EXISTS(SELECT 1 FROM agentonic.agent_previews p WHERE p.id=j.preview_id AND agentonic.preview_source_allowed(p,s.id)));
  IF jsonb_array_length(hits)<>jsonb_array_length(coalesce(j.result->'matches','[]')) THEN RAISE insufficient_privilege; END IF;
  IF operation='rerank-context' THEN RETURN jsonb_build_object('passages',hits); END IF;
  IF operation='select-matches' THEN
   IF EXISTS(SELECT 1 FROM agentonic.retrieval_provider_operations op WHERE op.job_id=j.id AND op.status='reserved') THEN RAISE insufficient_privilege; END IF;
   hits:=agentonic.select_retrieval_matches(coalesce(j.result->'matches','[]'),payload->'ids');
   UPDATE agentonic.background_jobs SET result=jsonb_build_object('matches',hits),status=CASE WHEN j.payload->>'generateAnswer'='true' THEN 'running' ELSE 'succeeded' END,payload=CASE WHEN j.payload->>'generateAnswer'='true' OR j.preview_id IS NOT NULL THEN j.payload ELSE j.payload-'query' END,lease_token=CASE WHEN j.payload->>'generateAnswer'='true' THEN j.lease_token ELSE NULL END,lease_until=CASE WHEN j.payload->>'generateAnswer'='true' THEN j.lease_until ELSE NULL END WHERE id=j.id;
   RETURN '{"ok":true}';
  END IF;
  IF jsonb_array_length(hits)>8 THEN RAISE insufficient_privilege; END IF;
  IF operation='context' THEN RETURN jsonb_build_object('query',j.payload->>'query','passages',hits); END IF;
  IF length(payload->>'text') NOT BETWEEN 1 AND 12000 OR jsonb_typeof(payload->'citations') IS DISTINCT FROM 'array'
   OR payload->>'model' IS DISTINCT FROM j.response_model OR jsonb_typeof(payload->'insufficientEvidence') IS DISTINCT FROM 'boolean'
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(payload->'citations') citation WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(hits) h WHERE h->>'id'=citation))
   OR (payload->>'insufficientEvidence'='false' AND jsonb_array_length(payload->'citations')=0) THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.background_jobs SET status='succeeded',payload=CASE WHEN j.preview_id IS NULL THEN j.payload-'query' ELSE j.payload END,result=j.result||jsonb_build_object('answer',jsonb_build_object('text',payload->>'text','citations',payload->'citations','insufficientEvidence',payload->'insufficientEvidence','model',payload->>'model')),lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=j.id;
  RETURN '{"ok":true}';
 ELSIF operation='purged' AND j.kind='purge' THEN
  SELECT * INTO v FROM agentonic.document_versions WHERE object_id=j.object_id AND workspace_id=j.workspace_id;
  SELECT * INTO d FROM agentonic.documents WHERE id=v.document_id AND workspace_id=j.workspace_id;
  DELETE FROM agentonic.ingestion_jobs WHERE source_id=d.source_id AND workspace_id=j.workspace_id;
  DELETE FROM agentonic.background_jobs WHERE object_id=j.object_id AND id<>j.id;
  UPDATE agentonic.documents SET active_version_id=NULL WHERE id=d.id;
  DELETE FROM agentonic.document_versions WHERE document_id=d.id;
  DELETE FROM agentonic.documents WHERE id=d.id;
  DELETE FROM agentonic.knowledge_sources WHERE id=d.source_id AND workspace_id=j.workspace_id AND kind='upload' AND NOT EXISTS(SELECT 1 FROM agentonic.documents WHERE source_id=d.source_id);
  DELETE FROM agentonic.stored_objects WHERE id=j.object_id AND workspace_id=j.workspace_id AND deleted_at IS NOT NULL;
  DELETE FROM agentonic.background_jobs WHERE id=j.id;
  RETURN '{"ok":true}';
 ELSIF operation='fail' THEN
  IF payload->>'code' NOT IN ('provider_unavailable','budget_exhausted','invalid_document','ocr_required','too_much_text','storage_unavailable','configuration_required','lease_lost') THEN RAISE insufficient_privilege; END IF;
  IF j.preview_id IS NULL AND (j.kind='purge' OR payload->>'code' IN ('provider_unavailable','storage_unavailable','configuration_required')) THEN
   UPDATE agentonic.background_jobs SET status='queued',lease_token=NULL,lease_until=NULL,error_code=payload->>'code',available_at=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp() WHERE id=j.id;
  ELSE
   UPDATE agentonic.background_jobs SET status='failed',lease_token=NULL,lease_until=NULL,error_code=payload->>'code',payload=CASE WHEN kind='retrieve' THEN CASE WHEN j.preview_id IS NULL THEN j.payload-'query' ELSE j.payload END ELSE j.payload END,updated_at=clock_timestamp() WHERE id=j.id;
  END IF;
  IF j.kind='ingest' THEN UPDATE agentonic.document_versions SET status=CASE WHEN EXISTS(SELECT 1 FROM agentonic.documents WHERE active_version_id=document_versions.id) THEN 'ready' ELSE 'failed' END,metadata=metadata||jsonb_build_object('processingError',payload->>'code') WHERE object_id=j.object_id; END IF;
  RETURN '{"ok":true}';
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
  RETURN response||jsonb_build_object('previewModel',j.response_model,'environment','staging','audience','private','expiresAt',p.expires_at,'configurationJson',r.content::text,'contentSha256',r.content_sha256,'composedPromptSha256',r.composed_prompt_sha256,'assetManifestJson',assets::text,'assetManifestSha256',r.asset_manifest_sha256,'accessJson',r.requested_access_snapshot::text,'accessSha256',r.requested_access_sha256,'history',history);
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

COMMIT;
