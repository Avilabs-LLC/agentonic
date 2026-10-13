BEGIN;
-- Evidence by name (architecture §76, owner direction 13 October 2026): a
-- situation's sources are shown as the documents they came from, like a file
-- index, never as their full text. The same style guide or document was
-- rendered whole under every situation it supported.
--
-- One helper names the passages a result or a set of criteria rests on: each
-- passage still current (same id and hash, as before) with its document's
-- title and its collection's name. The passage text no longer leaves the
-- database through these reads. evaluation_model_state (migration 35) and
-- review_flow_state (migration 60) are copied verbatim except for that call;
-- both were checked against the live definitions before this migration.
CREATE FUNCTION agentonic.evidence_sources(w uuid,items jsonb) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'documentId',d.id,'title',d.title,'collection',k.name) ORDER BY d.title,d.id,c.ordinal),'[]'::jsonb)
 FROM agentonic.document_chunks c
 JOIN agentonic.document_versions v ON v.id=c.document_version_id AND v.workspace_id=c.workspace_id
 JOIN agentonic.documents d ON d.id=v.document_id AND d.workspace_id=c.workspace_id
 JOIN agentonic.knowledge_sources s ON s.id=d.source_id AND s.workspace_id=c.workspace_id
 JOIN agentonic.knowledge_collections k ON k.id=s.collection_id AND k.workspace_id=c.workspace_id
 WHERE c.workspace_id=w AND EXISTS(SELECT 1 FROM jsonb_array_elements(items) src WHERE src->>'id'=c.id::text AND src->>'hash'=c.content_sha256)
$$;
REVOKE ALL ON FUNCTION agentonic.evidence_sources(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,agentonic_customer,agentonic_admin,agentonic_worker,agentonic_eval_local,agentonic_eval_azure;

CREATE OR REPLACE FUNCTION agentonic.evaluation_model_state(e agentonic.evaluation_runs) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('id',e.id,'model',e.response_model,'reasoning',e.reasoning_effort,'status',e.status,
 'total',jsonb_array_length(e.dataset_snapshot),'completed',e.next_case,
 'passed',(SELECT count(*) FROM agentonic.evaluation_results WHERE evaluation_run_id=e.id AND outcome='passed'),
 'committedMicrousd',e.committed_microusd,'grader',e.grader_snapshot->>'model','errorCode',e.error_code,
 'results',CASE WHEN agentonic.evaluation_authorized(e,true,true) AND agentonic.evaluation_sources_current(e) THEN coalesce((SELECT jsonb_agg(jsonb_build_object('key',r.case_key,'kind',test->>'kind','question',test->>'question','expectedAnswer',test->>'expectedAnswer','outcome',r.outcome,'answer',r.answer,'explanation',r.assessment->>'explanation','suggestion',r.assessment->>'suggestion','sources',agentonic.evidence_sources(e.workspace_id,r.evidence_sources)) ORDER BY r.created_at,r.case_key) FROM agentonic.evaluation_results r CROSS JOIN LATERAL jsonb_array_elements(e.dataset_snapshot) test WHERE r.evaluation_run_id=e.id AND test->>'key'=r.case_key),'[]'::jsonb) ELSE '[]'::jsonb END)
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
 'results',CASE WHEN live AND agentonic.evaluation_sources_current(e) THEN coalesce((SELECT jsonb_agg(jsonb_build_object('key',r.case_key,'kind',test->>'kind','question',test->>'question','expectedAnswer',test->>'expectedAnswer','outcome',r.outcome,'answer',r.answer,'explanation',r.assessment->>'explanation','suggestion',r.assessment->>'suggestion','sources',agentonic.evidence_sources(w,r.evidence_sources)) ORDER BY r.created_at,r.case_key) FROM agentonic.evaluation_results r CROSS JOIN LATERAL jsonb_array_elements(e.dataset_snapshot) test WHERE r.evaluation_run_id=e.id AND test->>'key'=r.case_key),'[]'::jsonb) ELSE '[]'::jsonb END,
 'sources',CASE WHEN live THEN agentonic.evidence_sources(w,p.source_snapshot) ELSE '[]'::jsonb END
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
COMMIT;
