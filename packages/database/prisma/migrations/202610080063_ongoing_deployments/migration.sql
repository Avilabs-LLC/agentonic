-- Ongoing operating authorization (architecture §59; outstanding actions D5 and
-- D6; owner decisions, 8 October 2026). A running agent people rely on no
-- longer goes dark after a fixed week, or loses its conversations when a new
-- version takes over:
-- - Authorization lasts 30 days and renews automatically, by default, while
--   nothing changed: the same approved version, its sources and cited evidence,
--   the member's access, the runtime and the host (deployment_authorized). A
--   renewal never re-evaluates and never extends an approval's activation
--   deadline. The customer can turn it off, change the period budget, or renew
--   by hand in the last 10 days. Deployments authorized earlier keep their
--   terms until their customer opts in.
-- - Each 30-day period has its own budget (US$1-20 in the app, default 5).
-- - Conversations belong to the agent and the member: when a version the same
--   member authorized takes over, they carry on with it, and each turn records
--   the version that answered. Content lasts 30 days from the last message and
--   is erased only then, when the person closes it, or on revocation or
--   offboarding. Each function below is its current definition with only the
--   noted change.

ALTER TABLE agentonic.deployments ADD COLUMN auto_renew boolean NOT NULL DEFAULT false,
 ADD COLUMN period_budget_usd numeric(20,8) CHECK(period_budget_usd IS NULL OR period_budget_usd BETWEEN 0.05 AND 20),
 ADD COLUMN period_started_at timestamptz,
 ADD COLUMN period_base_microusd bigint NOT NULL DEFAULT 0 CHECK(period_base_microusd>=0),
 ADD COLUMN renewal_blocked text CHECK(renewal_blocked IS NULL OR renewal_blocked IN ('changed','sources','member','approval','revoked','expired'));
ALTER TABLE agentonic.deployments ALTER COLUMN auto_renew SET DEFAULT true;
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='agentonic.deployments'::regclass AND contype='c'
  AND (pg_get_constraintdef(oid) LIKE '%7 days%' OR pg_get_constraintdef(oid) LIKE '%budget_usd >= 0.05%') LOOP
  EXECUTE format('ALTER TABLE agentonic.deployments DROP CONSTRAINT %I',c.conname);
 END LOOP;
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='agentonic.staging_conversations'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%7 days%' LOOP
  EXECUTE format('ALTER TABLE agentonic.staging_conversations DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE agentonic.deployments ADD CONSTRAINT deployments_window CHECK(authorized_until>created_at), ADD CONSTRAINT deployments_budget CHECK(budget_usd>0);
ALTER TABLE agentonic.staging_conversations ADD CONSTRAINT staging_conversations_window CHECK(expires_at>created_at);
CREATE TABLE agentonic.deployment_renewals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,
 deployment_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('automatic','manual')),
 renewed_by_member_id uuid,
 previous_until timestamptz NOT NULL,
 authorized_until timestamptz NOT NULL,
 period_budget_usd numeric(20,8) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,deployment_id) REFERENCES agentonic.deployments(workspace_id,id),
 FOREIGN KEY(workspace_id,renewed_by_member_id) REFERENCES agentonic.workspace_members(workspace_id,id),
 CHECK((kind='manual')=(renewed_by_member_id IS NOT NULL)),
 CHECK(authorized_until>previous_until)
);
ALTER TABLE agentonic.deployment_renewals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.deployment_renewals FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure,agentonic_deployer_local,agentonic_deployer_azure,agentonic_runtime_local,agentonic_runtime_azure;
ALTER TABLE agentonic.staging_turns ADD COLUMN deployment_id uuid;
UPDATE agentonic.staging_turns t SET deployment_id=c.deployment_id FROM agentonic.staging_conversations c WHERE c.id=t.conversation_id;

CREATE OR REPLACE FUNCTION agentonic.deployment_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Deployment history is retained'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','desired_state','service_token_sha256','generation','committed_microusd','requested_by_staff_id','activated_at','heartbeat_at','error_code','manifest_sha256','revoked_at',
  'broker_sha256','successor_broker_sha256','successor_token_sha256','draining_broker_sha256','draining_token_sha256','draining_since','resting_since',
  'authorized_until','budget_usd','auto_renew','period_budget_usd','period_started_at','period_base_microusd','renewal_blocked'])
 IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','desired_state','service_token_sha256','generation','committed_microusd','requested_by_staff_id','activated_at','heartbeat_at','error_code','manifest_sha256','revoked_at',
  'broker_sha256','successor_broker_sha256','successor_token_sha256','draining_broker_sha256','draining_token_sha256','draining_since','resting_since',
  'authorized_until','budget_usd','auto_renew','period_budget_usd','period_started_at','period_base_microusd','renewal_blocked']) THEN RAISE EXCEPTION 'Immutable deployment scope'; END IF;
 IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN RAISE EXCEPTION 'Irreversible deployment revocation'; END IF;
 -- Renewal only extends: the window and the spending ceiling never shrink.
 IF NEW.authorized_until<OLD.authorized_until OR NEW.budget_usd<OLD.budget_usd THEN RAISE EXCEPTION 'Renewal only extends a deployment'; END IF;
 IF OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN RAISE EXCEPTION 'Immutable activation evidence'; END IF;
 IF OLD.requested_by_staff_id IS NOT NULL AND NEW.requested_by_staff_id IS DISTINCT FROM OLD.requested_by_staff_id THEN RAISE EXCEPTION 'Immutable deployment actor'; END IF;
 RETURN NEW;
