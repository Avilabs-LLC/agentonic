BEGIN;
-- Exact-submission receipt grants never authorize active review, evaluation, or deployment.
CREATE OR REPLACE FUNCTION agentonic.validate_access_rows() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE entry jsonb; old_json jsonb; new_json jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN
  old_json:=to_jsonb(OLD); new_json:=to_jsonb(NEW);
  IF new_json->'id' IS DISTINCT FROM old_json->'id' OR new_json->'workspace_id' IS DISTINCT FROM old_json->'workspace_id' OR new_json->'created_at' IS DISTINCT FROM old_json->'created_at' THEN
   RAISE EXCEPTION 'Resource identity is immutable';
  END IF;
  IF TG_TABLE_NAME IN ('audit_events','template_versions') THEN RAISE EXCEPTION 'Immutable history'; END IF;
  IF TG_TABLE_NAME='support_access_grants' AND (new_json-'revoked_at') IS DISTINCT FROM (old_json-'revoked_at') THEN RAISE EXCEPTION 'Support scope is immutable'; END IF;
  IF TG_TABLE_NAME='code_repositories' AND (new_json->'visibility' IS DISTINCT FROM old_json->'visibility' OR new_json->'repository_url' IS DISTINCT FROM old_json->'repository_url' OR new_json->'repository_subdirectory' IS DISTINCT FROM old_json->'repository_subdirectory') THEN RAISE EXCEPTION 'Repository identity is immutable'; END IF;
  IF TG_TABLE_NAME='agents' AND (new_json-ARRAY['name','description','status','updated_at','archived_at','owner_member_id']) IS DISTINCT FROM (old_json-ARRAY['name','description','status','updated_at','archived_at','owner_member_id']) THEN RAISE EXCEPTION 'Agent provenance is immutable'; END IF;
 END IF;
 IF TG_TABLE_NAME='audit_events' THEN
  IF NEW.actor_member_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agentonic.workspace_members WHERE id=NEW.actor_member_id AND workspace_id=NEW.workspace_id AND user_id=NEW.actor_user_id) THEN RAISE EXCEPTION 'Audit actor mismatch'; END IF;
  IF NEW.support_access_grant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agentonic.support_access_grants g JOIN agentonic.platform_staff s ON s.id=g.staff_id WHERE g.id=NEW.support_access_grant_id AND g.workspace_id=NEW.workspace_id AND s.user_id=NEW.actor_user_id) THEN RAISE EXCEPTION 'Audit support actor mismatch'; END IF;
 ELSIF TG_TABLE_NAME='agent_contact_grants' THEN
  IF jsonb_typeof(NEW.allowed_capabilities)<>'array' OR NOT NEW.allowed_capabilities <@ '["invoke"]'::jsonb THEN RAISE EXCEPTION 'Invalid contact capabilities'; END IF;
 ELSIF TG_TABLE_NAME='support_access_grants' AND TG_OP='INSERT' AND to_jsonb(NEW)->'scope'->'version'='3'::jsonb THEN
  IF (NEW.scope-ARRAY['version','submissionId','operations'])<>'{}'::jsonb OR NEW.scope->'operations' IS DISTINCT FROM '["receipt"]'::jsonb OR NOT EXISTS(
   SELECT 1 FROM agentonic.agent_submissions s WHERE s.id=(NEW.scope->>'submissionId')::uuid AND s.workspace_id=NEW.workspace_id AND s.submitted_by_member_id=NEW.approved_by_member_id
   AND s.status='approved' AND agentonic.member_can_author(s.submitted_by_member_id,s.agent_id)
   AND s.review_consent->'configuration'='true'::jsonb AND s.review_consent->'knowledgeMetadata'='true'::jsonb
   AND (s.review_consent->>'expiresAt')::timestamptz>=NEW.expires_at AND NEW.expires_at<=clock_timestamp()+interval '7 days'
  ) THEN RAISE EXCEPTION 'Invalid receipt consent'; END IF;
 ELSIF TG_TABLE_NAME='support_access_grants' AND TG_OP='INSERT' AND to_jsonb(NEW)->'scope'->'version'='2'::jsonb THEN
  IF (NEW.scope-ARRAY['version','submissionId','operations'])<>'{}'::jsonb OR NEW.scope->'operations' IS DISTINCT FROM '["review"]'::jsonb OR NOT EXISTS(
   SELECT 1 FROM agentonic.agent_submissions s WHERE s.id=(NEW.scope->>'submissionId')::uuid AND s.workspace_id=NEW.workspace_id AND s.submitted_by_member_id=NEW.approved_by_member_id
   AND s.status IN ('submitted','in_review') AND agentonic.member_can_author(s.submitted_by_member_id,s.agent_id)
   AND s.review_consent->'configuration'='true'::jsonb AND s.review_consent->'knowledgeMetadata'='true'::jsonb
   AND (s.review_consent->>'expiresAt')::timestamptz>=NEW.expires_at AND NEW.expires_at<=clock_timestamp()+interval '7 days'
  ) THEN RAISE EXCEPTION 'Invalid review consent'; END IF;
 ELSIF TG_TABLE_NAME='support_access_grants' AND TG_OP='INSERT' THEN
  IF jsonb_typeof(NEW.scope)<>'object' OR NEW.scope->>'version'<>'1' OR NOT NEW.scope ? 'version' OR
   (SELECT count(*) FROM jsonb_object_keys(NEW.scope))<>2 OR jsonb_typeof(NEW.scope->'resources') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid support scope'; END IF;
  IF jsonb_array_length(NEW.scope->'resources') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid support scope'; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(NEW.scope->'resources') LOOP
   IF jsonb_typeof(entry)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(entry))<>3 OR entry->>'type' NOT IN ('agent','collection') OR
    entry->>'type' IS NULL OR entry->>'id' IS NULL OR entry->'operations' IS DISTINCT FROM '["read"]'::jsonb THEN RAISE EXCEPTION 'Invalid support resource'; END IF;
   IF NOT (CASE entry->>'type' WHEN 'agent' THEN EXISTS(SELECT 1 FROM agentonic.agents WHERE id=(entry->>'id')::uuid AND workspace_id=NEW.workspace_id AND owner_member_id=NEW.approved_by_member_id)
    WHEN 'collection' THEN EXISTS(SELECT 1 FROM agentonic.knowledge_collections WHERE id=(entry->>'id')::uuid AND workspace_id=NEW.workspace_id AND owner_member_id=NEW.approved_by_member_id) ELSE false END) THEN RAISE EXCEPTION 'Invalid support resource'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION agentonic.approved_review_receipt(target_id uuid, trace_id uuid) RETURNS jsonb
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
 SELECT * INTO p FROM agentonic.evaluation_preparations WHERE id=e.preparation_id AND workspace_id=w AND evaluation_id=e.id;
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
    'budgetUsd',coalesce(p.budget_usd,e.budget_usd),'committedMicrousd',coalesce(p.committed_microusd,e.committed_microusd),'evidenceHash',e.evidence_sha256),
  'criteria',CASE WHEN report_live AND p.id IS NOT NULL AND p.scrubbed_at IS NULL THEN p.criteria ELSE '[]'::jsonb END,
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
REVOKE ALL ON FUNCTION agentonic.approved_review_receipt(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,agentonic_customer,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic.approved_review_receipt(uuid,uuid) TO agentonic_admin;
COMMIT;
