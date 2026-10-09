-- One authorization per version and host (owner decision, 9 October 2026).
--
-- "Autorizar activación" stayed available while the same version already had a pending
-- authorization, and deployment_command deduplicated only an exact retry (same request ID).
-- So a member authorized one version twice on vm-agents-01, 25 seconds apart, with budgets
-- of USD 5 and USD 20. Now a second authorization of a version is refused while one for that
-- host is pending, starting or running and still authorized. The button is hidden in that case.
-- A stopped, revoked or expired authorization no longer counts.

CREATE FUNCTION agentonic.deployment_in_place(submission uuid, environment text) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM agentonic.deployments dep WHERE dep.submission_id=submission AND dep.environment=deployment_in_place.environment
  AND dep.status IN ('awaiting_activation','queued','preparing','running') AND dep.revoked_at IS NULL AND agentonic.deployment_authorized(dep))
$$;
REVOKE ALL ON FUNCTION agentonic.deployment_in_place(uuid,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION agentonic.deployment_command(operation text, payload jsonb, trace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();staff uuid:=agentonic.current_staff();s agentonic.agent_submissions;
 d agentonic.deployments;decision agentonic.submission_review_decisions;h agentonic.runtime_hosts;sources jsonb;
BEGIN
 IF w IS NULL OR trace_id IS NULL OR agentonic.actor_user_id() IS NULL OR agentonic.application_role() NOT IN ('agentonic_customer','agentonic_admin') THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 IF operation='authorize' THEN
  SELECT * INTO s FROM agentonic.agent_submissions WHERE id=(payload->>'submissionId')::uuid AND workspace_id=w;
  IF agentonic.application_role()<>'agentonic_customer' OR m IS NULL OR NOT agentonic.can_agent(s.agent_id,'edit') OR NOT agentonic.can_agent(s.agent_id,'invoke')
   OR s.submitted_by_member_id IS DISTINCT FROM m OR payload->'consent' IS DISTINCT FROM 'true'::jsonb OR payload->>'requestId' IS NULL
   OR jsonb_typeof(payload->'budgetUsd') IS DISTINCT FROM 'number' OR (payload->>'budgetUsd')::numeric NOT BETWEEN 0.05 AND 20
   OR (payload ? 'autoRenew' AND jsonb_typeof(payload->'autoRenew') IS DISTINCT FROM 'boolean') THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO d FROM agentonic.deployments WHERE workspace_id=w AND authorized_by_member_id=m AND request_id=(payload->>'requestId')::uuid;
  IF d.id IS NOT NULL THEN
   IF d.submission_id IS DISTINCT FROM s.id OR d.environment IS DISTINCT FROM payload->>'environment' OR d.budget_usd IS DISTINCT FROM (payload->>'budgetUsd')::numeric THEN RAISE insufficient_privilege; END IF;
   RETURN jsonb_build_object('ok',true,'id',d.id);
  END IF;
  -- One authorization per version and host at a time (owner decision, 9 Oct): a second one, even with
  -- another budget, is refused while the first is pending, starting or running and still authorized.
  -- The workspace lock above serializes concurrent requests.
  IF agentonic.deployment_in_place(s.id,payload->>'environment') THEN RETURN '{"ok":false,"code":"already_authorized"}'; END IF;
  SELECT * INTO decision FROM agentonic.submission_review_decisions WHERE submission_id=s.id ORDER BY decision_number DESC LIMIT 1;
  IF NOT coalesce(agentonic.version_approval_valid(decision.id),false) THEN RETURN '{"ok":false,"code":"approval_required"}'; END IF;
  SELECT * INTO h FROM agentonic.runtime_hosts WHERE environment=payload->>'environment' AND revoked_at IS NULL AND verified_at>clock_timestamp()-interval '30 days' AND heartbeat_at>clock_timestamp()-interval '90 seconds';
  IF h.id IS NULL THEN RETURN '{"ok":false,"code":"host_unavailable"}'; END IF;
  SELECT coalesce(jsonb_agg(hit),'[]') INTO sources FROM agentonic.evaluation_results er CROSS JOIN LATERAL jsonb_array_elements(er.evidence_sources) hit WHERE er.evaluation_run_id=(decision.assessment_snapshot->>'evaluationId')::uuid;
  -- 30-day periods with a budget each, renewed automatically unless the customer opts out (§59).
  INSERT INTO agentonic.deployments(workspace_id,agent_id,code_release_id,configuration_release_id,submission_id,approval_id,host_id,environment,authorized_by_member_id,request_id,budget_usd,authorized_until,evidence_sources,
   auto_renew,period_budget_usd,period_started_at)
  VALUES(w,s.agent_id,s.code_release_id,s.configuration_release_id,s.id,decision.id,h.id,h.environment,m,(payload->>'requestId')::uuid,(payload->>'budgetUsd')::numeric,clock_timestamp()+interval '30 days',sources,
   coalesce((payload->>'autoRenew')::boolean,true),(payload->>'budgetUsd')::numeric,clock_timestamp()) RETURNING * INTO d;
  IF NOT agentonic.deployment_authorized(d) THEN RAISE insufficient_privilege; END IF;
 ELSIF operation IN ('activate','stop') THEN
  SELECT * INTO d FROM agentonic.deployments WHERE id=(payload->>'deploymentId')::uuid AND workspace_id=w FOR UPDATE;
  IF d.id IS NULL THEN RAISE insufficient_privilege; END IF;
  IF operation='stop' AND agentonic.application_role()='agentonic_customer' THEN
   IF d.authorized_by_member_id IS DISTINCT FROM m OR NOT agentonic.can_agent(d.agent_id,'invoke') THEN RAISE insufficient_privilege; END IF;
  ELSIF agentonic.application_role()<>'agentonic_admin' OR NOT EXISTS(SELECT 1 FROM agentonic.platform_staff WHERE id=staff AND role IN ('administrator','operator')) THEN RAISE insufficient_privilege; END IF;
  IF operation='activate' THEN
   IF d.status IN ('queued','preparing','running') THEN RETURN jsonb_build_object('ok',true,'id',d.id); END IF;
   IF d.status<>'awaiting_activation' OR NOT agentonic.deployment_authorized(d) OR NOT agentonic.version_approval_valid(d.approval_id) THEN RETURN '{"ok":false,"code":"approval_required"}'; END IF;
   UPDATE agentonic.deployments SET status='queued',desired_state='running',requested_by_staff_id=staff WHERE id=d.id;
  ELSE
   UPDATE agentonic.deployments SET desired_state='stopped',status='stopped',revoked_at=coalesce(revoked_at,clock_timestamp()),service_token_sha256=NULL WHERE id=d.id;
   UPDATE agentonic.agent_environments SET current_deployment_id=NULL WHERE current_deployment_id=d.id;
  END IF;
 ELSIF operation IN ('renewal','extend') THEN
  -- Only the customer who authorized the deployment sets or uses its renewal.
  SELECT * INTO d FROM agentonic.deployments WHERE id=(payload->>'deploymentId')::uuid AND workspace_id=w FOR UPDATE;
  IF d.id IS NULL OR agentonic.application_role()<>'agentonic_customer' OR d.authorized_by_member_id IS DISTINCT FROM m OR NOT agentonic.can_agent(d.agent_id,'invoke') THEN RAISE insufficient_privilege; END IF;
  IF operation='renewal' THEN
   IF jsonb_typeof(payload->'autoRenew') IS DISTINCT FROM 'boolean' OR jsonb_typeof(payload->'budgetUsd') IS DISTINCT FROM 'number' OR (payload->>'budgetUsd')::numeric NOT BETWEEN 0.05 AND 20 THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.deployments SET auto_renew=(payload->>'autoRenew')::boolean,period_budget_usd=(payload->>'budgetUsd')::numeric WHERE id=d.id;
  ELSE
   IF d.authorized_until>clock_timestamp()+interval '10 days' THEN RETURN '{"ok":false,"code":"too_early"}'; END IF;
   IF d.period_budget_usd IS NULL THEN RETURN '{"ok":false,"code":"budget_required"}'; END IF;
   IF NOT agentonic.deployment_renew(d,'manual',m) THEN RETURN jsonb_build_object('ok',false,'code',coalesce(agentonic.deployment_change(d),'changed')); END IF;
  END IF;
 ELSE RAISE insufficient_privilege;
 END IF;
 INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,action,resource_type,resource_id,outcome,request_id)
 VALUES(w,agentonic.actor_user_id(),CASE WHEN agentonic.application_role()='agentonic_customer' THEN m END,'deployment.'||operation,'deployment',d.id::text,'succeeded',trace_id::text);
 RETURN jsonb_build_object('ok',true,'id',d.id);
END $function$;

CREATE OR REPLACE FUNCTION agentonic.lifecycle_state(target_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();staff uuid:=agentonic.current_staff();aid uuid;items jsonb;deploys jsonb;operator boolean;
BEGIN
 IF w IS NULL OR agentonic.application_role() NOT IN ('agentonic_admin','agentonic_customer') THEN RAISE insufficient_privilege; END IF;
 SELECT a.id INTO aid FROM agentonic.agents a WHERE a.workspace_id=w AND (a.id=target_id OR EXISTS(SELECT 1 FROM agentonic.agent_submissions s WHERE s.id=target_id AND s.agent_id=a.id));
 IF aid IS NULL THEN RETURN NULL; END IF;
 IF agentonic.application_role()='agentonic_admin' THEN
  IF staff IS NULL THEN RAISE insufficient_privilege; END IF;
 ELSE
  IF m IS NULL OR NOT agentonic.can_agent(aid,'read') THEN RAISE insufficient_privilege; END IF;
 END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR SHARE; IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 operator:=agentonic.application_role()='agentonic_admin' AND EXISTS(SELECT 1 FROM agentonic.platform_staff WHERE id=staff AND role IN ('administrator','operator'));
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'number',s.submission_number,'candidateId',s.configuration_release_id,
  'versionNumber',(SELECT count(*)::int FROM agentonic.configuration_releases v WHERE v.agent_id=aid AND (v.created_at,v.id)<=(r.created_at,r.id)),
  'approvalId',d.id,'reason',agentonic.approval_reason(d.id),'expiresAt',d.approval_expires_at,
  'renewalRequested',EXISTS(SELECT 1 FROM agentonic.approval_renewal_requests req WHERE req.submission_id=s.id),
  'renewedSubmissionId',(SELECT id FROM agentonic.agent_submissions n WHERE n.renewed_from_submission_id=s.id),
  'canRequestRenewal',operator AND s.status='approved' AND NOT coalesce(agentonic.version_approval_valid(d.id),false) AND NOT EXISTS(SELECT 1 FROM agentonic.agent_submissions n WHERE n.renewed_from_submission_id=s.id),
  'canRenew',agentonic.application_role()='agentonic_customer' AND s.submitted_by_member_id=m AND agentonic.can_agent(aid,'edit') AND s.status IN ('approved','revoked','changes_requested','rejected','withdrawn') AND NOT coalesce(agentonic.version_approval_valid(d.id),false) AND NOT EXISTS(SELECT 1 FROM agentonic.agent_submissions n WHERE n.renewed_from_submission_id=s.id),
  'canAuthorize',agentonic.application_role()='agentonic_customer' AND s.submitted_by_member_id=m AND agentonic.can_agent(aid,'edit') AND agentonic.can_agent(aid,'invoke') AND coalesce(agentonic.version_approval_valid(d.id),false)
   AND NOT EXISTS(SELECT 1 FROM agentonic.runtime_hosts h WHERE h.revoked_at IS NULL AND agentonic.deployment_in_place(s.id,h.environment))
 ) ORDER BY s.submission_number DESC),'[]') INTO items
 FROM agentonic.agent_submissions s JOIN agentonic.configuration_releases r ON r.id=s.configuration_release_id
 LEFT JOIN LATERAL(SELECT * FROM agentonic.submission_review_decisions dec WHERE dec.submission_id=s.id AND dec.decision='approved' ORDER BY dec.decision_number DESC LIMIT 1) d ON true
 WHERE s.workspace_id=w AND s.agent_id=aid;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',dep.id,'submissionId',dep.submission_id,'environment',dep.environment,'status',dep.status,
  'authorized',agentonic.deployment_authorized(dep),'online',dep.status='running' AND agentonic.deployment_authorized(dep) AND agentonic.deployment_online(dep),
  'expiresAt',dep.authorized_until,'budgetUsd',dep.budget_usd,'committedMicrousd',dep.committed_microusd,'errorCode',dep.error_code,
  'canActivate',operator AND dep.status='awaiting_activation' AND agentonic.deployment_authorized(dep) AND agentonic.version_approval_valid(dep.approval_id),
  'canStop',(operator OR dep.authorized_by_member_id=m) AND dep.status IN ('awaiting_activation','queued','preparing','running'),
  'canChat',agentonic.application_role()='agentonic_customer' AND dep.authorized_by_member_id=m AND dep.status='running' AND agentonic.deployment_authorized(dep) AND agentonic.can_agent(aid,'invoke'),
  'autoRenew',dep.auto_renew,'periodBudgetUsd',dep.period_budget_usd,'periodStartedAt',dep.period_started_at,'periodCommittedMicrousd',dep.committed_microusd-dep.period_base_microusd,
  'renewalBlocked',CASE WHEN dep.status='running' AND dep.revoked_at IS NULL THEN coalesce(dep.renewal_blocked,CASE WHEN dep.authorized_until<=clock_timestamp()+interval '10 days' THEN agentonic.deployment_change(dep) END) END,
  'renewsAt',CASE WHEN dep.auto_renew AND dep.status='running' AND dep.revoked_at IS NULL THEN dep.authorized_until-interval '3 days' END,
  'renewals',(SELECT count(*)::int FROM agentonic.deployment_renewals rn WHERE rn.deployment_id=dep.id),
  'canChangeRenewal',agentonic.application_role()='agentonic_customer' AND dep.authorized_by_member_id=m AND dep.status IN ('awaiting_activation','queued','preparing','running') AND dep.revoked_at IS NULL,
  'canRenewNow',agentonic.application_role()='agentonic_customer' AND dep.authorized_by_member_id=m AND dep.status='running' AND dep.revoked_at IS NULL AND dep.period_budget_usd IS NOT NULL
   AND dep.authorized_until<=clock_timestamp()+interval '10 days' AND agentonic.deployment_authorized(dep)
 ) ORDER BY dep.created_at DESC),'[]') INTO deploys FROM agentonic.deployments dep WHERE dep.workspace_id=w AND dep.agent_id=aid;
 RETURN jsonb_build_object('agentId',aid,'submissions',items,'deployments',deploys,'hosts',coalesce((SELECT jsonb_agg(jsonb_build_object('environment',environment,'available',revoked_at IS NULL AND verified_at>clock_timestamp()-interval '30 days' AND coalesce(heartbeat_at>clock_timestamp()-interval '90 seconds',false))) FROM agentonic.runtime_hosts),'[]'::jsonb));
