BEGIN;
-- Superseded reviews and Revisiones actions (owner decisions, 9 October 2026).
--
-- One open review per candidate let an agent keep versions 1 to 5 in Enviada
-- after version 6 was approved. A sent version can never be sent again or
-- previewed, yet staff could still open, evaluate and approve it, and the
-- customer saw it "En proceso". Now approving a version closes every open
-- review (Enviada or En revisión) of an older version of the same agent as
-- "Reemplazada", the way a withdrawal does: an appended decision by an explicit
-- policy actor, the status, and the review access revoked. Pending preparation
-- and evaluation stop because they require an open review; reservations and
-- recorded usage are untouched. Newer versions and closed reviews are not
-- changed. Reviews already in that situation are closed here too.
--
-- Also: the review queue says whether a decision can be recorded now
-- (Cambiar estado), the Admin agent page learns Google Drive, and staff can
-- read a member's card (Ver usuario). Metadata only.

-- The new state and decision, and the policy actor that may record it.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='agentonic.agent_submissions'::regclass AND contype='c'
  AND pg_get_constraintdef(oid) LIKE '%''withdrawn''%' LOOP
  EXECUTE format('ALTER TABLE agentonic.agent_submissions DROP CONSTRAINT %I',c.conname);
 END LOOP;
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='agentonic.submission_review_decisions'::regclass AND contype='c'
  AND (pg_get_constraintdef(oid) LIKE '%''withdrawn''%' OR pg_get_constraintdef(oid) LIKE '%readonly-review-v1%') LOOP
  EXECUTE format('ALTER TABLE agentonic.submission_review_decisions DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE agentonic.agent_submissions ADD CONSTRAINT agent_submissions_status CHECK(status IN ('submitted','in_review','changes_requested','approved','rejected','withdrawn','revoked','superseded'));
ALTER TABLE agentonic.submission_review_decisions ADD CONSTRAINT review_decision_kind CHECK(decision IN ('in_review','changes_requested','approved','rejected','withdrawn','revoked','superseded'));
ALTER TABLE agentonic.submission_review_decisions ADD CONSTRAINT review_decision_policy CHECK(actor_policy_version IS NULL
 OR (actor_policy_version='readonly-review-v1' AND decision='approved')
 OR (actor_policy_version='superseded-by-approval-v1' AND decision='superseded'));

-- As in migration 17, plus the superseding policy: it may only close an open
-- review of an older version of the same agent, naming an approved review.
CREATE OR REPLACE FUNCTION agentonic.validate_version_approval() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE e agentonic.evaluation_runs;
BEGIN
 IF NEW.actor_policy_version='superseded-by-approval-v1' THEN
  IF NEW.decision<>'superseded' OR NEW.feedback IS NOT NULL OR NEW.support_access_grant_id IS NOT NULL
  OR NEW.assessment_snapshot IS DISTINCT FROM jsonb_build_object('version',1,'supersededBy',NEW.assessment_snapshot->>'supersededBy')
  OR NOT EXISTS(
   SELECT 1 FROM agentonic.agent_submissions prior
   JOIN agentonic.configuration_releases r ON r.id=prior.configuration_release_id
   JOIN agentonic.agent_submissions s ON s.id=(NEW.assessment_snapshot->>'supersededBy')::uuid AND s.workspace_id=prior.workspace_id AND s.agent_id=prior.agent_id
   JOIN agentonic.configuration_releases n ON n.id=s.configuration_release_id
   WHERE prior.id=NEW.submission_id AND prior.workspace_id=NEW.workspace_id AND prior.agent_id=NEW.agent_id
   AND prior.status IN ('submitted','in_review') AND (r.created_at,r.id)<(n.created_at,n.id)
   AND EXISTS(SELECT 1 FROM agentonic.submission_review_decisions a WHERE a.submission_id=s.id AND a.decision='approved')) THEN
   RAISE insufficient_privilege;
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.actor_policy_version IS NOT NULL THEN
  SELECT * INTO e FROM agentonic.evaluation_runs WHERE id=(NEW.assessment_snapshot->>'evaluationId')::uuid AND workspace_id=NEW.workspace_id;
  IF agentonic.application_role()<>'agentonic_eval_azure' OR NEW.actor_policy_version<>'readonly-review-v1'
  OR NOT coalesce(agentonic.review_auto_eligible(e),false) OR NEW.submission_id IS DISTINCT FROM e.submission_id OR NEW.agent_id IS DISTINCT FROM e.agent_id
  OR NEW.approved_access_sha256 IS DISTINCT FROM e.requested_access_sha256
  OR NEW.assessment_snapshot IS DISTINCT FROM jsonb_build_object('version',3,'evaluationId',e.id,'evidenceHash',e.evidence_sha256,'configurationHash',e.configuration_sha256,'requestedAccessHash',e.requested_access_sha256,'evaluated',true,'humanReviewed',false,'policy','readonly-review-v1')
  OR NEW.approval_expires_at IS NULL OR NEW.approval_expires_at<=clock_timestamp() OR NEW.approval_expires_at>least(clock_timestamp()+interval '24 hours',e.expires_at) THEN RAISE insufficient_privilege; END IF;
  RETURN NEW;
 END IF;
 IF NEW.decision='approved' THEN
  SELECT * INTO e FROM agentonic.evaluation_runs WHERE id=(NEW.assessment_snapshot->>'evaluationId')::uuid AND workspace_id=NEW.workspace_id;
  IF e.id IS NULL OR NEW.submission_id IS DISTINCT FROM e.submission_id OR NEW.agent_id IS DISTINCT FROM e.agent_id OR NEW.approved_access_sha256 IS DISTINCT FROM e.requested_access_sha256
   OR NEW.assessment_snapshot IS DISTINCT FROM jsonb_build_object('version',2,'evaluationId',e.id,'evidenceHash',e.evidence_sha256,'configurationHash',e.configuration_sha256,'requestedAccessHash',e.requested_access_sha256,'evaluated',true,'humanReviewed',true)
   OR NOT agentonic.evaluation_approvable(e) OR NOT agentonic.can_review(e.submission_id,NEW.support_access_grant_id)
   OR NEW.actor_staff_id IS DISTINCT FROM agentonic.current_staff()
   OR NOT EXISTS(SELECT 1 FROM agentonic.platform_staff WHERE id=NEW.actor_staff_id AND role IN ('administrator','operator') AND disabled_at IS NULL)
   OR NEW.approval_expires_at IS NULL OR NEW.approval_expires_at<=clock_timestamp() OR NEW.approval_expires_at>least(clock_timestamp()+interval '24 hours',e.expires_at)
   OR NEW.feedback IS NULL OR length(btrim(NEW.feedback)) NOT BETWEEN 10 AND 2000 THEN RAISE insufficient_privilege; END IF;
 END IF;
 RETURN NEW;
END $$;

-- Close the open reviews of older versions once `approved` has an approval.
-- Returns how many were closed.
CREATE FUNCTION agentonic.supersede_older_reviews(approved uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s agentonic.agent_submissions; n agentonic.configuration_releases; prior record; closed integer:=0;
BEGIN
 SELECT * INTO s FROM agentonic.agent_submissions WHERE id=approved;
 IF s.id IS NULL OR NOT EXISTS(SELECT 1 FROM agentonic.submission_review_decisions WHERE submission_id=s.id AND decision='approved') THEN RETURN 0; END IF;
 SELECT * INTO n FROM agentonic.configuration_releases WHERE id=s.configuration_release_id;
 FOR prior IN SELECT x.id,x.workspace_id,x.agent_id FROM agentonic.agent_submissions x JOIN agentonic.configuration_releases r ON r.id=x.configuration_release_id
  WHERE x.workspace_id=s.workspace_id AND x.agent_id=s.agent_id AND x.id<>s.id AND x.status IN ('submitted','in_review')
  AND (r.created_at,r.id)<(n.created_at,n.id) ORDER BY x.submission_number FOR UPDATE OF x LOOP
  INSERT INTO agentonic.submission_review_decisions(workspace_id,agent_id,submission_id,decision_number,decision,actor_policy_version,assessment_snapshot)
   SELECT prior.workspace_id,prior.agent_id,prior.id,coalesce(max(decision_number),0)+1,'superseded','superseded-by-approval-v1',jsonb_build_object('version',1,'supersededBy',s.id::text)
   FROM agentonic.submission_review_decisions WHERE submission_id=prior.id;
  UPDATE agentonic.agent_submissions SET status='superseded' WHERE id=prior.id;
  UPDATE agentonic.support_access_grants SET revoked_at=clock_timestamp() WHERE workspace_id=prior.workspace_id AND scope->>'submissionId'=prior.id::text AND revoked_at IS NULL;
  closed:=closed+1;
 END LOOP;
 RETURN closed;
END $$;
CREATE FUNCTION agentonic.supersede_on_approval() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM agentonic.supersede_older_reviews(NEW.id);
 RETURN NULL;
END $$;
CREATE TRIGGER supersede_older_reviews AFTER UPDATE OF status ON agentonic.agent_submissions
 FOR EACH ROW WHEN (NEW.status='approved' AND OLD.status IS DISTINCT FROM 'approved') EXECUTE FUNCTION agentonic.supersede_on_approval();

-- Reviews already left behind by an approval, oldest approval first.
DO $$ DECLARE a record; BEGIN
 FOR a IN SELECT d.submission_id FROM agentonic.submission_review_decisions d WHERE d.decision='approved'
  GROUP BY d.submission_id ORDER BY min(d.created_at),d.submission_id LOOP
  PERFORM agentonic.supersede_older_reviews(a.submission_id);
 END LOOP;
END $$;

-- The evaluation half of can_record_review_decision (migration 19), without
-- the review grant, so the queue can say whether a decision is possible now.
CREATE FUNCTION agentonic.review_decision_ready(target uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE p agentonic.evaluation_preparations;e agentonic.evaluation_runs;
BEGIN
 SELECT * INTO p FROM agentonic.evaluation_preparations WHERE submission_id=target AND workspace_id=agentonic.workspace_id() ORDER BY created_at DESC,id DESC LIMIT 1;
 IF p.id IS NOT NULL THEN
  SELECT * INTO e FROM agentonic.evaluation_runs WHERE id=p.evaluation_id;
  RETURN coalesce(p.confirmed_at IS NOT NULL AND p.status IN ('needs_changes','needs_attention') AND agentonic.preparation_authorized(p,true) AND agentonic.preparation_sources_current(p) AND e.status IN ('passed','failed') AND agentonic.evaluation_authorized(e,true) AND agentonic.evaluation_sources_current(e),false);
 END IF;
 SELECT * INTO e FROM agentonic.evaluation_runs WHERE submission_id=target AND workspace_id=agentonic.workspace_id() ORDER BY created_at DESC,id DESC LIMIT 1;
 RETURN coalesce(e.status IN ('passed','failed') AND agentonic.evaluation_authorized(e,true) AND agentonic.evaluation_sources_current(e),false);
END $$;
CREATE OR REPLACE FUNCTION agentonic.can_record_review_decision(submission_id uuid,grant_id uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF agentonic.application_role()<>'agentonic_admin' OR NOT agentonic.can_review(submission_id,grant_id) THEN RETURN false; END IF;
 RETURN agentonic.review_decision_ready(submission_id);
END $$;

-- The queue as in migration 50, plus canDecide.
CREATE OR REPLACE FUNCTION agentonic.review_queue() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE row jsonb;state jsonb;result jsonb:='[]';approval jsonb;deployment jsonb;
BEGIN
 FOR row IN SELECT value FROM jsonb_array_elements(agentonic.review_queue_before_deployments()) LOOP
  state:=agentonic.lifecycle_state((row->>'id')::uuid);
  SELECT value INTO approval FROM jsonb_array_elements(state->'submissions') WHERE value->>'id'=row->>'id';
  SELECT value INTO deployment FROM jsonb_array_elements(state->'deployments') WHERE value->>'submissionId'=row->>'id' LIMIT 1;
  result:=result||jsonb_build_array(row||jsonb_build_object('agentId',state->'agentId','approvalReason',approval->>'reason','approvalExpiresAt',approval->'expiresAt',
   'canDecide',coalesce((row->>'canOpen')::boolean,false) AND agentonic.review_decision_ready((row->>'id')::uuid),
   'deploymentStatus',coalesce(CASE WHEN deployment->>'status'='running' THEN CASE WHEN deployment->>'online'='true' THEN 'running' ELSE 'offline' END ELSE deployment->>'status' END,'none'))
   ||CASE WHEN deployment IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('deploymentEnvironment',deployment->'environment',
    'deploymentAuthorized',deployment->'authorized','consentExpiresAt',deployment->'expiresAt') END);
 END LOOP;
 RETURN result;
END $$;

-- The Admin agent page as in migration 50, plus Google Drive.
CREATE OR REPLACE FUNCTION agentonic.operations_agent(target uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM agentonic.operations_staff();
 RETURN (SELECT jsonb_build_object(
  'id',a.id,'name',a.name,'workspaceId',w.id,'workspaceName',w.name,'ownerName',u.display_name,'createdAt',a.created_at,
  'latestVersion',(SELECT count(*)::int FROM agentonic.configuration_releases r WHERE r.agent_id=a.id),
  'tools',jsonb_build_object(
   'gmail',coalesce(EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(latest.access->'tools','[]')) t WHERE t ? 'connectionId'),false),
   'drive',coalesce(EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(latest.access->'tools','[]')) t WHERE t ? 'driveConnectionId'),false),
   'web',coalesce(EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(latest.access->'tools','[]')) t WHERE t->>'capability'='web'),false),
   'collections',coalesce(jsonb_array_length(latest.access->'collectionIds'),0)),
  'summary',agentonic.agent_version_summary(a.id),
  'proposals',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'number',s.submission_number,
    'versionNumber',agentonic.release_number(s.configuration_release_id),'status',s.status,'submittedAt',s.submitted_at,
    'approvalReason',CASE WHEN d.id IS NULL THEN NULL ELSE agentonic.approval_reason(d.id) END,'approvalExpiresAt',d.approval_expires_at)
    ORDER BY s.submission_number DESC)
   FROM agentonic.agent_submissions s
   LEFT JOIN LATERAL(SELECT x.id,x.approval_expires_at FROM agentonic.submission_review_decisions x WHERE x.submission_id=s.id AND x.decision='approved' ORDER BY x.decision_number DESC LIMIT 1) d ON true
   WHERE s.agent_id=a.id),'[]'::jsonb),
  'deployments',coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'submissionId',d.submission_id,'environment',d.environment,
    'status',CASE WHEN d.status IN ('awaiting_activation','queued','preparing','running') AND NOT agentonic.deployment_authorized(d) THEN 'unauthorized'
     WHEN d.status='running' THEN CASE WHEN agentonic.deployment_online(d) THEN 'running' ELSE 'offline' END ELSE d.status END,
    'resting',d.resting_since IS NOT NULL,'versionNumber',agentonic.release_number(d.configuration_release_id),'authorizedUntil',d.authorized_until,
    'budgetUsd',d.budget_usd,'spentUsd',round(d.committed_microusd::numeric/1000000,6),'createdAt',d.created_at,'activatedAt',d.activated_at)
    ORDER BY d.created_at DESC) FROM agentonic.deployments d WHERE d.agent_id=a.id),'[]'::jsonb),
  'activity',jsonb_build_object(
   'lastRunAt',(SELECT max(r.created_at) FROM agentonic.agent_runs r WHERE r.agent_id=a.id),
   'runs7d',(SELECT count(*) FROM agentonic.agent_runs r WHERE r.agent_id=a.id AND r.created_at>clock_timestamp()-interval '7 days'),
   'failed7d',(SELECT count(*) FROM agentonic.agent_runs r WHERE r.agent_id=a.id AND r.status IN ('failed','timed_out') AND r.created_at>clock_timestamp()-interval '7 days'),
   'knownUsd30d',(SELECT coalesce(sum(e.provider_cost_usd),0) FROM agentonic.usage_events e WHERE e.agent_id=a.id AND e.occurred_at>clock_timestamp()-interval '30 days')))
 FROM agentonic.agents a JOIN agentonic.workspaces w ON w.id=a.workspace_id AND w.deleted_at IS NULL
 JOIN agentonic.workspace_members m ON m.id=a.owner_member_id JOIN agentonic.users u ON u.id=m.user_id
 LEFT JOIN LATERAL (SELECT r.requested_access_snapshot access FROM agentonic.configuration_releases r WHERE r.agent_id=a.id ORDER BY r.created_at DESC LIMIT 1) latest ON true
 WHERE a.id=target);