END $$;

-- Why a deployment could not renew, in terms the customer can act on; NULL
-- while nothing changed.
CREATE FUNCTION agentonic.deployment_change(d agentonic.deployments) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r agentonic.configuration_releases;
BEGIN
 IF d.revoked_at IS NOT NULL THEN RETURN 'revoked'; END IF;
 IF agentonic.deployment_authorized(d) THEN RETURN NULL; END IF;
 IF d.authorized_until<=clock_timestamp() THEN RETURN 'expired'; END IF;
 IF NOT agentonic.member_can_author(d.authorized_by_member_id,d.agent_id) THEN RETURN 'member'; END IF;
 IF NOT EXISTS(SELECT 1 FROM agentonic.submission_review_decisions dec JOIN agentonic.agent_submissions s ON s.id=dec.submission_id
  WHERE dec.id=d.approval_id AND dec.decision='approved' AND s.status='approved'
  AND NOT EXISTS(SELECT 1 FROM agentonic.submission_review_decisions later WHERE later.submission_id=d.submission_id AND later.decision_number>dec.decision_number)) THEN RETURN 'approval'; END IF;
 SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(r.requested_access_snapshot->'collections') col CROSS JOIN LATERAL jsonb_array_elements(col->'sources') src
   WHERE NOT EXISTS(SELECT 1 FROM agentonic.knowledge_sources k WHERE k.id=(src->>'id')::uuid AND k.definition_sha256=src->>'hash' AND k.definition_revision=(src->>'revision')::bigint
    AND k.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(d.evidence_sources) hit WHERE NOT EXISTS(
   SELECT 1 FROM agentonic.document_chunks c JOIN agentonic.document_versions v ON v.id=c.document_version_id JOIN agentonic.documents doc ON doc.id=v.document_id
   WHERE c.id=(hit->>'id')::uuid AND c.content_sha256=hit->>'hash' AND v.status='ready' AND doc.active_version_id=v.id AND doc.deleted_at IS NULL)) THEN RETURN 'sources'; END IF;
 RETURN 'changed';
END $$;

