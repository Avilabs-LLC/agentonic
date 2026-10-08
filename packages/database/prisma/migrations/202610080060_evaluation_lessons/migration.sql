-- Evaluation lessons (architecture §56, owner request, 8 October 2026).
-- A customer's mail agent failed four evaluations for reasons mostly ours:
-- criteria asked the agent about itself, the grader asked for evidence one
-- answer cannot give, and one failing model blocked the models that passed.
-- Each function below is its current definition with only the noted change.
--
-- 1. Grader version 5: GPT-5.4 mini at low reasoning, with rules that treat the
--    configuration as the authority for the agent's own behavior. New runs get
--    it only while the Azure evaluator advertises reviewRubric 5.
-- 2. Criteria are written by GPT-5.4 mini, which now also sees requested access.
-- 3. A batch is decided per model: a version can be approved with the models
--    whose every level passed, and Chats offer only those models.
-- 4. GPT-4.1 mini is retired for new evaluations and test chats. Earlier runs,
--    turns and approvals that name it stay valid.

ALTER TABLE agentonic.evaluation_runs DROP CONSTRAINT evaluation_runs_grader;
ALTER TABLE agentonic.evaluation_runs ADD CONSTRAINT evaluation_runs_grader CHECK(grader_sha256=agentonic.content_hash(grader_snapshot) AND ((preparation_id IS NULL AND grader_snapshot='{"version":"phrases-citations-v1","threshold":1}') OR (preparation_id IS NOT NULL AND grader_snapshot IN ('{"version":"grounded-review-v2","model":"gpt-4.1-mini-2025-04-14","policy":"readonly-review-v1"}'::jsonb,'{"version":"grounded-review-v3","model":"gpt-4.1-mini-2025-04-14","policy":"readonly-review-v1"}'::jsonb,'{"version":"grounded-review-v4","model":"gpt-4.1-mini-2025-04-14","policy":"readonly-review-v1"}'::jsonb,'{"version":"grounded-review-v5","model":"gpt-5.4-mini","reasoning":"low","policy":"readonly-review-v1"}'::jsonb))));

-- 1. New runs use rubric 5 while the evaluator can grade with it.
CREATE OR REPLACE FUNCTION agentonic.evaluation_tool_cases()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE cases jsonb; v4 jsonb:='{"version":"grounded-review-v4","model":"gpt-4.1-mini-2025-04-14","policy":"readonly-review-v1"}'; v5 jsonb:='{"version":"grounded-review-v5","model":"gpt-5.4-mini","reasoning":"low","policy":"readonly-review-v1"}'; grader jsonb; fixtures boolean; rubric5 boolean;
BEGIN
 IF NEW.preparation_id IS NULL OR NEW.environment<>'azure_staging' OR NEW.grader_snapshot->>'version' IS DISTINCT FROM 'grounded-review-v3' THEN RETURN NEW; END IF;
 -- What the registered Azure evaluator that runs this runtime can do.
 SELECT coalesce(bool_or(worker.verification @> '{"toolFixtures":1}'),false),coalesce(bool_or(worker.verification @> '{"reviewRubric":5}'),false) INTO fixtures,rubric5
 FROM agentonic.evaluation_workers worker JOIN agentonic.code_releases code ON code.id=NEW.code_release_id AND agentonic.evaluator_runs(worker.id,code.artifact_sha256)
 WHERE worker.environment='azure_staging' AND worker.revoked_at IS NULL AND worker.retired_at IS NULL AND worker.verified_at>clock_timestamp()-interval '30 days'
 AND worker.verification @> '{"reviewProtocol":3}';
 IF fixtures THEN
  SELECT agentonic.platform_tool_cases(r.requested_access_snapshot) INTO cases FROM agentonic.configuration_releases r WHERE r.id=NEW.configuration_release_id;
 END IF;
 IF coalesce(jsonb_array_length(cases),0)>0 THEN
  NEW.dataset_snapshot:=NEW.dataset_snapshot||cases;
  NEW.dataset_sha256:=agentonic.content_hash(NEW.dataset_snapshot);
  grader:=v4;
 END IF;
 -- Rubric 5 contains version 4's tool rules, so it grades runs with or without tool cases.
 IF rubric5 THEN grader:=v5; END IF;
 IF grader IS NOT NULL THEN
  NEW.grader_snapshot:=grader;
  NEW.grader_sha256:=agentonic.content_hash(grader);
 END IF;
 RETURN NEW;
END $function$;

