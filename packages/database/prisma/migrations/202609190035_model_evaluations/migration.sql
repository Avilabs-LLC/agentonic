BEGIN;
-- Each authorization creates an immutable batch; each model/effort gets its own
-- immutable run and evidence. Criteria confirmation alone never invokes a model.
CREATE FUNCTION agentonic.valid_model_configuration(model text,effort text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT coalesce((model='gpt-4.1-mini-2025-04-14' AND effort IS NULL)
 OR (model IN ('gpt-5.4-mini','gpt-5.4') AND effort IN ('none','low','medium','high','xhigh'))
 OR (model='gpt-6-astra' AND effort IN ('low','medium','high','xhigh','max')),false)
$$;
ALTER TABLE agentonic.evaluation_preparations ADD COLUMN confirmed_revision integer;
CREATE TABLE agentonic.evaluation_batches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, preparation_id uuid NOT NULL,
 request_id uuid NOT NULL, revision integer NOT NULL, criteria_sha256 text NOT NULL,
 models jsonb NOT NULL CHECK(jsonb_typeof(models)='array' AND jsonb_array_length(models) BETWEEN 1 AND 16),
 budget_usd numeric(20,8) NOT NULL CHECK(budget_usd BETWEEN 0.05 AND 50),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,id), UNIQUE(preparation_id,request_id),
 FOREIGN KEY(workspace_id,preparation_id) REFERENCES agentonic.evaluation_preparations(workspace_id,id)
);
ALTER TABLE agentonic.evaluation_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.evaluation_batches FROM PUBLIC,anon,authenticated,service_role,agentonic_customer,agentonic_admin,agentonic_worker,agentonic_eval_local,agentonic_eval_azure;
ALTER TABLE agentonic.evaluation_runs ADD COLUMN batch_id uuid,
 ADD COLUMN response_model text NOT NULL DEFAULT 'gpt-4.1-mini-2025-04-14', ADD COLUMN reasoning_effort text,
 ADD FOREIGN KEY(workspace_id,batch_id) REFERENCES agentonic.evaluation_batches(workspace_id,id),
 ADD CHECK(agentonic.valid_model_configuration(response_model,reasoning_effort)),
 ADD CHECK(batch_id IS NULL OR preparation_id IS NOT NULL);
DROP INDEX agentonic.evaluation_single_active;
CREATE UNIQUE INDEX evaluation_single_active ON agentonic.evaluation_runs(submission_id) WHERE batch_id IS NULL AND status IN ('awaiting_consent','queued','running');
CREATE UNIQUE INDEX evaluation_batch_model ON agentonic.evaluation_runs(batch_id,response_model,coalesce(reasoning_effort,'')) WHERE batch_id IS NOT NULL;
ALTER TABLE agentonic.evaluation_runs DROP CONSTRAINT evaluation_runs_budget_usd_check;
ALTER TABLE agentonic.evaluation_runs ADD CHECK(budget_usd BETWEEN 0.01 AND 50);

DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='agentonic.evaluation_runs'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%grader_snapshot%' LOOP
 EXECUTE format('ALTER TABLE agentonic.evaluation_runs DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE agentonic.evaluation_runs ADD CHECK(grader_sha256=agentonic.content_hash(grader_snapshot) AND ((preparation_id IS NULL AND grader_snapshot='{"version":"phrases-citations-v1","threshold":1}') OR (preparation_id IS NOT NULL AND grader_snapshot IN ('{"version":"grounded-review-v2","model":"gpt-4.1-mini-2025-04-14","policy":"readonly-review-v1"}'::jsonb,'{"version":"grounded-review-v3","model":"gpt-4.1-mini-2025-04-14","policy":"readonly-review-v1"}'::jsonb))));

CREATE FUNCTION agentonic.evaluation_batch_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Immutable evaluation authorization'; END $$;
CREATE TRIGGER evaluation_batch_immutable BEFORE UPDATE OR DELETE ON agentonic.evaluation_batches FOR EACH ROW EXECUTE FUNCTION agentonic.evaluation_batch_immutable();


CREATE OR REPLACE FUNCTION agentonic.review_preparation_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable review history'; END IF;
 IF TG_TABLE_NAME='evaluation_criteria_revisions' THEN
  IF OLD.scrubbed_at IS NULL AND NEW.scrubbed_at IS NOT NULL AND NEW.criteria='[]'
  AND to_jsonb(NEW)-ARRAY['criteria','scrubbed_at'] IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['criteria','scrubbed_at']
  AND EXISTS(SELECT 1 FROM agentonic.evaluation_preparations p WHERE p.id=OLD.preparation_id AND p.scrubbed_at IS NOT NULL) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Immutable criteria revision';
 END IF;
 IF OLD.scrubbed_at IS NULL AND NEW.scrubbed_at IS NOT NULL AND NEW.criteria='[]' AND NEW.generated_criteria='[]' AND NEW.source_snapshot='[]'
 AND (OLD.expires_at<=clock_timestamp() OR OLD.consent_revoked_at IS NOT NULL)
 AND to_jsonb(NEW)-ARRAY['criteria','generated_criteria','source_snapshot','scrubbed_at'] IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['criteria','generated_criteria','source_snapshot','scrubbed_at'] THEN RETURN NEW; END IF;
 IF to_jsonb(NEW)-ARRAY['status','committed_microusd','generated_criteria','criteria','revision','source_snapshot','risk','evaluation_id','worker_id','lease_token','lease_until','confirmed_at','consent_revoked_at','started_at','finished_at','confirmed_revision']
 IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','committed_microusd','generated_criteria','criteria','revision','source_snapshot','risk','evaluation_id','worker_id','lease_token','lease_until','confirmed_at','consent_revoked_at','started_at','finished_at','confirmed_revision'] THEN RAISE EXCEPTION 'Immutable review scope'; END IF;
 IF OLD.status='cancelled' AND NEW.status<>'cancelled' THEN RAISE EXCEPTION 'Cancelled review'; END IF;
 IF NEW.criteria IS DISTINCT FROM OLD.criteria AND OLD.generated_criteria<>'[]' THEN
  IF NEW.revision<>OLD.revision+1 OR NEW.confirmed_revision IS NOT NULL
   OR EXISTS(SELECT 1 FROM agentonic.evaluation_runs e WHERE e.preparation_id=OLD.id AND e.status IN ('queued','running','awaiting_consent')) THEN RAISE EXCEPTION 'Invalid criteria revision'; END IF;
 END IF;
 IF NEW.confirmed_revision IS NOT NULL AND NEW.confirmed_revision<>NEW.revision THEN RAISE EXCEPTION 'Invalid criteria confirmation'; END IF;
 IF OLD.generated_criteria<>'[]' AND (NEW.generated_criteria IS DISTINCT FROM OLD.generated_criteria OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot OR NEW.risk IS DISTINCT FROM OLD.risk) THEN RAISE EXCEPTION 'Immutable preparation evidence'; END IF;
 IF OLD.consent_revoked_at IS NOT NULL AND NEW.consent_revoked_at IS DISTINCT FROM OLD.consent_revoked_at THEN RAISE EXCEPTION 'Irreversible cancellation'; END IF;
 IF OLD.worker_id IS NOT NULL AND NEW.worker_id IS DISTINCT FROM OLD.worker_id THEN RAISE EXCEPTION 'Immutable preparation worker'; END IF;
 RETURN NEW;
END $$;

UPDATE agentonic.evaluation_preparations SET confirmed_revision=revision WHERE confirmed_at IS NOT NULL;

CREATE OR REPLACE FUNCTION agentonic.preparation_sources_current(p agentonic.evaluation_preparations) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.source_snapshot) hit WHERE NOT EXISTS(
 SELECT 1 FROM agentonic.document_chunks c JOIN agentonic.document_versions v ON v.id=c.document_version_id JOIN agentonic.documents d ON d.id=v.document_id
 WHERE c.workspace_id=p.workspace_id AND c.id=(hit->>'id')::uuid AND c.content_sha256=hit->>'hash' AND v.status='ready' AND d.active_version_id=v.id AND d.deleted_at IS NULL))