-- One more 30-day period with its own budget, for a running deployment that
-- is still authorized. Callers hold the deployment's row lock.
CREATE FUNCTION agentonic.deployment_renew(d agentonic.deployments,kind text,actor uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE until timestamptz;
BEGIN
 IF d.status<>'running' OR d.desired_state<>'running' OR d.revoked_at IS NOT NULL OR d.period_budget_usd IS NULL OR NOT agentonic.deployment_authorized(d) THEN RETURN false; END IF;
 until:=d.authorized_until+interval '30 days';
 UPDATE agentonic.deployments SET authorized_until=until,period_started_at=d.authorized_until,period_base_microusd=committed_microusd,
  budget_usd=greatest(budget_usd,committed_microusd::numeric/1000000+period_budget_usd),renewal_blocked=NULL WHERE id=d.id;
 INSERT INTO agentonic.deployment_renewals(workspace_id,deployment_id,kind,renewed_by_member_id,previous_until,authorized_until,period_budget_usd)
 VALUES(d.workspace_id,d.id,kind,actor,d.authorized_until,until,d.period_budget_usd);
 RETURN true;
END $$;

-- The knowledge worker renews running deployments in their last three days,
-- or records what changed so the customer and Vencimientos can say why not.
CREATE FUNCTION agentonic.deployment_renewal_tick() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d agentonic.deployments; renewed integer:=0; blocked integer:=0; reason text;
BEGIN
 IF agentonic.application_role()<>'agentonic_worker' THEN RAISE insufficient_privilege; END IF;
 FOR d IN SELECT * FROM agentonic.deployments WHERE status='running' AND desired_state='running' AND auto_renew AND revoked_at IS NULL
  AND authorized_until>clock_timestamp() AND authorized_until<=clock_timestamp()+interval '3 days'
  ORDER BY renewal_blocked IS NOT NULL,authorized_until LIMIT 20 FOR UPDATE SKIP LOCKED LOOP
  PERFORM 1 FROM agentonic.workspaces WHERE id=d.workspace_id FOR SHARE;
  IF agentonic.deployment_renew(d,'automatic',NULL) THEN renewed:=renewed+1;
  ELSE
   reason:=coalesce(agentonic.deployment_change(d),'changed');
   IF d.renewal_blocked IS DISTINCT FROM reason THEN
    UPDATE agentonic.deployments SET renewal_blocked=reason WHERE id=d.id;
    blocked:=blocked+1;
   END IF;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('renewed',renewed,'blocked',blocked);
END $$;

-- A conversation can be read while it is kept: not closed, within 30 days of
-- its last message, its deployment not revoked, its approval not revoked and
-- its member still active. Sending still needs the agent's current, authorized
-- version (staging_conversation_authorized).
CREATE FUNCTION agentonic.staging_conversation_readable(c agentonic.staging_conversations) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(c.id IS NOT NULL AND c.closed_at IS NULL AND c.expires_at>clock_timestamp() AND EXISTS(
  SELECT 1 FROM agentonic.deployments d JOIN agentonic.agent_submissions s ON s.id=d.submission_id JOIN agentonic.workspace_members m ON m.id=c.owner_member_id
  WHERE d.id=c.deployment_id AND d.revoked_at IS NULL AND s.status<>'revoked' AND m.status='active' AND m.removed_at IS NULL),false)
$$;

-- When a version takes over, the conversations of earlier versions of the same
-- agent that its authorizing member owns continue with it.
CREATE FUNCTION agentonic.conversations_follow_agent() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d agentonic.deployments;
BEGIN
 IF NEW.current_deployment_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO d FROM agentonic.deployments WHERE id=NEW.current_deployment_id;
 UPDATE agentonic.staging_conversations c SET deployment_id=d.id
 FROM agentonic.deployments earlier
 WHERE earlier.id=c.deployment_id AND earlier.agent_id=d.agent_id AND earlier.environment=d.environment AND earlier.id<>d.id
  AND c.owner_member_id=d.authorized_by_member_id AND agentonic.staging_conversation_readable(c);
 RETURN NEW;
END $$;
CREATE TRIGGER conversations_follow_agent AFTER INSERT OR UPDATE OF current_deployment_id ON agentonic.agent_environments FOR EACH ROW EXECUTE FUNCTION agentonic.conversations_follow_agent();

-- Each turn records the version that answers it, and keeps its conversation
-- for 30 days from this message.
CREATE FUNCTION agentonic.staging_turn_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 SELECT deployment_id INTO NEW.deployment_id FROM agentonic.staging_conversations WHERE id=NEW.conversation_id;
 UPDATE agentonic.staging_conversations SET expires_at=greatest(expires_at,clock_timestamp()+interval '30 days') WHERE id=NEW.conversation_id;
 RETURN NEW;
END $$;
CREATE TRIGGER staging_turn_version BEFORE INSERT ON agentonic.staging_turns FOR EACH ROW EXECUTE FUNCTION agentonic.staging_turn_version();
-- Conversations still kept move to the new rule: 30 days from their last message.
UPDATE agentonic.staging_conversations c SET expires_at=greatest(c.expires_at,coalesce((SELECT max(t.created_at) FROM agentonic.staging_turns t WHERE t.conversation_id=c.id),c.created_at)+interval '30 days')
WHERE c.closed_at IS NULL AND c.expires_at>clock_timestamp();

-- Fix for migration 60: Chats offer the passing models in the batch's own
-- order. Ordering by run creation time could tie, so the default model changed
-- at random between reads.
CREATE OR REPLACE FUNCTION agentonic.deployment_models(d agentonic.deployments) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce((SELECT jsonb_agg(x.choice ORDER BY x.ord)
 FROM agentonic.submission_review_decisions approval
 JOIN agentonic.evaluation_runs e ON e.id=(approval.assessment_snapshot->>'evaluationId')::uuid AND e.submission_id=d.submission_id
 JOIN agentonic.evaluation_batches b ON b.id=e.batch_id
 CROSS JOIN LATERAL jsonb_array_elements(b.models) WITH ORDINALITY x(choice,ord)
 WHERE approval.id=d.approval_id AND approval.decision='approved'
 AND NOT EXISTS(SELECT 1 FROM agentonic.evaluation_runs other WHERE other.batch_id=b.id AND other.response_model=x.choice->>'model' AND other.status<>'passed')),
 '[{"model":"gpt-4.1-mini-2025-04-14","reasoning":null}]'::jsonb)
$$;

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

CREATE OR REPLACE FUNCTION agentonic.deployment_host(operation text, target_id uuid, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE h agentonic.runtime_hosts;d agentonic.deployments;manifest jsonb;result jsonb;brokers jsonb;
BEGIN
 SELECT * INTO h FROM agentonic.runtime_hosts WHERE database_role=agentonic.application_role() AND broker_sha256=payload->>'brokerHash' AND revoked_at IS NULL AND verified_at>clock_timestamp()-interval '30 days';
 IF h.id IS NULL OR NOT agentonic.broker_live(h.id,h.broker_sha256) THEN RAISE insufficient_privilege; END IF;
 -- 'poll' is the full pass: authority of every active deployment, content cleanup
 -- and broker retirement. 'watch' runs between polls: it rechecks deployments still
 -- starting and lists only active ones, so its cost does not grow with history.
 IF operation IN ('poll','watch') THEN
  UPDATE agentonic.runtime_hosts SET heartbeat_at=clock_timestamp() WHERE id=h.id;
  FOR d IN SELECT * FROM agentonic.deployments WHERE host_id=h.id AND status IN ('awaiting_activation','queued','preparing','running')
   AND (operation='poll' OR status IN ('queued','preparing')) LOOP
   PERFORM 1 FROM agentonic.workspaces WHERE id=d.workspace_id FOR SHARE;
   SELECT * INTO d FROM agentonic.deployments WHERE id=d.id FOR UPDATE;
   IF NOT agentonic.deployment_authorized(d) OR (d.status IN ('queued','preparing') AND NOT agentonic.deployment_activation_allowed(d)) THEN
    UPDATE agentonic.deployments SET desired_state='stopped',status='stopped',service_token_sha256=NULL,error_code='authorization_changed' WHERE id=d.id;
    UPDATE agentonic.agent_environments SET current_deployment_id=NULL WHERE current_deployment_id=d.id;
   END IF;
  END LOOP;
  IF operation='poll' THEN
  -- Content cleanup is independent of service liveness. Reads enforce the same boundary immediately.
  UPDATE agentonic.staging_turns t SET query='',answer=NULL,matches='[]',citations='[]',scrubbed_at=clock_timestamp(),
   status=CASE WHEN t.status IN ('queued','running') THEN 'cancelled' ELSE t.status END,lease_token=NULL,lease_until=NULL
  FROM agentonic.staging_conversations c JOIN agentonic.deployments dep ON dep.id=c.deployment_id
  WHERE t.conversation_id=c.id AND dep.host_id=h.id AND t.scrubbed_at IS NULL
   AND NOT agentonic.staging_conversation_readable(c);
  UPDATE agentonic.staging_conversations c SET title='Conversación cerrada' FROM agentonic.deployments dep WHERE dep.id=c.deployment_id AND dep.host_id=h.id AND NOT agentonic.staging_conversation_readable(c);
  -- Normal succession: an earlier broker no copy runs any longer retires.
  UPDATE agentonic.runtime_host_brokers b SET retired_at=clock_timestamp() WHERE b.host_id=h.id AND b.broker_sha256<>h.broker_sha256 AND b.retired_at IS NULL AND b.revoked_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM agentonic.deployments dep WHERE dep.host_id=h.id AND dep.status IN ('preparing','running')
    AND b.broker_sha256 IN (dep.broker_sha256,dep.successor_broker_sha256,dep.draining_broker_sha256));
  END IF;
  -- A resting deployment runs no copy; 'pending' tells the controller a turn waits for one.
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',dep.id,'workspaceId',dep.workspace_id,'agentId',dep.agent_id,'environment',dep.environment,'status',dep.status,'desired',dep.desired_state,'heartbeatAt',dep.heartbeat_at,
   'broker',dep.broker_sha256,'successorBroker',dep.successor_broker_sha256,'drainingBroker',dep.draining_broker_sha256,'drainingSince',dep.draining_since,'resting',dep.resting_since IS NOT NULL,
   'pending',CASE WHEN dep.status='running' AND dep.desired_state='running' THEN agentonic.deployment_pending(dep.id) ELSE false END) ORDER BY dep.created_at),'[]') INTO result
   FROM agentonic.deployments dep WHERE dep.host_id=h.id AND (operation='poll' OR dep.status IN ('queued','preparing','running'));
  SELECT coalesce(jsonb_agg(jsonb_build_object('sha256',broker_sha256,'live',retired_at IS NULL AND revoked_at IS NULL) ORDER BY installed_at),'[]') INTO brokers
   FROM agentonic.runtime_host_brokers WHERE host_id=h.id;
  RETURN jsonb_build_object('ok',true,'deployments',result,'brokers',brokers);
 END IF;
 SELECT * INTO d FROM agentonic.deployments WHERE id=target_id AND host_id=h.id;
 IF d.id IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=d.workspace_id FOR SHARE;
 SELECT * INTO d FROM agentonic.deployments WHERE id=target_id FOR UPDATE;
 IF operation='fail' THEN
  IF d.status IN ('queued','preparing') THEN
   UPDATE agentonic.deployments SET status='failed',desired_state='stopped',service_token_sha256=NULL,error_code='installation_failed' WHERE id=d.id;
  END IF;
  RETURN '{"ok":true}';
 ELSIF operation='prepare' THEN
  IF d.status<>'queued' OR d.desired_state<>'running' OR NOT agentonic.deployment_authorized(d) OR NOT agentonic.deployment_activation_allowed(d)
   OR payload->>'tokenHash' IS NULL OR payload->>'tokenHash' !~ '^[a-f0-9]{64}$' THEN RAISE insufficient_privilege; END IF;
  manifest:=agentonic.deployment_manifest(d);
  UPDATE agentonic.deployments SET status='preparing',generation=generation+1,service_token_sha256=payload->>'tokenHash',broker_sha256=h.broker_sha256,
   manifest_sha256=agentonic.content_hash(manifest),heartbeat_at=clock_timestamp() WHERE id=d.id;
  RETURN jsonb_build_object('ok',true,'manifest',manifest,'manifestJson',manifest::text,'manifestHash',agentonic.content_hash(manifest),
   'configurationJson',(SELECT content::text FROM agentonic.configuration_releases WHERE id=d.configuration_release_id),'configuration',(SELECT content FROM agentonic.configuration_releases WHERE id=d.configuration_release_id));
 ELSIF operation IN ('move','restore') THEN
  -- A running deployment gets a new copy on the current broker from the same
  -- frozen manifest. 'move' keeps the serving copy until the successor is
  -- ready (one move per host at a time); 'restore' replaces a copy that can no
  -- longer run (its broker was revoked or its installation is gone) at once.
  IF d.status<>'running' OR d.desired_state<>'running' OR NOT agentonic.deployment_authorized(d)
   OR payload->>'tokenHash' IS NULL OR payload->>'tokenHash' !~ '^[a-f0-9]{64}$' THEN RAISE insufficient_privilege; END IF;
  manifest:=agentonic.deployment_manifest(d);
  IF agentonic.content_hash(manifest) IS DISTINCT FROM d.manifest_sha256 THEN RAISE insufficient_privilege; END IF;
  IF operation='move' THEN
   IF d.broker_sha256 IS NULL OR d.broker_sha256=h.broker_sha256 OR d.successor_token_sha256 IS NOT NULL OR d.draining_token_sha256 IS NOT NULL
    OR EXISTS(SELECT 1 FROM agentonic.deployments other WHERE other.host_id=h.id AND other.id<>d.id AND other.successor_token_sha256 IS NOT NULL) THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.deployments SET successor_broker_sha256=h.broker_sha256,successor_token_sha256=payload->>'tokenHash' WHERE id=d.id;
  ELSE
   UPDATE agentonic.deployments SET service_token_sha256=payload->>'tokenHash',broker_sha256=h.broker_sha256,generation=generation+1,
    successor_broker_sha256=NULL,successor_token_sha256=NULL,draining_broker_sha256=NULL,draining_token_sha256=NULL,draining_since=NULL,resting_since=NULL WHERE id=d.id;
   INSERT INTO agentonic.audit_events(workspace_id,action,resource_type,resource_id,outcome,request_id)
    VALUES(d.workspace_id,'deployment.restored','deployment',d.id::text,'succeeded',gen_random_uuid()::text);
  END IF;
  RETURN jsonb_build_object('ok',true,'manifest',manifest,'manifestJson',manifest::text,'manifestHash',agentonic.content_hash(manifest),
   'configurationJson',(SELECT content::text FROM agentonic.configuration_releases WHERE id=d.configuration_release_id),'configuration',(SELECT content FROM agentonic.configuration_releases WHERE id=d.configuration_release_id));
 ELSIF operation='wake' THEN
  -- The controller starts a resting copy for a waiting turn and vouches for it for one
  -- heartbeat interval. A copy that never reports goes offline like any silent copy.
  IF d.status<>'running' OR d.desired_state<>'running' THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.deployments SET resting_since=NULL,heartbeat_at=clock_timestamp() WHERE id=d.id AND resting_since IS NOT NULL;
  RETURN '{"ok":true}';
 ELSIF operation='abandon' THEN
  -- The successor did not become ready; the serving copy keeps serving.
  UPDATE agentonic.deployments SET successor_broker_sha256=NULL,successor_token_sha256=NULL WHERE id=d.id;
  RETURN '{"ok":true}';
 ELSIF operation='drained' THEN
  UPDATE agentonic.deployments SET draining_broker_sha256=NULL,draining_token_sha256=NULL,draining_since=NULL WHERE id=d.id;
  RETURN '{"ok":true}';
 END IF;
 RAISE insufficient_privilege;