-- 2. GPT-5.4 mini writes criteria (GPT-4.1 mini stays accepted until the new
-- evaluator is installed) and sees which tools the version requests.
CREATE OR REPLACE FUNCTION agentonic.review_preparation_worker(operation text, preparation_id uuid, token uuid, payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_variable
DECLARE p agentonic.evaluation_preparations;worker agentonic.evaluation_workers;config agentonic.configuration_releases;hits jsonb;result jsonb;previous jsonb;amount bigint;budget agentonic.retrieval_provider_budgets;meter agentonic.retrieval_provider_operations;
BEGIN
 SELECT * INTO p FROM agentonic.evaluation_preparations WHERE id=preparation_id;
 IF p.id IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=p.workspace_id FOR SHARE;
 SELECT * INTO p FROM agentonic.evaluation_preparations WHERE id=preparation_id FOR UPDATE;
 SELECT * INTO worker FROM agentonic.evaluation_workers WHERE id=p.worker_id AND database_role=agentonic.application_role() AND environment='azure_staging' AND revoked_at IS NULL AND retired_at IS NULL AND verified_at>clock_timestamp()-interval '30 days' AND (verification @> '{"reviewProtocol":2}' OR verification @> '{"reviewProtocol":3}');
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
  IF payload->>'provider' IS DISTINCT FROM 'openai' OR NOT coalesce(payload->>'model' IN ('gpt-4.1-mini-2025-04-14','gpt-5.4-mini'),false) OR amount IS NULL OR amount NOT BETWEEN 1 AND 1000000 THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO budget FROM agentonic.retrieval_provider_budgets WHERE provider='openai' FOR UPDATE;
  IF budget.provider IS NULL THEN RAISE insufficient_privilege; END IF;
  IF p.committed_microusd+amount>p.budget_usd*1000000 OR budget.committed_microusd+amount>budget.cap_microusd THEN RETURN '{"ok":false,"code":"budget_exhausted"}'; END IF;
  INSERT INTO agentonic.retrieval_provider_operations(id,job_id,workspace_id,provider,model,reserved_microusd,agent_id) VALUES((payload->>'id')::uuid,p.id,p.workspace_id,'openai',payload->>'model',amount,p.agent_id);
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
  RETURN jsonb_build_object('configuration',config.content,'requestedAccess',config.requested_access_snapshot,'sources',result,'previousCriteria',coalesce(previous,'[]'::jsonb));
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
END $function$;

-- 3. Per-model decisions. A batch run is current once the whole batch has
-- finished and every level of its own model passed; other models no longer block it.
CREATE OR REPLACE FUNCTION agentonic.evaluation_batch_current(e agentonic.evaluation_runs) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT CASE WHEN e.batch_id IS NULL THEN NOT EXISTS(SELECT 1 FROM agentonic.evaluation_batches b JOIN agentonic.evaluation_preparations p ON p.id=b.preparation_id WHERE p.submission_id=e.submission_id)
 ELSE EXISTS(SELECT 1 FROM agentonic.evaluation_batches b JOIN agentonic.evaluation_preparations p ON p.id=b.preparation_id WHERE b.id=e.batch_id AND p.confirmed_revision=b.revision AND p.revision=b.revision AND agentonic.content_hash(p.criteria)=b.criteria_sha256
 AND NOT EXISTS(SELECT 1 FROM agentonic.evaluation_batches newer WHERE newer.preparation_id=p.id AND newer.created_at>b.created_at)
 AND (SELECT count(*) FROM agentonic.evaluation_runs r WHERE r.batch_id=b.id)=jsonb_array_length(b.models)
 AND NOT EXISTS(SELECT 1 FROM agentonic.evaluation_runs r WHERE r.batch_id=b.id AND r.status IN ('awaiting_consent','queued','running'))
 AND NOT EXISTS(SELECT 1 FROM agentonic.evaluation_runs r WHERE r.batch_id=b.id AND r.response_model=e.response_model AND (r.status<>'passed' OR r.evidence_sha256 IS NULL OR NOT agentonic.evaluation_authorized(r,true,true) OR NOT agentonic.evaluation_sources_current(r)))) END
$$;

CREATE OR REPLACE FUNCTION agentonic.evaluation_worker_v46(operation text, run_id uuid, token uuid, payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_variable
DECLARE e agentonic.evaluation_runs; worker agentonic.evaluation_workers; config agentonic.configuration_releases; code agentonic.code_releases;
 sources jsonb; hits jsonb; assets jsonb; test_case jsonb; checks jsonb; passed boolean; amount bigint;
 budget agentonic.retrieval_provider_budgets; meter agentonic.retrieval_provider_operations; p agentonic.evaluation_preparations; assessment jsonb; decision_id uuid; chosen agentonic.evaluation_runs;
BEGIN
 SELECT * INTO worker FROM agentonic.evaluation_workers WHERE database_role=agentonic.application_role() AND revoked_at IS NULL AND retired_at IS NULL AND verified_at>clock_timestamp()-interval '30 days';
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
    -- A batch is decided per model (§56): its evidence is the first run of the
    -- first model whose every level passed. Models that failed are left out.
    IF e.batch_id IS NOT NULL THEN
     SELECT r.* INTO chosen FROM agentonic.evaluation_runs r WHERE r.batch_id=e.batch_id AND r.status='passed'
     AND NOT EXISTS(SELECT 1 FROM agentonic.evaluation_runs other WHERE other.batch_id=r.batch_id AND other.response_model=r.response_model AND other.status<>'passed')
     ORDER BY r.created_at,r.id LIMIT 1;
     passed:=chosen.id IS NOT NULL;
     IF passed THEN
      e:=chosen;
      UPDATE agentonic.evaluation_preparations SET evaluation_id=chosen.id WHERE id=p.id;
     END IF;
    END IF;
    IF passed AND agentonic.review_auto_eligible(e,true) THEN
     INSERT INTO agentonic.submission_review_decisions(workspace_id,agent_id,submission_id,decision_number,decision,actor_policy_version,feedback,approval_expires_at,approved_access_sha256,assessment_snapshot)
     SELECT e.workspace_id,e.agent_id,e.submission_id,coalesce(max(decision_number),0)+1,'approved','readonly-review-v1','La versión superó los criterios confirmados y los controles de la plataforma.',least(clock_timestamp()+interval '24 hours',e.expires_at),e.requested_access_sha256,
     jsonb_build_object('version',3,'evaluationId',e.id,'evidenceHash',e.evidence_sha256,'configurationHash',e.configuration_sha256,'requestedAccessHash',e.requested_access_sha256,'evaluated',true,'humanReviewed',false,'policy','readonly-review-v1')
     FROM agentonic.submission_review_decisions WHERE submission_id=e.submission_id RETURNING id INTO decision_id;
     UPDATE agentonic.agent_submissions SET status='approved' WHERE id=e.submission_id;
     UPDATE agentonic.evaluation_preparations SET status='approved',finished_at=clock_timestamp() WHERE id=p.id;
    ELSE
     UPDATE agentonic.evaluation_preparations SET status=CASE WHEN NOT passed AND EXISTS(SELECT 1 FROM agentonic.evaluation_results r JOIN agentonic.evaluation_runs failed_run ON failed_run.id=r.evaluation_run_id WHERE (failed_run.id=e.id OR e.batch_id IS NOT NULL AND failed_run.batch_id=e.batch_id) AND r.outcome='failed' AND r.assessment->>'verdict'='needs_changes') THEN 'needs_changes' ELSE 'needs_attention' END,finished_at=clock_timestamp() WHERE id=p.id;
    END IF;
   END IF;
  ELSE
   UPDATE agentonic.evaluation_runs SET next_case=next_case+1,current_matches='[]' WHERE id=e.id;
  END IF;
  RETURN '{"ok":true}';
 END IF;
 RAISE insufficient_privilege;
END $function$;

-- Chats offer only the configurations of models that passed (§56). Before
-- this change every approved batch had passed in full, so earlier approvals
-- keep exactly the models they had.
CREATE OR REPLACE FUNCTION agentonic.deployment_models(d agentonic.deployments) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('model',r.response_model,'reasoning',r.reasoning_effort) ORDER BY r.created_at,r.id)
 FROM agentonic.submission_review_decisions approval
 JOIN agentonic.evaluation_runs e ON e.id=(approval.assessment_snapshot->>'evaluationId')::uuid AND e.submission_id=d.submission_id
 JOIN agentonic.evaluation_runs r ON r.batch_id=e.batch_id AND r.status='passed'
 AND NOT EXISTS(SELECT 1 FROM agentonic.evaluation_runs other WHERE other.batch_id=r.batch_id AND other.response_model=r.response_model AND other.status<>'passed')
 WHERE approval.id=d.approval_id AND approval.decision='approved'), '[{"model":"gpt-4.1-mini-2025-04-14","reasoning":null}]'::jsonb)
