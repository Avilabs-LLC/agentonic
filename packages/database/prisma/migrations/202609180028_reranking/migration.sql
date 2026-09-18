BEGIN;
-- Opt-in two-stage retrieval; legacy search remains eight passages.
-- Existing live worker/deployment authorization and budget checks are preserved.
-- Only reorder/select the already authorized candidates. Never accept text or new IDs.
CREATE FUNCTION agentonic.select_retrieval_matches(candidates jsonb, selection jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE selected jsonb;
BEGIN
 IF jsonb_typeof(selection) IS DISTINCT FROM 'array' THEN RAISE insufficient_privilege; END IF;
 IF jsonb_array_length(selection)>least(8,jsonb_array_length(candidates)) OR (jsonb_array_length(candidates)>0 AND jsonb_array_length(selection)=0)
 OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(selection))<>jsonb_array_length(selection)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(selection) chosen WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(candidates) c WHERE c->>'id'=chosen)) THEN RAISE insufficient_privilege; END IF;
 SELECT coalesce(jsonb_agg(c.value ORDER BY s.ordinality),'[]') INTO selected FROM jsonb_array_elements_text(selection) WITH ORDINALITY s(value,ordinality)
 JOIN jsonb_array_elements(candidates) c ON c.value->>'id'=s.value;
 RETURN selected;
END $$;
REVOKE ALL ON FUNCTION agentonic.select_retrieval_matches(jsonb,jsonb) FROM PUBLIC;
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
  IF j.kind='purge' OR NOT coalesce((payload->>'provider'='voyage' AND (payload->>'model'='voyage-4' OR j.kind='retrieve' AND payload->>'model'='rerank-2.5-lite')) OR (j.kind='retrieve' AND j.payload->>'generateAnswer'='true' AND payload->>'provider'='openai' AND payload->>'model'='gpt-4.1-mini-2025-04-14'),false) THEN RAISE insufficient_privilege; END IF;
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
   OR payload->>'model'<>'gpt-4.1-mini-2025-04-14' OR jsonb_typeof(payload->'insufficientEvidence') IS DISTINCT FROM 'boolean'
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