$$;

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
    IF NOT EXISTS(SELECT 1 FROM agentonic.evaluation_workers worker JOIN agentonic.code_releases code ON code.id=p.code_release_id AND code.artifact_sha256=worker.runtime_sha256 WHERE worker.environment='azure_staging' AND worker.revoked_at IS NULL AND worker.verified_at>clock_timestamp()-interval '7 days' AND worker.verification @> '{"reviewProtocol":3}') THEN RETURN '{"ok":false,"code":"worker_unavailable"}'; END IF;
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

CREATE FUNCTION agentonic.evaluation_batch_current(e agentonic.evaluation_runs) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT CASE WHEN e.batch_id IS NULL THEN NOT EXISTS(SELECT 1 FROM agentonic.evaluation_batches b JOIN agentonic.evaluation_preparations p ON p.id=b.preparation_id WHERE p.submission_id=e.submission_id)
 ELSE EXISTS(SELECT 1 FROM agentonic.evaluation_batches b JOIN agentonic.evaluation_preparations p ON p.id=b.preparation_id WHERE b.id=e.batch_id AND p.confirmed_revision=b.revision AND p.revision=b.revision AND agentonic.content_hash(p.criteria)=b.criteria_sha256
 AND NOT EXISTS(SELECT 1 FROM agentonic.evaluation_batches newer WHERE newer.preparation_id=p.id AND newer.created_at>b.created_at)
 AND (SELECT count(*) FROM agentonic.evaluation_runs r WHERE r.batch_id=b.id)=jsonb_array_length(b.models)
 AND NOT EXISTS(SELECT 1 FROM agentonic.evaluation_runs r WHERE r.batch_id=b.id AND (r.status<>'passed' OR r.evidence_sha256 IS NULL OR NOT agentonic.evaluation_authorized(r,true,true) OR NOT agentonic.evaluation_sources_current(r)))) END
$$;

CREATE OR REPLACE FUNCTION agentonic.evaluation_approvable(e agentonic.evaluation_runs, allow_approved boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT agentonic.evaluation_batch_current(e) AND e.status='passed' AND e.environment='azure_staging' AND e.finished_at>clock_timestamp()-interval '24 hours'
 AND agentonic.evaluation_authorized(e,true,allow_approved) AND agentonic.evaluation_sources_current(e)
 AND e.evidence_sha256 IS NOT NULL AND EXISTS(SELECT 1 FROM agentonic.evaluation_workers worker JOIN agentonic.code_releases c ON c.id=e.code_release_id
 WHERE worker.id=e.worker_id AND worker.environment='azure_staging' AND worker.revoked_at IS NULL AND worker.verified_at>clock_timestamp()-interval '7 days'
 AND worker.runtime_sha256=c.artifact_sha256 AND worker.verification @> '{"isolation":true,"recovery":true,"artifactIntegrity":true}')
 AND (SELECT count(*) FROM agentonic.evaluation_results result WHERE result.evaluation_run_id=e.id AND result.outcome='passed')=jsonb_array_length(e.dataset_snapshot)
$$;

CREATE OR REPLACE FUNCTION agentonic.review_auto_eligible(e agentonic.evaluation_runs,allow_approved boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT e.preparation_id IS NOT NULL AND agentonic.evaluation_approvable(e,allow_approved)
 AND EXISTS(SELECT 1 FROM agentonic.evaluation_preparations p JOIN agentonic.configuration_releases r ON r.id=p.configuration_release_id
 JOIN agentonic.code_releases code ON code.id=p.code_release_id JOIN agentonic.code_repositories repo ON repo.id=code.code_repository_id
 WHERE p.id=e.preparation_id AND p.risk='routine' AND r.requested_access_snapshot->'tools'='[]' AND repo.visibility='platform'
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.criteria) c WHERE c->'excluded'='true')
 AND (e.batch_id IS NOT NULL OR p.committed_microusd<=p.budget_usd*1000000))
 AND NOT EXISTS(SELECT 1 FROM agentonic.evaluation_results r WHERE (r.evaluation_run_id=e.id OR e.batch_id IS NOT NULL AND EXISTS(SELECT 1 FROM agentonic.evaluation_runs sibling WHERE sibling.id=r.evaluation_run_id AND sibling.batch_id=e.batch_id)) AND (r.assessment IS NULL OR r.assessment->'routine' IS DISTINCT FROM 'true'::jsonb))
 AND EXISTS(SELECT 1 FROM agentonic.evaluation_workers worker WHERE worker.id=e.worker_id AND (worker.verification @> '{"reviewProtocol":2}' OR worker.verification @> '{"reviewProtocol":3}'))
