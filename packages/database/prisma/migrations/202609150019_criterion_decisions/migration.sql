BEGIN;
-- Explicit customer decisions remain in immutable criteria revisions; existing confirmed evidence is untouched.
CREATE OR REPLACE FUNCTION agentonic.valid_review_criteria(items jsonb,confirmed boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE c jsonb; src jsonb;
BEGIN
 IF jsonb_typeof(items) IS DISTINCT FROM 'array' OR jsonb_array_length(items) NOT BETWEEN 1 AND 12 THEN RETURN false; END IF;
 IF (SELECT count(DISTINCT x->>'key') FROM jsonb_array_elements(items) x)<>jsonb_array_length(items) THEN RETURN false; END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(items) LOOP
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR c-ARRAY['key','question','expectedAnswer','basis','sourceIds','needsInput','notes','excluded','exclusionReason','reviewDecision']<>'{}'
  OR NOT(c ?& ARRAY['key','question','expectedAnswer','basis','sourceIds','needsInput','notes','excluded','exclusionReason'])
  OR jsonb_typeof(c->'key')<>'string' OR c->>'key' !~ '^[a-z0-9_-]{1,40}$' OR c->>'key' LIKE 'platform-%'
  OR jsonb_typeof(c->'question')<>'string' OR length(btrim(c->>'question')) NOT BETWEEN 10 AND 1000
  OR jsonb_typeof(c->'expectedAnswer')<>'string' OR length(c->>'expectedAnswer')>2000
  OR jsonb_typeof(c->'basis')<>'string' OR length(c->>'basis')>1500
  OR jsonb_typeof(c->'notes')<>'string' OR length(c->>'notes')>1500
  OR jsonb_typeof(c->'exclusionReason')<>'string' OR length(c->>'exclusionReason')>500
  OR jsonb_typeof(c->'needsInput')<>'boolean' OR jsonb_typeof(c->'excluded')<>'boolean'
  OR jsonb_typeof(c->'sourceIds')<>'array' OR jsonb_array_length(c->'sourceIds')>8
  OR (c->'excluded'='true' AND length(btrim(c->>'exclusionReason'))<5)
  OR (c ? 'reviewDecision' AND (jsonb_typeof(c->'reviewDecision')<>'string' OR c->>'reviewDecision' NOT IN ('pending','approved','not_applicable')))
  OR (c->>'reviewDecision'='approved' AND (c->'excluded'<>'false' OR c->'needsInput'<>'false' OR length(btrim(c->>'expectedAnswer'))<10))
  OR (c->>'reviewDecision'='not_applicable' AND c->'excluded'<>'true')
  OR (confirmed AND coalesce(c->>'reviewDecision','pending') NOT IN ('approved','not_applicable'))
  OR (confirmed AND c->'excluded'='false' AND (c->'needsInput'='true' OR length(btrim(c->>'expectedAnswer'))<10)) THEN RETURN false; END IF;
  FOR src IN SELECT value FROM jsonb_array_elements(c->'sourceIds') LOOP
   IF jsonb_typeof(src)<>'string' OR src#>>'{}' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN NOT confirmed OR EXISTS(SELECT 1 FROM jsonb_array_elements(items) x WHERE x->'excluded'='false');
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE OR REPLACE FUNCTION agentonic.review_flow_command(operation text,payload jsonb,trace_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();s agentonic.agent_submissions;r agentonic.configuration_releases;p agentonic.evaluation_preparations; result_id uuid;allowed text[];dataset jsonb;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR agentonic.actor_user_id() IS NULL OR m IS NULL OR w IS NULL OR trace_id IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 allowed:=CASE operation WHEN 'prepare' THEN ARRAY['submissionId','budgetUsd','consent','requestId'] WHEN 'save' THEN ARRAY['preparationId','revision','criteria'] WHEN 'confirm' THEN ARRAY['preparationId','revision','consent'] WHEN 'cancel' THEN ARRAY['preparationId'] END;
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
   UPDATE agentonic.evaluation_runs SET consent_revoked_at=coalesce(consent_revoked_at,clock_timestamp()),status=CASE WHEN status IN ('awaiting_consent','queued','running') THEN 'cancelled' ELSE status END,lease_token=NULL,lease_until=NULL,current_matches='[]' WHERE id=p.evaluation_id;
  ELSE
   IF p.status<>'criteria_ready' OR NOT agentonic.preparation_authorized(p) OR NOT agentonic.preparation_sources_current(p) THEN RAISE insufficient_privilege; END IF;
   IF (payload->>'revision')::integer IS DISTINCT FROM p.revision THEN RETURN '{"ok":false,"code":"conflict"}'; END IF;
   IF operation='save' THEN
    IF NOT agentonic.valid_review_criteria(payload->'criteria') THEN RAISE insufficient_privilege; END IF;
    -- Existing suggestions must remain, with an explicit exclusion reason. Users may
    -- edit expectations/add cases but cannot rewrite provenance or platform checks.
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(p.generated_criteria) original WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'criteria') edited WHERE edited->>'key'=original->>'key' AND edited->'basis'=original->'basis' AND edited->'sourceIds'=original->'sourceIds'))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'criteria') edited WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.generated_criteria) original WHERE original->>'key'=edited->>'key') AND (edited->'sourceIds'<>'[]' OR edited->>'basis'<>'Aportado por el cliente.')) THEN RAISE insufficient_privilege; END IF;
    UPDATE agentonic.evaluation_preparations SET criteria=payload->'criteria',revision=revision+1 WHERE id=p.id;
    INSERT INTO agentonic.evaluation_criteria_revisions(workspace_id,preparation_id,revision,criteria,content_sha256,edited_by_member_id) VALUES(w,p.id,p.revision+1,payload->'criteria',agentonic.content_hash(payload->'criteria'),m);
   ELSIF operation='confirm' THEN
    IF payload->'consent' IS DISTINCT FROM 'true'::jsonb THEN RAISE insufficient_privilege; END IF;
    IF NOT agentonic.valid_review_criteria(p.criteria,true) THEN RETURN '{"ok":false,"code":"criteria_required"}'; END IF;
    IF EXISTS(SELECT 1 FROM agentonic.retrieval_provider_operations WHERE job_id=p.id AND status='reserved') OR p.committed_microusd>=p.budget_usd*1000000 THEN RAISE insufficient_privilege; END IF;
    SELECT jsonb_agg((c-ARRAY['excluded','exclusionReason','needsInput','reviewDecision'])||'{"kind":"business"}'::jsonb ORDER BY n) INTO dataset FROM jsonb_array_elements(p.criteria) WITH ORDINALITY x(c,n) WHERE c->'excluded'='false';
    dataset:=dataset||agentonic.platform_review_cases();
    INSERT INTO agentonic.evaluation_runs(workspace_id,agent_id,submission_id,code_release_id,configuration_release_id,preparation_id,authorized_by_member_id,authorized_at,environment,status,dataset_snapshot,dataset_sha256,grader_snapshot,grader_sha256,configuration_sha256,requested_access_sha256,budget_usd,expires_at)
    VALUES(w,p.agent_id,p.submission_id,p.code_release_id,p.configuration_release_id,p.id,m,clock_timestamp(),'azure_staging','queued',dataset,agentonic.content_hash(dataset),'{"version":"grounded-review-v2","model":"gpt-4.1-mini-2025-04-14","policy":"readonly-review-v1"}',agentonic.content_hash('{"version":"grounded-review-v2","model":"gpt-4.1-mini-2025-04-14","policy":"readonly-review-v1"}'),p.configuration_sha256,p.requested_access_sha256,p.budget_usd,p.expires_at) RETURNING id INTO result_id;
    UPDATE agentonic.evaluation_preparations SET status='evaluating',evaluation_id=result_id,confirmed_at=(SELECT authorized_at FROM agentonic.evaluation_runs WHERE id=result_id) WHERE id=p.id;
   END IF;
  END IF;
 END IF;
 INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,action,resource_type,resource_id,outcome,request_id)
 VALUES(w,agentonic.actor_user_id(),m,'review_flow.'||operation,'evaluation_preparation',p.id::text,'succeeded',trace_id::text);
 RETURN jsonb_build_object('ok',true,'id',result_id);
