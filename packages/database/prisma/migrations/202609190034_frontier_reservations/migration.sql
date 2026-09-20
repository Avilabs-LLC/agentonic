BEGIN;
-- A frontier request can reserve more than US$1 after several page reads.
-- Keep ordinary/model-baseline calls capped at US$1. The preview wrapper
-- still checks the remaining session budget before this global reservation.
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
  IF amount NOT BETWEEN 1 AND (CASE WHEN j.preview_id IS NOT NULL AND j.response_model='gpt-6-astra' THEN 3000000 ELSE 1000000 END) THEN RAISE insufficient_privilege; END IF;
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


COMMIT;