$$;

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
 IF code.artifact_sha256<>worker.runtime_sha256 THEN RAISE insufficient_privilege; END IF;
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
 WHERE e.environment=worker.environment AND e.status='queued' AND c.artifact_sha256=worker.runtime_sha256 AND (e.preparation_id IS NULL OR (e.batch_id IS NULL AND worker.verification @> '{"reviewProtocol":2}') OR worker.verification @> '{"reviewProtocol":3}') AND (e.batch_id IS NULL OR worker.verification @> '{"reviewProtocol":3}') ORDER BY e.created_at LIMIT 20 LOOP
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
 SELECT * INTO worker FROM agentonic.evaluation_workers WHERE database_role=agentonic.application_role() AND environment='azure_staging' AND worker_sha256=worker_hash AND revoked_at IS NULL AND verified_at>clock_timestamp()-interval '7 days' AND (verification @> '{"reviewProtocol":2}' OR verification @> '{"reviewProtocol":3}');
 IF worker.id IS NULL THEN RETURN NULL; END IF;
 FOR p IN SELECT * FROM agentonic.evaluation_preparations WHERE status IN ('queued','preparing') ORDER BY created_at LIMIT 50 LOOP
  PERFORM 1 FROM agentonic.workspaces WHERE id=p.workspace_id FOR SHARE;
  SELECT * INTO p FROM agentonic.evaluation_preparations WHERE id=p.id FOR UPDATE SKIP LOCKED;
  IF p.id IS NULL THEN CONTINUE; END IF;
  IF NOT agentonic.preparation_authorized(p) OR (p.status='preparing' AND (p.lease_until<=clock_timestamp() OR p.started_at<clock_timestamp()-interval '5 minutes')) THEN
   UPDATE agentonic.evaluation_preparations SET status='error',lease_token=NULL,lease_until=NULL,finished_at=clock_timestamp() WHERE id=p.id;
  ELSIF p.status='queued' AND EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=p.code_release_id AND artifact_sha256=worker.runtime_sha256) THEN
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
 IF NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=p.code_release_id AND artifact_sha256=worker.runtime_sha256) THEN RAISE insufficient_privilege; END IF;
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

REVOKE ALL ON FUNCTION agentonic.valid_model_configuration(text,text),agentonic.evaluation_batch_immutable(),agentonic.evaluation_batch_current(agentonic.evaluation_runs) FROM PUBLIC,anon,authenticated,service_role,agentonic_customer,agentonic_admin,agentonic_worker,agentonic_eval_local,agentonic_eval_azure;
CREATE FUNCTION agentonic.evaluation_model_state(e agentonic.evaluation_runs) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('id',e.id,'model',e.response_model,'reasoning',e.reasoning_effort,'status',e.status,
 'total',jsonb_array_length(e.dataset_snapshot),'completed',e.next_case,
 'passed',(SELECT count(*) FROM agentonic.evaluation_results WHERE evaluation_run_id=e.id AND outcome='passed'),
 'committedMicrousd',e.committed_microusd,'grader',e.grader_snapshot->>'model','errorCode',e.error_code,
 'results',CASE WHEN agentonic.evaluation_authorized(e,true,true) AND agentonic.evaluation_sources_current(e) THEN coalesce((SELECT jsonb_agg(jsonb_build_object('key',r.case_key,'kind',test->>'kind','question',test->>'question','expectedAnswer',test->>'expectedAnswer','outcome',r.outcome,'answer',r.answer,'explanation',r.assessment->>'explanation','suggestion',r.assessment->>'suggestion','sources',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'text',c.content)) FROM agentonic.document_chunks c WHERE c.workspace_id=e.workspace_id AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.evidence_sources) src WHERE src->>'id'=c.id::text AND src->>'hash'=c.content_sha256)),'[]'::jsonb)) ORDER BY r.created_at,r.case_key) FROM agentonic.evaluation_results r CROSS JOIN LATERAL jsonb_array_elements(e.dataset_snapshot) test WHERE r.evaluation_run_id=e.id AND test->>'key'=r.case_key),'[]'::jsonb) ELSE '[]'::jsonb END)