END $function$;

CREATE OR REPLACE FUNCTION agentonic.staging_chat(operation text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();c agentonic.staging_conversations;d agentonic.deployments;t agentonic.staging_turns;n integer;items jsonb;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR w IS NULL OR m IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 IF operation='list' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',c1.id,'agentId',c1.agent_id,'agentName',a.name,'deploymentId',c1.deployment_id,'title',c1.title,'expiresAt',c1.expires_at) ORDER BY c1.created_at DESC),'[]') INTO items
   FROM agentonic.staging_conversations c1 JOIN agentonic.agents a ON a.id=c1.agent_id WHERE c1.workspace_id=w AND c1.owner_member_id=m AND agentonic.staging_conversation_readable(c1) AND agentonic.can_agent(c1.agent_id,'invoke');
  RETURN jsonb_build_object('ok',true,'conversations',items,'agents',coalesce((SELECT jsonb_agg(jsonb_build_object('id',dep.id,'agentId',dep.agent_id,'name',a.name,'environment',dep.environment)) FROM agentonic.deployments dep JOIN agentonic.agents a ON a.id=dep.agent_id WHERE dep.workspace_id=w AND dep.authorized_by_member_id=m AND dep.status='running' AND agentonic.deployment_online(dep) AND agentonic.deployment_authorized(dep) AND agentonic.can_agent(dep.agent_id,'invoke')),'[]'::jsonb));
 ELSIF operation='start' THEN
  SELECT * INTO d FROM agentonic.deployments WHERE id=(payload->>'deploymentId')::uuid AND workspace_id=w AND authorized_by_member_id=m;
  IF d.id IS NULL OR d.status<>'running' OR NOT agentonic.deployment_online(d) OR NOT agentonic.deployment_authorized(d) OR NOT agentonic.can_agent(d.agent_id,'invoke') THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
  IF (SELECT count(*) FROM agentonic.staging_conversations WHERE owner_member_id=m AND created_at>clock_timestamp()-interval '1 minute')>=5 THEN RETURN '{"ok":false,"code":"rate_limit"}'; END IF;
  INSERT INTO agentonic.staging_conversations(workspace_id,agent_id,deployment_id,owner_member_id,title,expires_at)
   VALUES(w,d.agent_id,d.id,m,btrim(payload->>'title'),clock_timestamp()+interval '30 days') RETURNING * INTO c;
  RETURN jsonb_build_object('ok',true,'id',c.id);
 END IF;
 SELECT * INTO c FROM agentonic.staging_conversations WHERE id=(payload->>'conversationId')::uuid AND workspace_id=w AND owner_member_id=m FOR UPDATE;
 IF c.id IS NULL OR NOT agentonic.can_agent(c.agent_id,'invoke') THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
 IF operation='close' THEN
  UPDATE agentonic.staging_conversations SET closed_at=clock_timestamp() WHERE id=c.id;
  UPDATE agentonic.staging_turns SET query='',answer=NULL,citations='[]',matches='[]',scrubbed_at=clock_timestamp(),status=CASE WHEN status IN ('queued','running') THEN 'cancelled' ELSE status END,lease_token=NULL,lease_until=NULL WHERE conversation_id=c.id;
  RETURN '{"ok":true}';
 END IF;
 IF NOT agentonic.staging_conversation_readable(c) THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
 SELECT * INTO d FROM agentonic.deployments WHERE id=c.deployment_id;
 IF operation='turn' THEN
  IF NOT agentonic.staging_conversation_authorized(c) THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
  payload:=jsonb_build_object('model',agentonic.deployment_models(d)->0->>'model','reasoning',agentonic.deployment_models(d)->0->'reasoning')||payload;
  IF NOT agentonic.deployment_models(d) @> jsonb_build_array(jsonb_build_object('model',payload->>'model','reasoning',payload->'reasoning')) THEN RAISE insufficient_privilege; END IF;
  IF NOT agentonic.deployment_online(d) THEN RETURN '{"ok":false,"code":"offline"}'; END IF;
  SELECT * INTO t FROM agentonic.staging_turns WHERE conversation_id=c.id AND request_id=(payload->>'requestId')::uuid;
  IF t.id IS NOT NULL THEN
   IF t.query IS DISTINCT FROM btrim(payload->>'query') OR t.response_model IS DISTINCT FROM payload->>'model' OR t.reasoning_effort IS DISTINCT FROM payload->>'reasoning' THEN RETURN '{"ok":false,"code":"request_conflict"}'; END IF;
   RETURN jsonb_build_object('ok',true,'id',t.id); END IF;
  IF EXISTS(SELECT 1 FROM agentonic.staging_turns WHERE conversation_id=c.id AND status IN ('queued','running')) THEN RETURN '{"ok":false,"code":"busy"}'; END IF;
  IF length(btrim(payload->>'query')) NOT BETWEEN 1 AND 1000 OR payload->>'query' IS NULL THEN RAISE insufficient_privilege; END IF;
  SELECT coalesce(max(number),0)+1 INTO n FROM agentonic.staging_turns WHERE conversation_id=c.id;
  IF n>100 THEN RETURN '{"ok":false,"code":"turn_limit"}'; END IF;
  IF (SELECT count(*) FROM agentonic.staging_turns t1 JOIN agentonic.staging_conversations c1 ON c1.id=t1.conversation_id WHERE c1.owner_member_id=m AND t1.created_at>clock_timestamp()-interval '1 minute')>=10 THEN RETURN '{"ok":false,"code":"rate_limit"}'; END IF;
  INSERT INTO agentonic.staging_turns(workspace_id,conversation_id,request_id,number,query,response_model,reasoning_effort) VALUES(w,c.id,(payload->>'requestId')::uuid,n,btrim(payload->>'query'),payload->>'model',payload->>'reasoning') RETURNING * INTO t;
  RETURN jsonb_build_object('ok',true,'id',t.id);
 ELSIF operation='state' THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',t1.id,'number',t1.number,'model',t1.response_model,'reasoning',t1.reasoning_effort,'query',t1.query,'answer',t1.answer,'citations',t1.citations,'status',t1.status,'errorCode',t1.error_code,
   'version',(SELECT count(*)::int FROM agentonic.deployments dep JOIN agentonic.configuration_releases r ON r.id=dep.configuration_release_id JOIN agentonic.configuration_releases v ON v.agent_id=r.agent_id AND (v.created_at,v.id)<=(r.created_at,r.id) WHERE dep.id=coalesce(t1.deployment_id,c.deployment_id))) ORDER BY t1.number),'[]') INTO items FROM agentonic.staging_turns t1 WHERE t1.conversation_id=c.id;
  RETURN jsonb_build_object('ok',true,'id',c.id,'title',c.title,'agentId',c.agent_id,'expiresAt',c.expires_at,'canSend',agentonic.staging_conversation_authorized(c),'online',agentonic.deployment_online(d),'budgetUsd',d.budget_usd,'committedMicrousd',d.committed_microusd,'turns',items,'models',agentonic.deployment_models(d));
 END IF;
 RAISE insufficient_privilege;
