BEGIN;
-- Side-by-side runtimes. Agent behavior now ships in the frozen runtime
-- artifact (broker protocol 2), so a host or evaluator must serve several
-- artifacts at once: a new release installs next to the old one, and running
-- deployments and pending evaluations keep the artifact they pinned. Broker
-- and evaluator program bytes stay single per host and registration.
CREATE TABLE agentonic.runtime_host_artifacts (
 host_id uuid NOT NULL REFERENCES agentonic.runtime_hosts(id),
 runtime_sha256 text NOT NULL CHECK(runtime_sha256 ~ '^[a-f0-9]{64}$'),
 installed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 retired_at timestamptz,
 PRIMARY KEY(host_id,runtime_sha256),
 CHECK(retired_at IS NULL OR retired_at>=installed_at)
);
INSERT INTO agentonic.runtime_host_artifacts(host_id,runtime_sha256,installed_at)
 SELECT id,runtime_sha256,least(verified_at,clock_timestamp()) FROM agentonic.runtime_hosts;
ALTER TABLE agentonic.runtime_hosts DROP COLUMN runtime_sha256;
-- Each evaluator registration lists the artifacts it verified. Rows are
-- append-only; a renewed registration carries its own list.
CREATE TABLE agentonic.evaluation_worker_runtimes (
 worker_id uuid NOT NULL REFERENCES agentonic.evaluation_workers(id),
 runtime_sha256 text NOT NULL CHECK(runtime_sha256 ~ '^[a-f0-9]{64}$'),
 verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(worker_id,runtime_sha256)
);
INSERT INTO agentonic.evaluation_worker_runtimes(worker_id,runtime_sha256,verified_at)
 SELECT id,runtime_sha256,verified_at FROM agentonic.evaluation_workers;
ALTER TABLE agentonic.evaluation_workers DROP COLUMN runtime_sha256;
CREATE FUNCTION agentonic.runtime_artifact_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_TABLE_NAME='evaluation_worker_runtimes' OR TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable runtime registration'; END IF;
 IF (to_jsonb(NEW)-'retired_at') IS DISTINCT FROM (to_jsonb(OLD)-'retired_at') OR OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL THEN
  RAISE EXCEPTION 'Only retirement may change an installed runtime';
 END IF;
 -- Retirement removes execution authority; never pull an artifact from a live deployment.
 IF EXISTS(SELECT 1 FROM agentonic.deployments d JOIN agentonic.code_releases c ON c.id=d.code_release_id
  WHERE d.host_id=OLD.host_id AND c.artifact_sha256=OLD.runtime_sha256 AND d.status IN ('queued','preparing','running')) THEN
  RAISE EXCEPTION 'Runtime in use';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER runtime_host_artifact_immutable BEFORE UPDATE OR DELETE ON agentonic.runtime_host_artifacts FOR EACH ROW EXECUTE FUNCTION agentonic.runtime_artifact_immutable();
CREATE TRIGGER evaluation_worker_runtime_immutable BEFORE UPDATE OR DELETE ON agentonic.evaluation_worker_runtimes FOR EACH ROW EXECUTE FUNCTION agentonic.runtime_artifact_immutable();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['runtime_host_artifacts','evaluation_worker_runtimes'] LOOP
 EXECUTE format('ALTER TABLE agentonic.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON agentonic.%I FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure,agentonic_runtime_local,agentonic_runtime_azure,agentonic_deployer_local,agentonic_deployer_azure',t);
 END LOOP;