$$;
CREATE FUNCTION agentonic.evaluation_batch_state(p agentonic.evaluation_preparations) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(item ORDER BY created DESC),'[]') FROM (
  SELECT b.created_at created,jsonb_build_object('id',b.id,'revision',b.revision,'createdAt',b.created_at,'budgetUsd',b.budget_usd,
   'models',(SELECT jsonb_agg(agentonic.evaluation_model_state(e) ORDER BY e.created_at,e.id) FROM agentonic.evaluation_runs e WHERE e.batch_id=b.id)) item
  FROM agentonic.evaluation_batches b WHERE b.preparation_id=p.id
  UNION ALL
  SELECT e.created_at,jsonb_build_object('id',e.id,'revision',coalesce((SELECT max(r.revision) FROM agentonic.evaluation_criteria_revisions r WHERE r.preparation_id=p.id AND r.created_at<=e.authorized_at),0),'createdAt',e.created_at,'budgetUsd',e.budget_usd,
   'models',jsonb_build_array(agentonic.evaluation_model_state(e))) FROM agentonic.evaluation_runs e WHERE e.preparation_id=p.id AND e.batch_id IS NULL
 ) history
$$;

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
 AND EXISTS(SELECT 1 FROM agentonic.evaluation_workers worker WHERE worker.environment='azure_staging' AND worker.runtime_sha256=code.artifact_sha256 AND worker.revoked_at IS NULL AND worker.verified_at>clock_timestamp()-interval '7 days' AND (worker.verification @> '{"reviewProtocol":2}' OR worker.verification @> '{"reviewProtocol":3}'))) INTO available;
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
REVOKE ALL ON FUNCTION agentonic.evaluation_model_state(agentonic.evaluation_runs),agentonic.evaluation_batch_state(agentonic.evaluation_preparations) FROM PUBLIC,anon,authenticated,service_role,agentonic_customer,agentonic_admin,agentonic_worker,agentonic_eval_local,agentonic_eval_azure;CREATE OR REPLACE FUNCTION agentonic.evaluation_authorized(e agentonic.evaluation_runs,require_consent boolean DEFAULT true,allow_approved boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE p agentonic.evaluation_preparations;
BEGIN
 IF e.preparation_id IS NULL THEN RETURN agentonic.evaluation_authorized_legacy(e,require_consent,allow_approved); END IF;
 SELECT * INTO p FROM agentonic.evaluation_preparations WHERE id=e.preparation_id AND workspace_id=e.workspace_id;
 RETURN p.id IS NOT NULL AND agentonic.preparation_authorized(p,true) AND agentonic.preparation_sources_current(p)
 AND e.expires_at>clock_timestamp() AND e.consent_revoked_at IS NULL AND e.configuration_release_id=p.configuration_release_id
 AND e.code_release_id=p.code_release_id AND e.submission_id=p.submission_id AND e.configuration_sha256=p.configuration_sha256 AND e.requested_access_sha256=p.requested_access_sha256
 AND e.authorized_by_member_id=p.authorized_by_member_id AND e.authorized_at IS NOT NULL
 AND (e.batch_id IS NULL OR EXISTS(SELECT 1 FROM agentonic.evaluation_batches b WHERE b.id=e.batch_id AND b.workspace_id=e.workspace_id AND b.preparation_id=p.id AND b.created_at=e.authorized_at
 AND b.models @> jsonb_build_array(jsonb_build_object('model',e.response_model,'reasoning',e.reasoning_effort))));
END $$;
CREATE OR REPLACE FUNCTION agentonic.approved_review_receipt_before_deployments(target_id uuid, trace_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=agentonic.workspace_id(); staff uuid:=agentonic.current_staff();
 s agentonic.agent_submissions; r agentonic.configuration_releases; d agentonic.submission_review_decisions;
 e agentonic.evaluation_runs; p agentonic.evaluation_preparations; g agentonic.support_access_grants;
 receipt_scope jsonb; content_live boolean; report_live boolean; result jsonb;
BEGIN
 IF agentonic.application_role()<>'agentonic_admin' OR staff IS NULL OR w IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 SELECT * INTO s FROM agentonic.agent_submissions WHERE id=target_id AND workspace_id=w AND status='approved' FOR UPDATE;
 IF s.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO r FROM agentonic.configuration_releases WHERE id=s.configuration_release_id AND workspace_id=w AND agent_id=s.agent_id;
 SELECT * INTO d FROM agentonic.submission_review_decisions WHERE submission_id=s.id AND workspace_id=w ORDER BY decision_number DESC LIMIT 1;
 IF r.id IS NULL OR d.decision IS DISTINCT FROM 'approved' THEN RETURN NULL; END IF;
 SELECT * INTO e FROM agentonic.evaluation_runs WHERE id=(d.assessment_snapshot->>'evaluationId')::uuid AND submission_id=s.id AND workspace_id=w
  AND configuration_release_id=r.id AND code_release_id=s.code_release_id AND configuration_sha256=r.content_sha256
  AND requested_access_sha256=d.approved_access_sha256 AND evidence_sha256=d.assessment_snapshot->>'evidenceHash';
 IF e.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO p FROM agentonic.evaluation_preparations WHERE id=e.preparation_id AND workspace_id=w;
 receipt_scope:=jsonb_build_object('version',3,'submissionId',s.id::text,'operations',jsonb_build_array('receipt'));
 content_live:=coalesce(s.review_consent->'configuration'='true'::jsonb AND s.review_consent->'knowledgeMetadata'='true'::jsonb
  AND (s.review_consent->>'expiresAt')::timestamptz>clock_timestamp() AND r.retired_at IS NULL
  AND agentonic.member_can_author(s.submitted_by_member_id,s.agent_id)
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.requested_access_snapshot->'collectionIds') c(id)
    WHERE NOT agentonic.member_can_collection(s.submitted_by_member_id,c.id::uuid,'read'))
  AND NOT EXISTS(SELECT 1 FROM agentonic.support_access_grants old WHERE old.workspace_id=w AND old.staff_id=staff
    AND old.scope->>'submissionId'=s.id::text AND old.revoked_at IS NOT NULL),false);
 IF content_live THEN
  SELECT * INTO g FROM agentonic.support_access_grants gr WHERE gr.workspace_id=w AND gr.staff_id=staff AND gr.scope=receipt_scope
   AND approved_by_member_id=s.submitted_by_member_id AND revoked_at IS NULL AND expires_at>clock_timestamp() LIMIT 1;
  IF g.id IS NULL THEN
   INSERT INTO agentonic.support_access_grants(workspace_id,staff_id,approved_by_member_id,reason,scope,expires_at)
    VALUES(w,staff,s.submitted_by_member_id,'Consulta del comprobante de una versión aprobada',receipt_scope,(s.review_consent->>'expiresAt')::timestamptz) RETURNING * INTO g;
  END IF;
 END IF;
 report_live:=content_live AND e.scrubbed_at IS NULL AND agentonic.evaluation_authorized(e,true,true) AND agentonic.evaluation_sources_current(e);
 SELECT jsonb_build_object(
  'id',s.id,'agentName',a.name,'workspaceName',ws.name,'timezone',ws.timezone,'number',s.submission_number,
  'versionNumber',(SELECT count(*)::integer FROM agentonic.configuration_releases v WHERE v.workspace_id=w AND v.agent_id=s.agent_id AND (v.created_at,v.id)<=(r.created_at,r.id)),
  'submittedAt',s.submitted_at,'configurationHash',r.content_sha256,'contentAvailable',content_live,'reportAvailable',coalesce(report_live,false),
  'content',CASE WHEN content_live THEN r.content ELSE NULL END,'note',CASE WHEN content_live THEN s.customer_note ELSE NULL END,
  'collections',CASE WHEN content_live THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id',k.id,'name',k.name) ORDER BY k.name,k.id)
    FROM agentonic.knowledge_collections k WHERE k.workspace_id=w AND k.id IN (SELECT value::uuid FROM jsonb_array_elements_text(r.requested_access_snapshot->'collectionIds'))),'[]'::jsonb) ELSE '[]'::jsonb END,
  'approval',jsonb_build_object('id',d.id,'createdAt',d.created_at,'expiresAt',d.approval_expires_at,'valid',agentonic.version_approval_valid(d.id),
    'automatic',d.actor_policy_version IS NOT NULL,'reviewerName',(SELECT u.display_name FROM agentonic.platform_staff st JOIN agentonic.users u ON u.id=st.user_id WHERE st.id=d.actor_staff_id AND u.deleted_at IS NULL),
    'feedback',CASE WHEN content_live THEN d.feedback ELSE NULL END),
  'evaluation',jsonb_build_object('id',e.id,'status',e.status,'finishedAt',e.finished_at,'confirmedAt',coalesce(p.confirmed_at,e.authorized_at),
    'budgetUsd',e.budget_usd,'committedMicrousd',CASE WHEN e.batch_id IS NULL THEN coalesce(p.committed_microusd,e.committed_microusd) ELSE (SELECT sum(used.committed_microusd) FROM agentonic.evaluation_runs used WHERE used.batch_id=e.batch_id) END,'evidenceHash',e.evidence_sha256),
  'criteria',CASE WHEN report_live AND p.id IS NOT NULL AND p.scrubbed_at IS NULL THEN coalesce((SELECT cr.criteria FROM agentonic.evaluation_criteria_revisions cr WHERE cr.preparation_id=p.id AND cr.revision=coalesce((SELECT b.revision FROM agentonic.evaluation_batches b WHERE b.id=e.batch_id),(SELECT max(prior.revision) FROM agentonic.evaluation_criteria_revisions prior WHERE prior.preparation_id=p.id AND prior.created_at<=e.authorized_at))), '[]'::jsonb) ELSE '[]'::jsonb END,
  'modelBatch',CASE WHEN report_live THEN (SELECT value FROM jsonb_array_elements(agentonic.evaluation_batch_state(p)) WHERE value->>'id'=coalesce(e.batch_id,e.id)::text) ELSE NULL END,
  'results',CASE WHEN report_live THEN coalesce((SELECT jsonb_agg(jsonb_build_object('key',res.case_key,'kind',coalesce(test->>'kind','business'),
    'question',test->>'question','expectedAnswer',test->>'expectedAnswer','outcome',res.outcome,'answer',res.answer,
    'explanation',coalesce(res.assessment->>'explanation',''),'suggestion',coalesce(res.assessment->>'suggestion','')) ORDER BY ordinal)
    FROM jsonb_array_elements(e.dataset_snapshot) WITH ORDINALITY AS cases(test,ordinal)
    JOIN agentonic.evaluation_results res ON res.evaluation_run_id=e.id AND res.case_key=test->>'key'),'[]'::jsonb) ELSE '[]'::jsonb END
 ) INTO result FROM agentonic.agents a JOIN agentonic.workspaces ws ON ws.id=a.workspace_id WHERE a.id=s.agent_id AND a.workspace_id=w;
 INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,support_access_grant_id,action,resource_type,resource_id,outcome,request_id)
 VALUES(w,agentonic.actor_user_id(),g.id,'review.receipt.read','submission',s.id::text,'succeeded',trace_id::text);
 RETURN result;
END $$;
COMMIT;