$$;

CREATE OR REPLACE FUNCTION agentonic.review_flow_state(target_id uuid, grant_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member(); customer boolean:=agentonic.application_role()='agentonic_customer';result jsonb;available boolean;
BEGIN
 IF agentonic.actor_user_id() IS NULL OR w IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR SHARE;
 IF NOT FOUND OR NOT ((customer AND agentonic.can_agent(target_id,'edit')) OR (agentonic.application_role()='agentonic_admin' AND agentonic.can_review(target_id,grant_id))) THEN RAISE insufficient_privilege; END IF;
 SELECT customer AND EXISTS(SELECT 1 FROM agentonic.agent_submissions s JOIN agentonic.code_releases code ON code.id=s.code_release_id
 WHERE s.agent_id=target_id AND s.workspace_id=w AND s.submitted_by_member_id=m AND s.status IN ('submitted','in_review') AND (s.review_consent->>'expiresAt')::timestamptz>clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM agentonic.evaluation_preparations p WHERE p.submission_id=s.id AND p.status IN ('queued','preparing','criteria_ready','evaluating'))
 AND NOT EXISTS(SELECT 1 FROM agentonic.evaluation_runs e WHERE e.submission_id=s.id AND e.status IN ('awaiting_consent','queued','running'))
 AND EXISTS(SELECT 1 FROM agentonic.evaluation_workers worker WHERE worker.environment='azure_staging' AND agentonic.evaluator_runs(worker.id,code.artifact_sha256) AND worker.revoked_at IS NULL AND worker.retired_at IS NULL AND worker.verified_at>clock_timestamp()-interval '30 days' AND (worker.verification @> '{"reviewProtocol":2}' OR worker.verification @> '{"reviewProtocol":3}'))) INTO available;
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
 'summary',CASE WHEN NOT live THEN 'El acceso a esta revisión ya no está vigente. El consumo y el historial se conservan.' WHEN display_status='expired' THEN 'La aprobación de esta versión ya no está vigente. Se necesita evidencia vigente antes de activar la versión.' WHEN display_status='approved' THEN 'Esta versión superó los criterios confirmados y los controles de la plataforma. Chats ofrecerá solo los modelos que superaron todas las situaciones. La aprobación no activa un despliegue.' WHEN p.status='needs_changes' THEN 'La evaluación encontró ajustes concretos. Revisa las observaciones y prepara una nueva versión.' WHEN p.status='needs_attention' THEN CASE WHEN e.status='passed' THEN 'La versión superó la evaluación con al menos un modelo. Por las herramientas o el alcance del agente, el equipo debe revisarla antes de aprobarla.' WHEN p.risk='sensitive' THEN 'Por el alcance de este agente, el equipo debe revisar el resultado antes de aprobar.' WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(p.criteria) c WHERE c->'excluded'='true') THEN 'Hay situaciones excluidas por el cliente. El equipo revisará sus motivos antes de decidir.' ELSE 'La evaluación requiere aclarar el alcance o la evidencia. El equipo revisará las observaciones; no tienes que volver a revisar cada respuesta.' END WHEN p.status='error' THEN 'La revisión se interrumpió. Se conserva el consumo realizado; no se repetirá automáticamente.' WHEN p.status='criteria_ready' THEN 'La IA propone situaciones basadas en tus instrucciones y una muestra del conocimiento autorizado. Ajusta lo que esperas del agente antes de evaluar.' WHEN p.status='evaluating' THEN 'Estamos probando la versión y comparando sus respuestas con tus criterios y los controles de la plataforma.' ELSE 'La IA preparará una propuesta de criterios dentro del límite autorizado.' END,
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
END $function$;

-- 4. GPT-4.1 mini is no longer offered for new evaluations or test chats.
CREATE FUNCTION agentonic.refuse_retired_evaluation_models() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.models @> '[{"model":"gpt-4.1-mini-2025-04-14"}]' THEN RAISE insufficient_privilege; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION agentonic.refuse_retired_preview_models() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.response_model='gpt-4.1-mini-2025-04-14' THEN RAISE insufficient_privilege; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER evaluation_batches_retired_models BEFORE INSERT ON agentonic.evaluation_batches FOR EACH ROW EXECUTE FUNCTION agentonic.refuse_retired_evaluation_models();
CREATE TRIGGER background_jobs_retired_models BEFORE INSERT ON agentonic.background_jobs FOR EACH ROW WHEN (NEW.preview_id IS NOT NULL) EXECUTE FUNCTION agentonic.refuse_retired_preview_models();
REVOKE ALL ON FUNCTION agentonic.refuse_retired_evaluation_models(),agentonic.refuse_retired_preview_models()
 FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure;