END $$;
CREATE FUNCTION agentonic.host_runs(host uuid,artifact text) RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM agentonic.runtime_host_artifacts a WHERE a.host_id=host AND a.runtime_sha256=artifact AND a.retired_at IS NULL)
$$;
CREATE FUNCTION agentonic.evaluator_runs(worker uuid,artifact text) RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM agentonic.evaluation_worker_runtimes r WHERE r.worker_id=worker AND r.runtime_sha256=artifact)
$$;
REVOKE ALL ON FUNCTION agentonic.host_runs(uuid,text),agentonic.evaluator_runs(uuid,text),agentonic.runtime_artifact_immutable() FROM PUBLIC,anon,authenticated,service_role;
-- The functions below are unchanged except that a single runtime hash
-- comparison becomes a lookup in the lists above.
CREATE OR REPLACE FUNCTION agentonic.evaluation_approvable(e agentonic.evaluation_runs, allow_approved boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT agentonic.evaluation_batch_current(e) AND e.status='passed' AND e.environment='azure_staging' AND e.finished_at>clock_timestamp()-interval '24 hours'
 AND agentonic.evaluation_authorized(e,true,allow_approved) AND agentonic.evaluation_sources_current(e)
 AND e.evidence_sha256 IS NOT NULL AND EXISTS(SELECT 1 FROM agentonic.evaluation_workers worker JOIN agentonic.code_releases c ON c.id=e.code_release_id
 WHERE worker.id=e.worker_id AND worker.environment='azure_staging' AND worker.revoked_at IS NULL AND worker.verified_at>clock_timestamp()-interval '7 days'
 AND agentonic.evaluator_runs(worker.id,c.artifact_sha256) AND worker.verification @> '{"isolation":true,"recovery":true,"artifactIntegrity":true}')
 AND (SELECT count(*) FROM agentonic.evaluation_results result WHERE result.evaluation_run_id=e.id AND result.outcome='passed')=jsonb_array_length(e.dataset_snapshot)
$$;
CREATE OR REPLACE FUNCTION agentonic.evaluation_claim(worker_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE worker agentonic.evaluation_workers; candidate agentonic.evaluation_runs; token uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO worker FROM agentonic.evaluation_workers WHERE database_role=agentonic.application_role() AND revoked_at IS NULL AND worker_sha256=worker_hash AND verified_at>clock_timestamp()-interval '7 days';
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
    IF NOT EXISTS(SELECT 1 FROM agentonic.evaluation_workers worker JOIN agentonic.code_releases code ON code.id=p.code_release_id AND agentonic.evaluator_runs(worker.id,code.artifact_sha256) WHERE worker.environment='azure_staging' AND worker.revoked_at IS NULL AND worker.verified_at>clock_timestamp()-interval '7 days' AND worker.verification @> '{"reviewProtocol":3}') THEN RETURN '{"ok":false,"code":"worker_unavailable"}'; END IF;
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
CREATE OR REPLACE FUNCTION agentonic.review_preparation_claim(worker_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE worker agentonic.evaluation_workers;p agentonic.evaluation_preparations;t uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO worker FROM agentonic.evaluation_workers WHERE database_role=agentonic.application_role() AND environment='azure_staging' AND worker_sha256=worker_hash AND revoked_at IS NULL AND verified_at>clock_timestamp()-interval '7 days' AND (verification @> '{"reviewProtocol":2}' OR verification @> '{"reviewProtocol":3}');
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
CREATE OR REPLACE FUNCTION agentonic.review_preparation_worker(operation text,preparation_id uuid,token uuid,payload jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE p agentonic.evaluation_preparations;worker agentonic.evaluation_workers;config agentonic.configuration_releases;hits jsonb;result jsonb;previous jsonb;amount bigint;budget agentonic.retrieval_provider_budgets;meter agentonic.retrieval_provider_operations;
BEGIN
 SELECT * INTO p FROM agentonic.evaluation_preparations WHERE id=preparation_id;
 IF p.id IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=p.workspace_id FOR SHARE;
 SELECT * INTO p FROM agentonic.evaluation_preparations WHERE id=preparation_id FOR UPDATE;
 SELECT * INTO worker FROM agentonic.evaluation_workers WHERE id=p.worker_id AND database_role=agentonic.application_role() AND environment='azure_staging' AND revoked_at IS NULL AND verified_at>clock_timestamp()-interval '7 days' AND (verification @> '{"reviewProtocol":2}' OR verification @> '{"reviewProtocol":3}');
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
 AND EXISTS(SELECT 1 FROM agentonic.evaluation_workers worker WHERE worker.environment='azure_staging' AND agentonic.evaluator_runs(worker.id,code.artifact_sha256) AND worker.revoked_at IS NULL AND worker.verified_at>clock_timestamp()-interval '7 days' AND (worker.verification @> '{"reviewProtocol":2}' OR worker.verification @> '{"reviewProtocol":3}'))) INTO available;
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
CREATE OR REPLACE FUNCTION agentonic.deployment_authorized_v30(d agentonic.deployments) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r agentonic.configuration_releases;decision agentonic.submission_review_decisions;
BEGIN
 IF d.id IS NULL OR d.revoked_at IS NOT NULL OR d.authorized_until<=clock_timestamp() OR NOT agentonic.member_can_author(d.authorized_by_member_id,d.agent_id) THEN RETURN false; END IF;
 SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id AND workspace_id=d.workspace_id;
 SELECT * INTO decision FROM agentonic.submission_review_decisions WHERE id=d.approval_id;
 RETURN coalesce(r.retired_at IS NULL AND r.id IS NOT NULL AND agentonic.gmail_deployment_scope(r,d.authorized_by_member_id)
 AND decision.decision='approved' AND decision.approved_access_sha256=r.requested_access_sha256
 AND NOT EXISTS(SELECT 1 FROM agentonic.submission_review_decisions later WHERE later.submission_id=d.submission_id AND later.decision_number>decision.decision_number)
 AND EXISTS(SELECT 1 FROM agentonic.agent_submissions s WHERE s.id=d.submission_id AND s.status='approved')
 AND EXISTS(SELECT 1 FROM agentonic.evaluation_runs e WHERE e.id=(decision.assessment_snapshot->>'evaluationId')::uuid AND e.consent_revoked_at IS NULL)
 AND (decision.actor_staff_id IS NULL OR EXISTS(SELECT 1 FROM agentonic.platform_staff st JOIN agentonic.users u ON u.id=st.user_id WHERE st.id=decision.actor_staff_id AND st.disabled_at IS NULL AND st.role IN ('administrator','operator') AND u.deleted_at IS NULL))
 AND EXISTS(SELECT 1 FROM agentonic.code_releases code JOIN agentonic.workspace_code_release_grants g ON g.code_release_id=code.id AND g.workspace_id=d.workspace_id
  JOIN agentonic.code_repositories repo ON repo.id=code.code_repository_id JOIN agentonic.runtime_hosts h ON h.id=d.host_id
  WHERE code.id=d.code_release_id AND code.revoked_at IS NULL AND code.retired_at IS NULL AND g.revoked_at IS NULL
  AND repo.provisioning_status='ready' AND (repo.visibility='platform' OR repo.workspace_id=d.workspace_id)
  AND code.execution_manifest->>'previewContract'='1' AND h.environment=d.environment AND h.revoked_at IS NULL AND h.verified_at>clock_timestamp()-interval '7 days' AND agentonic.host_runs(h.id,code.artifact_sha256))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.requested_access_snapshot->'collectionIds') c WHERE NOT agentonic.member_can_collection(d.authorized_by_member_id,c::uuid,'read'))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.requested_access_snapshot->'collections') col CROSS JOIN LATERAL jsonb_array_elements(col->'sources') src
  WHERE NOT EXISTS(SELECT 1 FROM agentonic.knowledge_sources k WHERE k.id=(src->>'id')::uuid AND k.workspace_id=d.workspace_id AND k.collection_id=(col->>'id')::uuid
   AND k.definition_sha256=src->>'hash' AND k.definition_revision=(src->>'revision')::bigint AND k.environment='staging' AND k.kind='upload' AND k.access_mode='collection'
   AND k.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb AND agentonic.member_can_collection(k.authorized_by_member_id,k.collection_id,'curate')))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.evidence_sources) hit WHERE NOT EXISTS(
  SELECT 1 FROM agentonic.document_chunks c JOIN agentonic.document_versions v ON v.id=c.document_version_id JOIN agentonic.documents doc ON doc.id=v.document_id
  WHERE c.workspace_id=d.workspace_id AND c.id=(hit->>'id')::uuid AND c.content_sha256=hit->>'hash' AND v.status='ready' AND doc.active_version_id=v.id AND doc.deleted_at IS NULL)),false);
END $$;
COMMIT;