END $$;

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

CREATE OR REPLACE FUNCTION agentonic.gmail_command_v29(operation text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();aid uuid:=(payload->>'agentId')::uuid;
 s agentonic.gmail_oauth_states;c agentonic.gmail_connections;i agentonic.gmail_invocations;conv agentonic.staging_conversations;d agentonic.deployments;r agentonic.configuration_releases;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR w IS NULL OR m IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 -- Expired private proposals are erased; only content-free audit remains.
 UPDATE agentonic.gmail_invocations SET status=CASE WHEN status='pending' THEN 'expired' WHEN status='executing' THEN 'uncertain' ELSE status END,arguments_ciphertext=NULL
 WHERE workspace_id=w AND expires_at<=clock_timestamp() AND arguments_ciphertext IS NOT NULL;
 DELETE FROM agentonic.gmail_oauth_states WHERE workspace_id=w AND expires_at<clock_timestamp()-interval '1 hour';
 IF operation IN ('list','oauth.start','permissions') AND (aid IS NULL OR NOT agentonic.can_agent(aid,'edit')) THEN RAISE insufficient_privilege; END IF;
 IF operation='list' THEN
  RETURN jsonb_build_object('connections',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'account',account,'status',status,'operations',operations) ORDER BY created_at) FROM agentonic.gmail_connections WHERE workspace_id=w AND agent_id=aid AND owner_member_id=m AND status<>'disconnected'),'[]'));
 ELSIF operation='oauth.start' THEN
  IF (SELECT count(*) FROM agentonic.gmail_oauth_states WHERE owner_member_id=m AND expires_at>clock_timestamp())>=5 THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.gmail_oauth_states(state_hash,workspace_id,agent_id,owner_member_id,connection_id,verifier_ciphertext) VALUES(payload->>'state',w,aid,m,(payload->>'connectionId')::uuid,payload->>'verifier'); RETURN '{"ok":true}';
 ELSIF operation IN ('oauth.consume','oauth.finish') THEN
  SELECT * INTO s FROM agentonic.gmail_oauth_states WHERE state_hash=payload->>'state' AND workspace_id=w AND owner_member_id=m FOR UPDATE;
  IF s.state_hash IS NULL OR s.expires_at<=clock_timestamp() OR s.finished_at IS NOT NULL OR NOT agentonic.can_agent(s.agent_id,'edit') THEN RAISE insufficient_privilege; END IF;
  IF operation='oauth.consume' THEN
   IF s.consumed_at IS NOT NULL THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.gmail_oauth_states SET consumed_at=clock_timestamp() WHERE state_hash=s.state_hash;
   RETURN jsonb_build_object('agentId',s.agent_id,'connectionId',s.connection_id,'verifier',s.verifier_ciphertext);
  END IF;
  IF s.consumed_at IS NULL THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.gmail_connections(id,workspace_id,agent_id,owner_member_id,account,credential_ciphertext) VALUES(s.connection_id,w,s.agent_id,m,payload->>'account',payload->>'credential');
  UPDATE agentonic.gmail_oauth_states SET finished_at=clock_timestamp(),verifier_ciphertext='' WHERE state_hash=s.state_hash;
  RETURN jsonb_build_object('agentId',s.agent_id);
 ELSIF operation IN ('disconnect','permissions','credential','reconnect') THEN
  SELECT * INTO c FROM agentonic.gmail_connections WHERE id=(payload->>'connectionId')::uuid AND workspace_id=w AND owner_member_id=m FOR UPDATE;
  IF c.id IS NULL OR NOT agentonic.can_agent(c.agent_id,'edit') THEN RAISE insufficient_privilege; END IF;
  IF operation='disconnect' THEN
   UPDATE agentonic.gmail_connections SET status='disconnected',credential_ciphertext=NULL,operations='[]' WHERE id=c.id;
   UPDATE agentonic.gmail_invocations SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,arguments_ciphertext=NULL WHERE connection_id=c.id;
   RETURN jsonb_build_object('credential',c.credential_ciphertext);
  ELSIF operation='reconnect' THEN
   UPDATE agentonic.gmail_connections SET status='reconnect',credential_ciphertext=NULL,operations='[]' WHERE id=c.id; RETURN '{"ok":true}';
  ELSIF operation='permissions' THEN
   IF c.agent_id<>aid OR c.status<>'connected' OR NOT agentonic.valid_gmail_tools(jsonb_build_array(jsonb_build_object('connectionId',c.id,'operations',payload->'operations'))) AND payload->'operations'<>'[]' THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.gmail_connections SET operations=payload->'operations' WHERE id=c.id; RETURN '{"ok":true}';
  ELSE RAISE insufficient_privilege; END IF;
 ELSIF operation IN ('invocations','inspect','confirm','cancel','complete') THEN
  IF operation='invocations' THEN
   SELECT * INTO conv FROM agentonic.staging_conversations WHERE id=(payload->>'conversationId')::uuid AND workspace_id=w AND owner_member_id=m;
   IF conv.id IS NULL OR NOT agentonic.staging_conversation_readable(conv) THEN RAISE insufficient_privilege; END IF;
   RETURN jsonb_build_object('items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'operation',v.operation,'account',gc.account,'status',v.status,'hash',v.arguments_sha256,'expiresAt',v.expires_at,'argumentsCiphertext',v.arguments_ciphertext,'result',v.result,'automatic',v.approved_by_schedule_id IS NOT NULL) ORDER BY v.created_at) FROM agentonic.gmail_invocations v JOIN agentonic.gmail_connections gc ON gc.id=v.connection_id WHERE v.conversation_id=conv.id AND v.owner_member_id=m AND gc.status='connected'),'[]'));
  END IF;
  SELECT * INTO i FROM agentonic.gmail_invocations WHERE id=(payload->>'id')::uuid AND workspace_id=w AND owner_member_id=m FOR UPDATE;
  IF i.id IS NULL THEN RAISE insufficient_privilege; END IF;
  IF operation='complete' THEN
   IF i.status<>'executing' OR payload->>'status' NOT IN ('succeeded','failed','uncertain') THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.gmail_invocations SET status=payload->>'status',result=payload->'result',finished_at=clock_timestamp(),arguments_ciphertext=NULL WHERE id=i.id; RETURN '{"ok":true}';
  END IF;
  SELECT * INTO conv FROM agentonic.staging_conversations WHERE id=i.conversation_id AND owner_member_id=m;
  SELECT * INTO c FROM agentonic.gmail_connections WHERE id=i.connection_id;
  SELECT * INTO d FROM agentonic.deployments WHERE id=conv.deployment_id;
  SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id;
  IF NOT agentonic.staging_conversation_authorized(conv) OR NOT agentonic.gmail_allowed(c,m,i.agent_id,i.operation)
   OR NOT (r.requested_access_snapshot->'tools') @> jsonb_build_array(jsonb_build_object('connectionId',c.id,'operations',jsonb_build_array(i.operation))) THEN RAISE insufficient_privilege; END IF;
  IF operation='cancel' THEN
   IF i.status<>'pending' THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.gmail_invocations SET status='cancelled',arguments_ciphertext=NULL WHERE id=i.id; RETURN '{"ok":true}';
  END IF;
  IF i.status<>'pending' OR i.expires_at<=clock_timestamp() OR i.arguments_ciphertext IS NULL OR i.arguments_sha256 IS DISTINCT FROM payload->>'hash' OR i.approved_by_schedule_id IS NOT NULL THEN RAISE insufficient_privilege; END IF;
  IF operation='confirm' THEN
   UPDATE agentonic.gmail_invocations SET status='executing',approved_at=clock_timestamp() WHERE id=i.id;
  END IF;
  RETURN jsonb_build_object('credential',c.credential_ciphertext,'connectionId',c.id,'account',c.account,'argumentsCiphertext',i.arguments_ciphertext,'operation',i.operation);
 END IF;
 RAISE insufficient_privilege;
END $$;

CREATE OR REPLACE FUNCTION agentonic.schedule_launch(s agentonic.agent_schedules,slot timestamptz,manual boolean) RETURNS agentonic.agent_schedule_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d agentonic.deployments; c agentonic.staging_conversations; r agentonic.agent_schedule_runs; models jsonb; choice jsonb; n integer; skip text; run_id uuid:=gen_random_uuid(); turn uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM agentonic.workspace_members m JOIN agentonic.workspaces w ON w.id=m.workspace_id WHERE m.id=s.member_id AND m.status='active' AND m.removed_at IS NULL AND w.status='active' AND w.deleted_at IS NULL) THEN skip:='member_inactive';
 ELSIF NOT EXISTS(SELECT 1 FROM agentonic.agents a WHERE a.id=s.agent_id AND a.status<>'archived') THEN skip:='agent_unavailable';
 ELSE
  SELECT * INTO d FROM agentonic.deployments dep WHERE dep.workspace_id=s.workspace_id AND dep.agent_id=s.agent_id AND dep.authorized_by_member_id=s.member_id
   AND dep.status='running' AND agentonic.deployment_authorized(dep) ORDER BY dep.activated_at DESC NULLS LAST,dep.created_at DESC LIMIT 1;
  IF d.id IS NULL THEN skip:='no_deployment';
  ELSIF NOT agentonic.deployment_online(d) THEN skip:='offline';
  END IF;
 END IF;
 IF skip IS NULL THEN
  -- One conversation per schedule and deployment, renewed when it fills or ends.
  SELECT * INTO c FROM agentonic.staging_conversations sc WHERE sc.schedule_id=s.id AND sc.deployment_id=d.id AND sc.closed_at IS NULL AND sc.expires_at>clock_timestamp()+interval '5 minutes'
   AND (SELECT count(*) FROM agentonic.staging_turns t WHERE t.conversation_id=sc.id)<100 AND agentonic.staging_conversation_authorized(sc) ORDER BY sc.created_at DESC LIMIT 1 FOR UPDATE;
  IF c.id IS NULL THEN
   INSERT INTO agentonic.staging_conversations(workspace_id,agent_id,deployment_id,owner_member_id,title,expires_at,schedule_id)
   VALUES(s.workspace_id,s.agent_id,d.id,s.member_id,'Programación: '||btrim(s.name),clock_timestamp()+interval '30 days',s.id) RETURNING * INTO c;
  END IF;
  IF NOT agentonic.staging_conversation_authorized(c) THEN skip:='no_deployment';
  ELSIF EXISTS(SELECT 1 FROM agentonic.staging_turns t WHERE t.conversation_id=c.id AND t.status IN ('queued','running')) THEN skip:='busy';
  END IF;
 END IF;
 IF skip IS NOT NULL THEN
  INSERT INTO agentonic.agent_schedule_runs(id,workspace_id,schedule_id,scheduled_for,manual,status,reason,deployment_id,conversation_id,finished_at)
  VALUES(run_id,s.workspace_id,s.id,slot,manual,'skipped',skip,d.id,c.id,clock_timestamp()) RETURNING * INTO r;
  RETURN r;
 END IF;
 -- The schedule's model when the approved version allows it, else the deployment's first.
 models:=agentonic.deployment_models(d);
 choice:=CASE WHEN models @> jsonb_build_array(jsonb_build_object('model',s.model,'reasoning',s.reasoning)) THEN jsonb_build_object('model',s.model,'reasoning',s.reasoning) ELSE models->0 END;
 SELECT coalesce(max(number),0)+1 INTO n FROM agentonic.staging_turns WHERE conversation_id=c.id;
 INSERT INTO agentonic.staging_turns(workspace_id,conversation_id,request_id,number,query,response_model,reasoning_effort)
 VALUES(s.workspace_id,c.id,run_id,n,agentonic.schedule_message(s),choice->>'model',choice->>'reasoning') RETURNING id INTO turn;
 INSERT INTO agentonic.agent_schedule_runs(id,workspace_id,schedule_id,scheduled_for,manual,status,deployment_id,conversation_id,turn_id)
 VALUES(run_id,s.workspace_id,s.id,slot,manual,'queued',d.id,c.id,turn) RETURNING * INTO r;
 RETURN r;
END $$;

REVOKE ALL ON FUNCTION agentonic.deployment_change(agentonic.deployments),agentonic.deployment_renew(agentonic.deployments,text,uuid),agentonic.deployment_renewal_tick(),
 agentonic.staging_conversation_readable(agentonic.staging_conversations),agentonic.conversations_follow_agent(),agentonic.staging_turn_version()
 FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure,agentonic_deployer_local,agentonic_deployer_azure,agentonic_runtime_local,agentonic_runtime_azure;
GRANT EXECUTE ON FUNCTION agentonic.deployment_renewal_tick() TO agentonic_worker;
