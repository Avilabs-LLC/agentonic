BEGIN;
-- A renewal is a new review of the SAME immutable candidate. Never rewrite approval history.
ALTER TABLE agentonic.agent_submissions ADD COLUMN renewed_from_submission_id uuid;
ALTER TABLE agentonic.agent_submissions ADD FOREIGN KEY(workspace_id,agent_id,code_release_id,configuration_release_id,renewed_from_submission_id)
 REFERENCES agentonic.agent_submissions(workspace_id,agent_id,code_release_id,configuration_release_id,id);
DROP INDEX agentonic.agent_submissions_candidate;
CREATE UNIQUE INDEX agent_submissions_first_candidate ON agentonic.agent_submissions(workspace_id,configuration_release_id) WHERE renewed_from_submission_id IS NULL;
CREATE UNIQUE INDEX agent_submissions_renewal ON agentonic.agent_submissions(renewed_from_submission_id) WHERE renewed_from_submission_id IS NOT NULL;
CREATE UNIQUE INDEX agent_submissions_open_candidate ON agentonic.agent_submissions(workspace_id,configuration_release_id) WHERE status IN ('submitted','in_review');
CREATE TABLE agentonic.approval_renewal_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, submission_id uuid NOT NULL,
 requested_by_staff_id uuid NOT NULL REFERENCES agentonic.platform_staff(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,submission_id), FOREIGN KEY(workspace_id,submission_id) REFERENCES agentonic.agent_submissions(workspace_id,id)
);
ALTER TABLE agentonic.approval_renewal_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.approval_renewal_requests FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;

CREATE FUNCTION agentonic.approval_reason(decision_id uuid) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE d agentonic.submission_review_decisions;e agentonic.evaluation_runs;
BEGIN
 SELECT * INTO d FROM agentonic.submission_review_decisions WHERE id=decision_id;
 IF d.id IS NULL OR d.decision<>'approved' THEN RETURN 'unapproved'; END IF;
 IF EXISTS(SELECT 1 FROM agentonic.submission_review_decisions x WHERE x.submission_id=d.submission_id AND x.decision_number>d.decision_number) THEN RETURN 'superseded'; END IF;
 IF agentonic.version_approval_valid(d.id) THEN RETURN 'valid'; END IF;
 IF d.approval_expires_at<=clock_timestamp() THEN RETURN 'expired'; END IF;
 SELECT * INTO e FROM agentonic.evaluation_runs WHERE id=(d.assessment_snapshot->>'evaluationId')::uuid;
 IF e.id IS NULL OR e.consent_revoked_at IS NOT NULL OR e.expires_at<=clock_timestamp() THEN RETURN 'consent'; END IF;
 IF NOT agentonic.evaluation_sources_current(e) THEN RETURN 'sources_changed'; END IF;
 IF e.finished_at<=clock_timestamp()-interval '24 hours' THEN RETURN 'evidence_expired'; END IF;
 RETURN 'authorization_changed';
END $$;

CREATE FUNCTION agentonic.approval_renewal(operation text,payload jsonb,trace_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();staff uuid:=agentonic.current_staff();
 s agentonic.agent_submissions;d agentonic.submission_review_decisions;r agentonic.configuration_releases;next_id uuid;result jsonb;
BEGIN
 IF w IS NULL OR trace_id IS NULL OR agentonic.actor_user_id() IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 SELECT * INTO s FROM agentonic.agent_submissions WHERE id=(payload->>'submissionId')::uuid AND workspace_id=w;
 IF s.id IS NULL THEN RAISE insufficient_privilege; END IF;
 SELECT * INTO d FROM agentonic.submission_review_decisions WHERE submission_id=s.id ORDER BY decision_number DESC LIMIT 1;
 IF operation='request' THEN
  IF agentonic.application_role()<>'agentonic_admin' OR NOT EXISTS(SELECT 1 FROM agentonic.platform_staff WHERE id=staff AND role IN ('administrator','operator'))
  OR s.status<>'approved' OR agentonic.version_approval_valid(d.id) THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.approval_renewal_requests(workspace_id,submission_id,requested_by_staff_id) VALUES(w,s.id,staff) ON CONFLICT(workspace_id,submission_id) DO NOTHING;
 ELSIF operation='renew' THEN
  IF agentonic.application_role()<>'agentonic_customer' OR s.submitted_by_member_id IS DISTINCT FROM m OR NOT agentonic.can_agent(s.agent_id,'edit')
  OR payload->'consent' IS DISTINCT FROM 'true'::jsonb OR s.status NOT IN ('approved','revoked','changes_requested','rejected','withdrawn') THEN RAISE insufficient_privilege; END IF;
  SELECT id INTO next_id FROM agentonic.agent_submissions WHERE renewed_from_submission_id=s.id;
  IF next_id IS NOT NULL THEN RETURN jsonb_build_object('ok',true,'id',next_id); END IF;
  IF s.status='approved' AND agentonic.version_approval_valid(d.id) THEN RETURN '{"ok":false,"code":"still_valid"}'; END IF;
  IF (payload->>'budgetUsd')::numeric NOT BETWEEN 0.05 AND 1 OR payload->>'budgetUsd' IS NULL OR payload->>'requestId' IS NULL THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO r FROM agentonic.configuration_releases WHERE id=s.configuration_release_id AND retired_at IS NULL;
  IF r.id IS NULL OR NOT agentonic.can_use_code(r.code_release_id)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.requested_access_snapshot->'collectionIds') c WHERE NOT agentonic.can_collection(c::uuid,'read')) THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.agent_submissions(workspace_id,agent_id,code_release_id,configuration_release_id,submission_number,submitted_by_member_id,review_consent,renewed_from_submission_id)
   SELECT w,s.agent_id,s.code_release_id,s.configuration_release_id,coalesce(max(submission_number),0)+1,m,
    jsonb_build_object('version',1,'configuration',true,'knowledgeMetadata',true,'expiresAt',clock_timestamp()+interval '7 days'),s.id
   FROM agentonic.agent_submissions WHERE workspace_id=w AND agent_id=s.agent_id RETURNING id INTO next_id;
  result:=agentonic.review_flow_command('prepare',jsonb_build_object('submissionId',next_id,'budgetUsd',payload->'budgetUsd','consent',true,'requestId',payload->>'requestId'),trace_id);
  IF result->>'ok' IS DISTINCT FROM 'true' THEN RAISE insufficient_privilege; END IF;
 ELSE RAISE insufficient_privilege;
 END IF;
 INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,action,resource_type,resource_id,outcome,request_id)
 VALUES(w,agentonic.actor_user_id(),CASE WHEN agentonic.application_role()='agentonic_customer' THEN m END,'approval.'||operation,'submission',s.id::text,'succeeded',trace_id::text);
 RETURN jsonb_build_object('ok',true,'id',coalesce(next_id,s.id));
END $$;
REVOKE ALL ON FUNCTION agentonic.approval_reason(uuid) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
REVOKE ALL ON FUNCTION agentonic.approval_renewal(text,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic.approval_renewal(text,jsonb,uuid) TO agentonic_admin,agentonic_customer;
COMMIT;
