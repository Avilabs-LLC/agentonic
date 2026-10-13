BEGIN;
-- An activated chat keeps its answer when a reservation stays open
-- (architecture §66, 13 October 2026).
--
-- A failed web read keeps its Browserbase reservation unsettled on purpose:
-- uncertain usage is never refunded (§39.1), and the model goes on to another
-- source. So does a research request with an unknown outcome, after which the
-- runtime answers from the evidence it has. Previews then record the answer,
-- but staging_worker refused any answer while one of the turn's reservations
-- was still open. On 13 October a NicolAI-Mail turn met a redirect on one
-- web.read, finished its answer, and lost it as runtime_mismatch.
--
-- The answer now has the preview's rule: refused only over the deployment's
-- budget. An open reservation stays in committed_microusd, never refunded, and
-- counts as unknown cost after an hour (§50). select-matches still requires
-- the rerank reservation to be settled first. Evaluations keep their rule
-- that outstanding reservations block finalization.
--
-- The function below is migration 56's definition with only that condition
-- removed. CREATE OR REPLACE keeps its grants.

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
   FROM agentonic.staging_conversations conv WHERE conv.id=turn.conversation_id AND conv.deployment_id=d.id AND turn.status='running' AND (turn.lease_until<=clock_timestamp() OR turn.started_at<clock_timestamp()-interval '2 minutes');
  SELECT turn.* INTO t FROM agentonic.staging_turns turn JOIN agentonic.staging_conversations conv ON conv.id=turn.conversation_id
   WHERE conv.deployment_id=d.id AND turn.status='queued' AND agentonic.staging_conversation_authorized(conv) ORDER BY turn.created_at LIMIT 1 FOR UPDATE OF turn SKIP LOCKED;
  IF t.id IS NULL THEN RETURN NULL; END IF;
  UPDATE agentonic.staging_turns SET status='running',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '90 seconds',started_at=clock_timestamp() WHERE id=t.id RETURNING * INTO t;
  RETURN jsonb_build_object('id',t.id,'token',t.lease_token,'kind','retrieve','queuedAt',t.created_at);
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
  IF d.committed_microusd>d.budget_usd*1000000 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.staging_turns SET status='succeeded',answer=payload->>'text',citations=payload->'citations',insufficient_evidence=(payload->>'insufficientEvidence')::boolean,lease_token=NULL,lease_until=NULL WHERE id=t.id;
  RETURN '{"ok":true}';
 END IF;
 RAISE insufficient_privilege;
END $function$;
COMMIT;