END $$;
CREATE OR REPLACE FUNCTION agentonic.review_preparation_worker(operation text,preparation_id uuid,token uuid,payload jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE p agentonic.evaluation_preparations;worker agentonic.evaluation_workers;config agentonic.configuration_releases;hits jsonb;result jsonb;previous jsonb;amount bigint;budget agentonic.retrieval_provider_budgets;meter agentonic.retrieval_provider_operations;
BEGIN
 SELECT * INTO p FROM agentonic.evaluation_preparations WHERE id=preparation_id;
 IF p.id IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=p.workspace_id FOR SHARE;
 SELECT * INTO p FROM agentonic.evaluation_preparations WHERE id=preparation_id FOR UPDATE;
 SELECT * INTO worker FROM agentonic.evaluation_workers WHERE id=p.worker_id AND database_role=agentonic.application_role() AND environment='azure_staging' AND revoked_at IS NULL AND verified_at>clock_timestamp()-interval '7 days' AND verification @> '{"reviewProtocol":2}';
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
CREATE FUNCTION agentonic.can_record_review_decision(submission_id uuid,grant_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p agentonic.evaluation_preparations;e agentonic.evaluation_runs;
BEGIN
 IF agentonic.application_role()<>'agentonic_admin' OR NOT agentonic.can_review(submission_id,grant_id) THEN RETURN false; END IF;
 SELECT * INTO p FROM agentonic.evaluation_preparations WHERE evaluation_preparations.submission_id=can_record_review_decision.submission_id AND workspace_id=agentonic.workspace_id() ORDER BY created_at DESC,id DESC LIMIT 1;
 IF p.id IS NOT NULL THEN
  SELECT * INTO e FROM agentonic.evaluation_runs WHERE id=p.evaluation_id;
  RETURN coalesce(p.confirmed_at IS NOT NULL AND p.status IN ('needs_changes','needs_attention') AND agentonic.preparation_authorized(p,true) AND agentonic.preparation_sources_current(p) AND e.status IN ('passed','failed') AND agentonic.evaluation_authorized(e,true) AND agentonic.evaluation_sources_current(e),false);
 END IF;
 SELECT * INTO e FROM agentonic.evaluation_runs WHERE evaluation_runs.submission_id=can_record_review_decision.submission_id AND workspace_id=agentonic.workspace_id() ORDER BY created_at DESC,id DESC LIMIT 1;
 RETURN coalesce(e.status IN ('passed','failed') AND agentonic.evaluation_authorized(e,true) AND agentonic.evaluation_sources_current(e),false);
END $$;
REVOKE ALL ON FUNCTION agentonic.can_record_review_decision(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure;

ALTER FUNCTION agentonic.authoring_command(text,jsonb,uuid) RENAME TO authoring_command_before_criterion_decisions;
REVOKE ALL ON FUNCTION agentonic.authoring_command_before_criterion_decisions(text,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role,agentonic_customer,agentonic_admin,agentonic_worker,agentonic_eval_local,agentonic_eval_azure;
CREATE FUNCTION agentonic.authoring_command(operation text,payload jsonb,trace_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF operation='review.decide' THEN
  -- Match the worker/customer lock order so eligibility cannot change between check and write.
  PERFORM 1 FROM agentonic.workspaces WHERE id=agentonic.workspace_id() FOR UPDATE;
  IF NOT agentonic.can_record_review_decision((payload->>'submissionId')::uuid,(payload->>'grantId')::uuid) THEN RETURN '{"ok":false,"code":"evaluation_required"}'; END IF;
 END IF;
 RETURN agentonic.authoring_command_before_criterion_decisions(operation,payload,trace_id);
END $$;
REVOKE ALL ON FUNCTION agentonic.authoring_command(text,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role,agentonic_worker,agentonic_eval_local,agentonic_eval_azure;
GRANT EXECUTE ON FUNCTION agentonic.authoring_command(text,jsonb,uuid) TO agentonic_customer,agentonic_admin;

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
 AND EXISTS(SELECT 1 FROM agentonic.evaluation_workers worker WHERE worker.environment='azure_staging' AND worker.runtime_sha256=code.artifact_sha256 AND worker.revoked_at IS NULL AND worker.verified_at>clock_timestamp()-interval '7 days' AND worker.verification @> '{"reviewProtocol":2}')) INTO available;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
 'id',p.id,'submissionId',p.submission_id,'status',display_status,'revision',p.revision,'criteria',CASE WHEN live THEN p.criteria ELSE '[]'::jsonb END,
 'budgetUsd',p.budget_usd,'committedMicrousd',p.committed_microusd,'expiresAt',p.expires_at,'evaluationId',p.evaluation_id,
 'canEdit',customer AND p.authorized_by_member_id=m AND p.status='criteria_ready' AND live,
 'canCancel',customer AND p.authorized_by_member_id=m AND p.consent_revoked_at IS NULL AND p.expires_at>clock_timestamp(),
 'canApprove',NOT customer AND p.status='needs_attention' AND agentonic.evaluation_approvable(e) AND EXISTS(SELECT 1 FROM agentonic.platform_staff WHERE id=agentonic.current_staff() AND role IN ('administrator','operator') AND disabled_at IS NULL),
 'evidenceHash',e.evidence_sha256,
 'summary',CASE WHEN NOT live THEN 'El acceso a esta revisión ya no está vigente. El consumo y el historial se conservan.' WHEN display_status='expired' THEN 'La aprobación de esta versión ya no está vigente. Se necesita evidencia vigente antes de activar la versión.' WHEN display_status='approved' THEN 'Esta versión superó los criterios confirmados y los controles de la plataforma. La aprobación no activa un despliegue.' WHEN p.status='needs_changes' THEN 'La evaluación encontró ajustes concretos. Revisa las observaciones y prepara una nueva versión.' WHEN p.status='needs_attention' THEN CASE WHEN p.risk='sensitive' THEN 'Por el alcance de este agente, el equipo debe revisar el resultado antes de aprobar.' WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(p.criteria) c WHERE c->'excluded'='true') THEN 'Hay situaciones excluidas por el cliente. El equipo revisará sus motivos antes de decidir.' ELSE 'La evaluación requiere aclarar el alcance o la evidencia. El equipo revisará las observaciones; no tienes que volver a revisar cada respuesta.' END WHEN p.status='error' THEN 'La revisión se interrumpió. Se conserva el consumo realizado; no se repetirá automáticamente.' WHEN p.status='criteria_ready' THEN 'La IA propone situaciones basadas en tus instrucciones y una muestra del conocimiento autorizado. Ajusta lo que esperas del agente antes de evaluar.' WHEN p.status='evaluating' THEN 'Estamos probando la versión y comparando sus respuestas con tus criterios y los controles de la plataforma.' ELSE 'La IA preparará una propuesta de criterios dentro del límite autorizado.' END,
 'results',CASE WHEN live AND agentonic.evaluation_sources_current(e) THEN coalesce((SELECT jsonb_agg(jsonb_build_object('key',r.case_key,'kind',test->>'kind','question',test->>'question','expectedAnswer',test->>'expectedAnswer','outcome',r.outcome,'answer',r.answer,'explanation',r.assessment->>'explanation','suggestion',r.assessment->>'suggestion','sources',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'text',c.content)) FROM agentonic.document_chunks c WHERE c.workspace_id=w AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.evidence_sources) src WHERE src->>'id'=c.id::text AND src->>'hash'=c.content_sha256)),'[]'::jsonb)) ORDER BY r.created_at,r.case_key) FROM agentonic.evaluation_results r CROSS JOIN LATERAL jsonb_array_elements(e.dataset_snapshot) test WHERE r.evaluation_run_id=e.id AND test->>'key'=r.case_key),'[]'::jsonb) ELSE '[]'::jsonb END,
 'sources',CASE WHEN live THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'text',c.content)) FROM agentonic.document_chunks c WHERE c.workspace_id=w AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.source_snapshot) src WHERE src->>'id'=c.id::text AND src->>'hash'=c.content_sha256)),'[]'::jsonb) ELSE '[]'::jsonb END
 ) ORDER BY p.created_at DESC),'[]'::jsonb) INTO result
 FROM agentonic.evaluation_preparations p LEFT JOIN agentonic.evaluation_runs e ON e.id=p.evaluation_id
 CROSS JOIN LATERAL(SELECT CASE
 WHEN p.consent_revoked_at IS NOT NULL THEN 'cancelled'
 WHEN EXISTS(SELECT 1 FROM agentonic.agent_submissions s WHERE s.id=p.submission_id AND s.status='revoked') THEN 'revoked'
 WHEN EXISTS(SELECT 1 FROM agentonic.submission_review_decisions d JOIN agentonic.agent_submissions s ON s.id=d.submission_id WHERE s.id=p.submission_id AND s.status='approved' AND d.decision='approved' AND d.assessment_snapshot->>'evaluationId'=e.id::text) THEN CASE WHEN EXISTS(SELECT 1 FROM agentonic.submission_review_decisions d WHERE d.submission_id=p.submission_id AND d.decision='approved' AND d.assessment_snapshot->>'evaluationId'=e.id::text AND agentonic.version_approval_valid(d.id)) THEN 'approved' ELSE 'expired' END
 ELSE p.status END display_status) presentation
 CROSS JOIN LATERAL(SELECT agentonic.preparation_authorized(p,true) AND agentonic.preparation_sources_current(p) live) access
 WHERE p.workspace_id=w AND (p.agent_id=target_id OR p.submission_id=target_id) AND (customer AND p.authorized_by_member_id=m OR NOT customer AND agentonic.can_review(p.submission_id,grant_id));
 RETURN jsonb_build_object('canPrepare',available,'canDecide',CASE WHEN customer THEN false ELSE agentonic.can_record_review_decision(target_id,grant_id) END,'preparations',result);
END $$;
COMMIT;
