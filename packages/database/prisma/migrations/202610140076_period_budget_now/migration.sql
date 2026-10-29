BEGIN;
-- A raised period budget applies now (architecture §80, owner decision
-- 14 October 2026). Ajustar renovación set only the next period's budget: Nico
-- raised NicolAI-Mail's to US$20 and its turn was still stopped at the current
-- period's US$5.00, while Activación showed US$20. Raising it now also raises
-- the current period's ceiling; lowering it still waits for the renewal.
-- deployment_command is migration 66's, checked against the live definition,
-- with only that statement changed.
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
   -- Raising the period budget applies to the current period too (§80): its
   -- ceiling becomes what earlier periods used plus the new budget. Lowering
   -- it waits for the next renewal, since a running ceiling never shrinks.
   UPDATE agentonic.deployments SET auto_renew=(payload->>'autoRenew')::boolean,period_budget_usd=(payload->>'budgetUsd')::numeric,
    budget_usd=greatest(budget_usd,period_base_microusd::numeric/1000000+(payload->>'budgetUsd')::numeric) WHERE id=d.id;
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

COMMIT;