CREATE OR REPLACE FUNCTION agentonic.evaluation_worker(operation text,run_id uuid,token uuid,payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE e agentonic.evaluation_runs; worker agentonic.evaluation_workers; config agentonic.configuration_releases; code agentonic.code_releases;
 sources jsonb; hits jsonb; assets jsonb; test_case jsonb; checks jsonb; passed boolean; amount bigint;
 budget agentonic.retrieval_provider_budgets; meter agentonic.retrieval_provider_operations; p agentonic.evaluation_preparations; assessment jsonb; decision_id uuid;
BEGIN
 SELECT * INTO worker FROM agentonic.evaluation_workers WHERE database_role=agentonic.application_role() AND revoked_at IS NULL AND verified_at>clock_timestamp()-interval '7 days';
 SELECT * INTO e FROM agentonic.evaluation_runs WHERE id=run_id;
 IF worker.id IS NULL OR e.id IS NULL OR e.worker_id IS DISTINCT FROM worker.id THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=e.workspace_id FOR SHARE;
 SELECT * INTO p FROM agentonic.evaluation_preparations WHERE id=e.preparation_id FOR UPDATE;
 SELECT * INTO e FROM agentonic.evaluation_runs WHERE id=run_id FOR UPDATE;
 IF e.preparation_id IS NOT NULL AND (worker.environment<>'azure_staging' OR NOT worker.verification @> '{"reviewProtocol":2}') THEN RAISE insufficient_privilege; END IF;
 IF e.status<>'running' OR e.lease_token IS DISTINCT FROM token OR e.lease_until<=clock_timestamp() OR e.started_at<clock_timestamp()-interval '30 minutes' THEN RAISE insufficient_privilege; END IF;
 IF operation='fail' THEN
  UPDATE agentonic.evaluation_preparations SET status='error',finished_at=clock_timestamp() WHERE id=e.preparation_id AND status='evaluating';
  UPDATE agentonic.evaluation_runs SET status='error',error_code=CASE WHEN payload->>'code' IN ('provider_unavailable','budget_exhausted','configuration_required','lease_lost','runtime_mismatch') THEN payload->>'code' ELSE 'lease_lost' END,lease_token=NULL,lease_until=NULL,current_matches='[]',finished_at=clock_timestamp() WHERE id=e.id;
  RETURN '{"ok":true}';
 END IF;
 IF NOT agentonic.evaluation_authorized(e) THEN RAISE insufficient_privilege; END IF;
 SELECT * INTO config FROM agentonic.configuration_releases WHERE id=e.configuration_release_id;
 SELECT * INTO code FROM agentonic.code_releases WHERE id=e.code_release_id;
 IF code.artifact_sha256<>worker.runtime_sha256 THEN RAISE insufficient_privilege; END IF;
 test_case:=e.dataset_snapshot->e.next_case;
 IF operation='heartbeat' THEN
  UPDATE agentonic.evaluation_runs SET lease_until=clock_timestamp()+interval '90 seconds' WHERE id=e.id;
  RETURN '{"ok":true}';
 ELSIF operation='read' THEN
  RETURN jsonb_build_object('reviewProtocol',CASE WHEN e.preparation_id IS NULL THEN 1 ELSE 2 END,'kind','retrieve','workspaceId',e.workspace_id,'query',test_case->>'question','generateAnswer',true,'preview',true,'hasCollections',jsonb_array_length(config.requested_access_snapshot->'collectionIds')>0,
  'runtime',jsonb_build_object('gitCommit',code.git_commit_sha,'artifactSha256',code.artifact_sha256,'manifest',code.execution_manifest));
 ELSIF operation='reserve' THEN
  IF NOT coalesce((payload->>'provider'='voyage' AND (payload->>'model'='voyage-4' OR payload->>'model'='rerank-2.5-lite')) OR (payload->>'provider'='openai' AND payload->>'model'='gpt-4.1-mini-2025-04-14'),false) THEN RAISE insufficient_privilege; END IF;
  amount:=(payload->>'microusd')::bigint;
  IF amount IS NULL OR amount NOT BETWEEN 1 AND 1000000 THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO budget FROM agentonic.retrieval_provider_budgets WHERE provider=payload->>'provider' FOR UPDATE;
  IF budget.provider IS NULL THEN RAISE insufficient_privilege; END IF;
  IF (p.id IS NOT NULL AND p.committed_microusd+amount>p.budget_usd*1000000) OR e.committed_microusd+amount>e.budget_usd*1000000 OR budget.committed_microusd+amount>budget.cap_microusd THEN RETURN '{"ok":false,"code":"budget_exhausted"}'; END IF;
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
   RETURN jsonb_build_object('criterion',test_case,'passages',hits,'references',sources,'configuration',config.content);
  END IF;
  IF operation='context' THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('path','skills/'||(s->>'name')||'.md','sha256',encode(sha256(convert_to(s->>'instructions','UTF8')),'hex')) ORDER BY s->>'name'),'[]') INTO assets FROM jsonb_array_elements(config.content->'skills') s;
   assets:=jsonb_build_array(jsonb_build_object('path','prompts/system.md','sha256',encode(sha256(convert_to(config.content->>'systemPrompt','UTF8')),'hex')))||assets;
   RETURN jsonb_build_object('query',test_case->>'question','passages',hits,'environment','staging','audience','private','expiresAt',least(e.expires_at,e.started_at+interval '30 minutes'),
   'configurationJson',config.content::text,'contentSha256',config.content_sha256,'composedPromptSha256',config.composed_prompt_sha256,'assetManifestJson',assets::text,'assetManifestSha256',config.asset_manifest_sha256,'accessJson',config.requested_access_snapshot::text,'accessSha256',config.requested_access_sha256,'history','[]'::jsonb);
  END IF;
  IF jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' OR length(payload->>'text') NOT BETWEEN 1 AND 12000 OR jsonb_typeof(payload->'citations') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'citations')>8 OR jsonb_typeof(payload->'insufficientEvidence') IS DISTINCT FROM 'boolean' OR payload->>'model' IS DISTINCT FROM 'gpt-4.1-mini-2025-04-14'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(payload->'citations') citation WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(hits) h WHERE h->>'id'=citation)) THEN RAISE insufficient_privilege; END IF;
  IF (p.id IS NOT NULL AND p.committed_microusd>p.budget_usd*1000000) OR e.committed_microusd>e.budget_usd*1000000 OR EXISTS(SELECT 1 FROM agentonic.retrieval_provider_operations WHERE job_id=e.id AND status='reserved') THEN RAISE insufficient_privilege; END IF;
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
   evidence_sha256=agentonic.content_hash(jsonb_build_object('results',sources,'dataset',e.dataset_sha256,'grader',e.grader_sha256,'configuration',e.configuration_sha256,'access',e.requested_access_sha256,'runtime',code.artifact_sha256,'worker',worker.worker_sha256,'environment',worker.environment)) WHERE id=e.id;

   IF p.id IS NOT NULL THEN
    SELECT * INTO e FROM agentonic.evaluation_runs WHERE id=run_id;
    IF passed AND agentonic.review_auto_eligible(e) THEN
     INSERT INTO agentonic.submission_review_decisions(workspace_id,agent_id,submission_id,decision_number,decision,actor_policy_version,feedback,approval_expires_at,approved_access_sha256,assessment_snapshot)
     SELECT e.workspace_id,e.agent_id,e.submission_id,coalesce(max(decision_number),0)+1,'approved','readonly-review-v1','La versión superó los criterios confirmados y los controles de la plataforma.',least(clock_timestamp()+interval '24 hours',e.expires_at),e.requested_access_sha256,
     jsonb_build_object('version',3,'evaluationId',e.id,'evidenceHash',e.evidence_sha256,'configurationHash',e.configuration_sha256,'requestedAccessHash',e.requested_access_sha256,'evaluated',true,'humanReviewed',false,'policy','readonly-review-v1')
     FROM agentonic.submission_review_decisions WHERE submission_id=e.submission_id RETURNING id INTO decision_id;
     UPDATE agentonic.agent_submissions SET status='approved' WHERE id=e.submission_id;
     UPDATE agentonic.evaluation_preparations SET status='approved',finished_at=clock_timestamp() WHERE id=p.id;
    ELSE
     UPDATE agentonic.evaluation_preparations SET status=CASE WHEN NOT passed AND EXISTS(SELECT 1 FROM agentonic.evaluation_results r WHERE r.evaluation_run_id=e.id AND r.outcome='failed' AND r.assessment->>'verdict'='needs_changes') THEN 'needs_changes' ELSE 'needs_attention' END,finished_at=clock_timestamp() WHERE id=p.id;
    END IF;
   END IF;
  ELSE
   UPDATE agentonic.evaluation_runs SET next_case=next_case+1,current_matches='[]' WHERE id=e.id;
  END IF;
  RETURN '{"ok":true}';
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
  IF NOT coalesce((payload->>'provider'='voyage' AND (payload->>'model'='voyage-4' OR payload->>'model'='rerank-2.5-lite')) OR (payload->>'provider'='openai' AND payload->>'model'='gpt-4.1-mini-2025-04-14'),false) THEN RAISE insufficient_privilege; END IF;
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
   RETURN jsonb_build_object('query',t.query,'passages',hits,'environment','staging','audience','private','expiresAt',least(c.expires_at,t.started_at+interval '2 minutes'),
    'configurationJson',r.content::text,'contentSha256',r.content_sha256,'composedPromptSha256',r.composed_prompt_sha256,'assetManifestJson',assets::text,'assetManifestSha256',r.asset_manifest_sha256,'accessJson',r.requested_access_snapshot::text,'accessSha256',r.requested_access_sha256,'history',history);
  END IF;
  IF jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' OR length(payload->>'text') NOT BETWEEN 1 AND 12000 OR jsonb_typeof(payload->'citations') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'citations')>8 OR jsonb_typeof(payload->'insufficientEvidence') IS DISTINCT FROM 'boolean' OR payload->>'model' IS DISTINCT FROM 'gpt-4.1-mini-2025-04-14'
   OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(payload->'citations') citation WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(hits) h WHERE h->>'id'=citation))
   OR (jsonb_array_length(hits)>0 AND payload->'insufficientEvidence'='false' AND jsonb_array_length(payload->'citations')=0) THEN RAISE insufficient_privilege; END IF;
  IF d.committed_microusd>d.budget_usd*1000000 OR EXISTS(SELECT 1 FROM agentonic.retrieval_provider_operations op WHERE op.job_id=t.id AND op.status='reserved') THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.staging_turns SET status='succeeded',answer=payload->>'text',citations=payload->'citations',insufficient_evidence=(payload->>'insufficientEvidence')::boolean,lease_token=NULL,lease_until=NULL WHERE id=t.id;
  RETURN '{"ok":true}';
 END IF;
 RAISE insufficient_privilege;
END $$;
COMMIT;