END $function$;

-- Owner decision, 9 October 2026: the duplicate authorization is removed entirely. That is the
-- USD 5 one authorized at 16:24:07 UTC, never activated and with nothing spent; the USD 20 one
-- from 16:24:32 stays. Deployment history is otherwise retained, so the guard is lifted for this
-- row only, inside one statement that rolls back as a whole. The audit trail is kept: its
-- "deployment.authorize" event still records that the authorization happened.
-- Elsewhere (fresh and test databases) the row does not exist and nothing changes.
DO $$
BEGIN
 ALTER TABLE agentonic.deployments DISABLE TRIGGER deployment_immutable;
 DELETE FROM agentonic.deployments WHERE id='d0cdff3c-dcb5-4f1c-ade1-107b8e0718d1' AND status='awaiting_activation'
  AND activated_at IS NULL AND committed_microusd=0 AND budget_usd=5
  AND NOT EXISTS(SELECT 1 FROM agentonic.agent_environments WHERE current_deployment_id='d0cdff3c-dcb5-4f1c-ade1-107b8e0718d1')
  AND NOT EXISTS(SELECT 1 FROM agentonic.staging_conversations WHERE deployment_id='d0cdff3c-dcb5-4f1c-ade1-107b8e0718d1')
  AND NOT EXISTS(SELECT 1 FROM agentonic.agent_runs WHERE deployment_id='d0cdff3c-dcb5-4f1c-ade1-107b8e0718d1')
  AND NOT EXISTS(SELECT 1 FROM agentonic.deployment_renewals WHERE deployment_id='d0cdff3c-dcb5-4f1c-ade1-107b8e0718d1');
 ALTER TABLE agentonic.deployments ENABLE TRIGGER deployment_immutable;
END $$;