END $$;

-- Ver usuario: a person's name, email and memberships, with the agents they
-- own and the reviews they sent in each workspace. Null for an unknown user.
-- The email is the one Revisiones already shows.
CREATE FUNCTION agentonic.operations_user(target uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM agentonic.operations_staff();
 RETURN (SELECT jsonb_build_object(
  'id',u.id,
  'name',CASE WHEN u.deleted_at IS NULL THEN u.display_name ELSE 'Usuario eliminado' END,
  'email',CASE WHEN u.deleted_at IS NULL THEN coalesce(u.email,agentonic_bootstrap.review_user_email(u.auth_user_id)) END,
  'createdAt',u.created_at,
  'memberships',coalesce((SELECT jsonb_agg(jsonb_build_object('workspaceId',w.id,'workspaceName',w.name,'role',m.role,'status',m.status,'joinedAt',m.joined_at,
    'agents',(SELECT count(*) FROM agentonic.agents a WHERE a.owner_member_id=m.id AND a.workspace_id=w.id AND a.archived_at IS NULL),
    'reviews',(SELECT count(*) FROM agentonic.agent_submissions s WHERE s.submitted_by_member_id=m.id AND s.workspace_id=w.id))
    ORDER BY m.joined_at,w.name)
   FROM agentonic.workspace_members m JOIN agentonic.workspaces w ON w.id=m.workspace_id AND w.deleted_at IS NULL WHERE m.user_id=u.id),'[]'::jsonb))
 FROM agentonic.users u WHERE u.id=target);
END $$;

REVOKE ALL ON FUNCTION agentonic.supersede_older_reviews(uuid),agentonic.supersede_on_approval(),agentonic.review_decision_ready(uuid),
 agentonic.can_record_review_decision(uuid,uuid),agentonic.review_queue(),agentonic.operations_agent(uuid),agentonic.operations_user(uuid)
 FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure,
 agentonic_runtime_local,agentonic_runtime_azure,agentonic_deployer_local,agentonic_deployer_azure;
GRANT EXECUTE ON FUNCTION agentonic.review_queue(),agentonic.operations_agent(uuid),agentonic.operations_user(uuid) TO agentonic_admin;
COMMIT;
