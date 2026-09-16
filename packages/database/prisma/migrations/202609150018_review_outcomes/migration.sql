BEGIN;
-- Correct abstention is valid for customer cases too; semantic evidence must still pass.
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
  IF NOT coalesce((payload->>'provider'='voyage' AND payload->>'model'='voyage-4') OR (payload->>'provider'='openai' AND payload->>'model'='gpt-4.1-mini-2025-04-14'),false) THEN RAISE insufficient_privilege; END IF;
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
   SELECT coalesce(s.id,l.id) id,coalesce(1.0/(60+s.rank),0)+coalesce(1.0/(60+l.rank),0) score FROM semantic s FULL JOIN lexical l ON s.id=l.id ORDER BY score DESC,coalesce(s.id,l.id) LIMIT 8
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'hash',c.content_sha256) ORDER BY r.score DESC,r.id),'[]') INTO hits FROM ranked r JOIN agentonic.document_chunks c ON c.id=r.id;
  UPDATE agentonic.evaluation_runs SET current_matches=hits WHERE id=e.id;
  RETURN '{"ok":true}';
 ELSIF operation IN ('context','grade-context','answer') THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'text',c.content) ORDER BY hit.ordinality),'[]') INTO hits
  FROM jsonb_array_elements(e.current_matches) WITH ORDINALITY hit(value,ordinality)
  JOIN agentonic.document_chunks c ON c.id=(hit.value->>'id')::uuid AND c.workspace_id=e.workspace_id AND c.content_sha256=hit.value->>'hash'
  JOIN agentonic.document_versions v ON v.id=c.document_version_id JOIN agentonic.documents d ON d.id=v.document_id AND d.active_version_id=v.id
  WHERE d.deleted_at IS NULL AND v.status='ready';
  IF jsonb_array_length(hits)<>jsonb_array_length(e.current_matches) THEN RAISE insufficient_privilege; END IF;
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
-- Display current approval validity, including manual exceptions and revocation.
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
 RETURN jsonb_build_object('canPrepare',available,'preparations',result);
END $$;
COMMIT;
