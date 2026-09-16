BEGIN;
-- Evaluation-only workers have separate credentials. Registration/attestation is
-- migration-authority-only; neither a web client nor the ordinary Mac worker can
-- label its own output as Azure evidence. No provider allowances are changed.
CREATE TABLE agentonic.evaluation_workers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), database_role text NOT NULL,
 environment text NOT NULL CHECK(environment IN ('local','azure_staging')),
 worker_sha256 text NOT NULL CHECK(worker_sha256 ~ '^[a-f0-9]{64}$'),
 runtime_sha256 text NOT NULL CHECK(runtime_sha256 ~ '^[a-f0-9]{64}$'),
 verified_at timestamptz NOT NULL, verification jsonb NOT NULL,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(database_role IN ('agentonic_eval_local','agentonic_eval_azure')),
 CHECK((database_role='agentonic_eval_azure')=(environment='azure_staging'))
);
CREATE UNIQUE INDEX evaluation_worker_active_role ON agentonic.evaluation_workers(database_role) WHERE revoked_at IS NULL;
CREATE TABLE agentonic.evaluation_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES agentonic.workspaces(id),
 agent_id uuid NOT NULL, submission_id uuid NOT NULL, code_release_id uuid NOT NULL, configuration_release_id uuid NOT NULL,
 requested_by_staff_id uuid NOT NULL REFERENCES agentonic.platform_staff(id), support_access_grant_id uuid NOT NULL,
 authorized_by_member_id uuid, authorized_at timestamptz, consent_revoked_at timestamptz,
 environment text NOT NULL CHECK(environment IN ('local','azure_staging')),
 status text NOT NULL DEFAULT 'awaiting_consent' CHECK(status IN ('awaiting_consent','queued','running','passed','failed','error','cancelled')),
 dataset_snapshot jsonb NOT NULL, dataset_sha256 text NOT NULL,
 grader_snapshot jsonb NOT NULL DEFAULT '{"version":"phrases-citations-v1","threshold":1}', grader_sha256 text NOT NULL,
 configuration_sha256 text NOT NULL, requested_access_sha256 text NOT NULL,
 budget_usd numeric(20,8) NOT NULL CHECK(budget_usd BETWEEN 0.01 AND 1), committed_microusd bigint NOT NULL DEFAULT 0 CHECK(committed_microusd>=0),
 worker_id uuid REFERENCES agentonic.evaluation_workers(id), lease_token uuid, lease_until timestamptz,
 next_case integer NOT NULL DEFAULT 0 CHECK(next_case>=0), current_matches jsonb NOT NULL DEFAULT '[]',
 evidence_sha256 text, error_code text, expires_at timestamptz NOT NULL, started_at timestamptz, finished_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,agent_id,code_release_id,configuration_release_id,submission_id) REFERENCES agentonic.agent_submissions(workspace_id,agent_id,code_release_id,configuration_release_id,id),
 FOREIGN KEY(workspace_id,requested_by_staff_id,support_access_grant_id) REFERENCES agentonic.support_access_grants(workspace_id,staff_id,id),
 FOREIGN KEY(workspace_id,authorized_by_member_id) REFERENCES agentonic.workspace_members(workspace_id,id),
 CHECK((status='running')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK((authorized_at IS NULL)=(authorized_by_member_id IS NULL)),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '7 days')
);
CREATE TABLE agentonic.evaluation_results (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL,
 evaluation_run_id uuid NOT NULL, case_key text NOT NULL, outcome text NOT NULL CHECK(outcome IN ('passed','failed')),
 answer text NOT NULL, citations jsonb NOT NULL, evidence_sources jsonb NOT NULL,
 checks jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,evaluation_run_id,case_key),
 FOREIGN KEY(workspace_id,evaluation_run_id) REFERENCES agentonic.evaluation_runs(workspace_id,id)
);
CREATE UNIQUE INDEX evaluation_single_active ON agentonic.evaluation_runs(submission_id) WHERE status IN ('awaiting_consent','queued','running');
CREATE INDEX evaluation_claim ON agentonic.evaluation_runs(environment,created_at) WHERE status='queued';
ALTER TABLE agentonic.evaluation_workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentonic.evaluation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentonic.evaluation_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.evaluation_workers,agentonic.evaluation_runs,agentonic.evaluation_results FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;

CREATE FUNCTION agentonic.valid_evaluation_cases(cases jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
#variable_conflict use_column
DECLARE c jsonb; phrase jsonb;
BEGIN
 IF jsonb_typeof(cases) IS DISTINCT FROM 'array' OR jsonb_array_length(cases) NOT BETWEEN 3 AND 20 THEN RETURN false; END IF;
 IF (SELECT count(DISTINCT c->>'key') FROM jsonb_array_elements(cases) c)<>jsonb_array_length(cases) THEN RETURN false; END IF;
 FOR c IN SELECT value FROM jsonb_array_elements(cases) LOOP
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR c-ARRAY['key','question','expectedAnswer','requiredPhrases','forbiddenPhrases','insufficientEvidence']<>'{}'
    OR NOT (c ?& ARRAY['key','question','expectedAnswer','requiredPhrases','forbiddenPhrases','insufficientEvidence'])
    OR c->>'key' !~ '^[a-z0-9_-]{1,40}$' OR jsonb_typeof(c->'key')<>'string'
    OR jsonb_typeof(c->'question')<>'string' OR length(btrim(c->>'question')) NOT BETWEEN 10 AND 1000
    OR jsonb_typeof(c->'expectedAnswer')<>'string' OR length(btrim(c->>'expectedAnswer')) NOT BETWEEN 10 AND 2000
    OR jsonb_typeof(c->'insufficientEvidence')<>'boolean' OR jsonb_typeof(c->'requiredPhrases')<>'array' OR jsonb_typeof(c->'forbiddenPhrases')<>'array'
    OR jsonb_array_length(c->'requiredPhrases')>12 OR jsonb_array_length(c->'forbiddenPhrases')>12
    OR (c->'insufficientEvidence'='false' AND jsonb_array_length(c->'requiredPhrases')=0) THEN RETURN false; END IF;
  FOR phrase IN SELECT value FROM jsonb_array_elements((c->'requiredPhrases')||(c->'forbiddenPhrases')) LOOP
   IF jsonb_typeof(phrase)<>'string' OR length(btrim(phrase#>>'{}')) NOT BETWEEN 2 AND 200 THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(cases) c WHERE c->'insufficientEvidence'='true') AND EXISTS(SELECT 1 FROM jsonb_array_elements(cases) c WHERE c->'insufficientEvidence'='false');
END $$;
ALTER TABLE agentonic.evaluation_runs ADD CHECK(agentonic.valid_evaluation_cases(dataset_snapshot));
ALTER TABLE agentonic.evaluation_runs ADD CHECK(dataset_sha256=agentonic.content_hash(dataset_snapshot) AND grader_sha256=agentonic.content_hash(grader_snapshot) AND grader_snapshot='{"version":"phrases-citations-v1","threshold":1}');

-- This scope helper never trusts caller-set staff/member context. It reads the
-- initiating staff grant and the customer's explicit authorization on this run.
CREATE FUNCTION agentonic.evaluation_authorized(e agentonic.evaluation_runs, require_consent boolean DEFAULT true, allow_approved boolean DEFAULT false) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE s agentonic.agent_submissions; r agentonic.configuration_releases;
BEGIN
 SELECT * INTO s FROM agentonic.agent_submissions WHERE id=e.submission_id AND workspace_id=e.workspace_id;
 SELECT * INTO r FROM agentonic.configuration_releases WHERE id=e.configuration_release_id AND workspace_id=e.workspace_id;
 RETURN e.id IS NOT NULL AND e.expires_at>clock_timestamp() AND e.consent_revoked_at IS NULL
 AND (NOT require_consent OR (e.authorized_by_member_id=s.submitted_by_member_id AND e.authorized_at IS NOT NULL))
 AND (s.status IN ('submitted','in_review') OR (allow_approved AND s.status='approved')) AND (s.review_consent->>'expiresAt')::timestamptz>clock_timestamp()
 AND agentonic.member_can_author(s.submitted_by_member_id,e.agent_id)
 AND r.retired_at IS NULL AND r.content_sha256=e.configuration_sha256 AND r.requested_access_sha256=e.requested_access_sha256
 AND EXISTS(SELECT 1 FROM agentonic.workspaces w WHERE w.id=e.workspace_id AND w.status='active' AND w.deleted_at IS NULL)
 AND EXISTS(SELECT 1 FROM agentonic.support_access_grants g JOIN agentonic.platform_staff st ON st.id=g.staff_id JOIN agentonic.users u ON u.id=st.user_id
 WHERE g.id=e.support_access_grant_id AND g.workspace_id=e.workspace_id AND g.staff_id=e.requested_by_staff_id
 AND g.approved_by_member_id=s.submitted_by_member_id AND g.scope=jsonb_build_object('version',2,'submissionId',s.id::text,'operations',jsonb_build_array('review'))
 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND st.disabled_at IS NULL AND st.role IN ('administrator','operator','support') AND u.deleted_at IS NULL)
 AND EXISTS(SELECT 1 FROM agentonic.code_releases c JOIN agentonic.workspace_code_release_grants g ON g.code_release_id=c.id AND g.workspace_id=e.workspace_id
 JOIN agentonic.code_repositories repo ON repo.id=c.code_repository_id
 WHERE c.id=e.code_release_id AND c.retired_at IS NULL AND c.revoked_at IS NULL AND g.revoked_at IS NULL AND repo.provisioning_status='ready'
 AND (repo.visibility='platform' OR repo.workspace_id=e.workspace_id) AND c.execution_manifest->>'previewContract'='1')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.requested_access_snapshot->'collectionIds') c(id) WHERE NOT agentonic.member_can_collection(s.submitted_by_member_id,c.id::uuid,'read'))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.requested_access_snapshot->'collections') c CROSS JOIN LATERAL jsonb_array_elements(c->'sources') src
 WHERE NOT EXISTS(SELECT 1 FROM agentonic.knowledge_sources k JOIN agentonic.workspace_members m ON m.id=k.authorized_by_member_id JOIN agentonic.users u ON u.id=m.user_id
 WHERE k.id=(src->>'id')::uuid AND k.workspace_id=e.workspace_id AND k.collection_id=(c->>'id')::uuid AND k.definition_sha256=src->>'hash' AND k.definition_revision=(src->>'revision')::bigint
 AND k.environment='staging' AND k.kind='upload' AND k.access_mode='collection' AND k.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb
 AND m.status='active' AND m.removed_at IS NULL AND u.deleted_at IS NULL AND agentonic.member_can_collection(m.id,k.collection_id,'curate')));
END $$;
CREATE FUNCTION agentonic.evaluation_sources_current(e agentonic.evaluation_runs) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT NOT EXISTS(SELECT 1 FROM agentonic.evaluation_results result CROSS JOIN LATERAL jsonb_array_elements(result.evidence_sources) hit
 WHERE result.evaluation_run_id=e.id AND NOT EXISTS(SELECT 1 FROM agentonic.document_chunks c JOIN agentonic.document_versions v ON v.id=c.document_version_id JOIN agentonic.documents d ON d.id=v.document_id
 WHERE c.id=(hit->>'id')::uuid AND c.workspace_id=e.workspace_id AND c.content_sha256=hit->>'hash' AND v.status='ready' AND d.active_version_id=v.id AND d.deleted_at IS NULL))
$$;
CREATE FUNCTION agentonic.evaluation_approvable(e agentonic.evaluation_runs, allow_approved boolean DEFAULT false) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT e.status='passed' AND e.environment='azure_staging' AND e.finished_at>clock_timestamp()-interval '24 hours'
 AND agentonic.evaluation_authorized(e,true,allow_approved) AND agentonic.evaluation_sources_current(e)
 AND e.evidence_sha256 IS NOT NULL AND EXISTS(SELECT 1 FROM agentonic.evaluation_workers worker JOIN agentonic.code_releases c ON c.id=e.code_release_id
 WHERE worker.id=e.worker_id AND worker.environment='azure_staging' AND worker.revoked_at IS NULL AND worker.verified_at>clock_timestamp()-interval '7 days'
 AND worker.runtime_sha256=c.artifact_sha256 AND worker.verification @> '{"isolation":true,"recovery":true,"artifactIntegrity":true}')
 AND (SELECT count(*) FROM agentonic.evaluation_results result WHERE result.evaluation_run_id=e.id AND result.outcome='passed')=jsonb_array_length(e.dataset_snapshot)
$$;

CREATE FUNCTION agentonic.version_approval_valid(decision_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM agentonic.submission_review_decisions d
 JOIN agentonic.agent_submissions s ON s.id=d.submission_id AND s.workspace_id=d.workspace_id
 JOIN agentonic.evaluation_runs e ON e.id=(d.assessment_snapshot->>'evaluationId')::uuid AND e.submission_id=s.id
 JOIN agentonic.platform_staff st ON st.id=d.actor_staff_id JOIN agentonic.users u ON u.id=st.user_id
 WHERE d.id=decision_id AND d.decision='approved' AND s.status='approved' AND d.approval_expires_at>clock_timestamp()
 AND st.disabled_at IS NULL AND st.role IN ('administrator','operator') AND u.deleted_at IS NULL
 AND d.approved_access_sha256=e.requested_access_sha256 AND d.assessment_snapshot->>'evidenceHash'=e.evidence_sha256
 AND NOT EXISTS(SELECT 1 FROM agentonic.submission_review_decisions later WHERE later.submission_id=s.id AND later.decision_number>d.decision_number)
 AND agentonic.evaluation_approvable(e,true))
$$;

CREATE FUNCTION agentonic.evaluation_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_TABLE_NAME='evaluation_workers' THEN
  IF TG_OP='DELETE' OR to_jsonb(NEW)-'revoked_at' IS DISTINCT FROM to_jsonb(OLD)-'revoked_at' OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN RAISE EXCEPTION 'Immutable worker attestation'; END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='evaluation_results' THEN RAISE EXCEPTION 'Immutable evaluation result'; END IF;
 IF to_jsonb(NEW)-ARRAY['status','authorized_by_member_id','authorized_at','consent_revoked_at','committed_microusd','worker_id','lease_token','lease_until','next_case','current_matches','evidence_sha256','error_code','started_at','finished_at']
 IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','authorized_by_member_id','authorized_at','consent_revoked_at','committed_microusd','worker_id','lease_token','lease_until','next_case','current_matches','evidence_sha256','error_code','started_at','finished_at'] THEN RAISE EXCEPTION 'Immutable evaluation specification'; END IF;
 IF OLD.authorized_at IS NOT NULL AND (NEW.authorized_at IS DISTINCT FROM OLD.authorized_at OR NEW.authorized_by_member_id IS DISTINCT FROM OLD.authorized_by_member_id) THEN RAISE EXCEPTION 'Immutable consent'; END IF;
 IF OLD.consent_revoked_at IS NOT NULL AND NEW.consent_revoked_at IS DISTINCT FROM OLD.consent_revoked_at THEN RAISE EXCEPTION 'Irreversible consent revocation'; END IF;
 IF OLD.worker_id IS NOT NULL AND NEW.worker_id IS DISTINCT FROM OLD.worker_id THEN RAISE EXCEPTION 'Immutable execution worker'; END IF;
 IF OLD.status IN ('passed','failed','error','cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN RAISE EXCEPTION 'Terminal evaluation'; END IF;
 IF OLD.evidence_sha256 IS NOT NULL AND NEW.evidence_sha256 IS DISTINCT FROM OLD.evidence_sha256 THEN RAISE EXCEPTION 'Immutable evaluation evidence'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER evaluation_worker_immutable BEFORE UPDATE OR DELETE ON agentonic.evaluation_workers FOR EACH ROW EXECUTE FUNCTION agentonic.evaluation_immutable();
CREATE TRIGGER evaluation_specification BEFORE UPDATE ON agentonic.evaluation_runs FOR EACH ROW EXECUTE FUNCTION agentonic.evaluation_immutable();
CREATE TRIGGER evaluation_result_immutable BEFORE UPDATE OR DELETE ON agentonic.evaluation_results FOR EACH ROW EXECUTE FUNCTION agentonic.evaluation_immutable();

-- Remove only the earlier blanket approval closure, then replace it with an
-- evidence-bound insert gate. Applied migrations and historical decisions stay intact.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='agentonic.submission_review_decisions'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%approval_expires_at IS NULL%' AND pg_get_constraintdef(oid) LIKE '%approved_access_sha256 IS NULL%' LOOP
 EXECUTE format('ALTER TABLE agentonic.submission_review_decisions DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE agentonic.submission_review_decisions ADD CONSTRAINT approval_fields CHECK(decision='approved' OR (approval_expires_at IS NULL AND approved_access_sha256 IS NULL));
CREATE FUNCTION agentonic.validate_version_approval() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE e agentonic.evaluation_runs;
BEGIN
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
CREATE TRIGGER version_approval_evidence BEFORE INSERT ON agentonic.submission_review_decisions FOR EACH ROW EXECUTE FUNCTION agentonic.validate_version_approval();

CREATE FUNCTION agentonic.evaluation_command(operation text,payload jsonb,trace_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=agentonic.workspace_id(); staff uuid:=agentonic.current_staff(); member uuid:=agentonic.current_member();
 s agentonic.agent_submissions; e agentonic.evaluation_runs; r agentonic.configuration_releases; result_id uuid; grant_id uuid; allowed text[];
BEGIN
 IF agentonic.actor_user_id() IS NULL OR w IS NULL OR trace_id IS NULL OR agentonic.application_role() NOT IN ('agentonic_admin','agentonic_customer') THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 allowed:=CASE operation WHEN 'plan' THEN ARRAY['submissionId','grantId','cases','environment','budgetUsd'] WHEN 'authorize' THEN ARRAY['evaluationId','datasetHash','consent'] WHEN 'cancel' THEN ARRAY['evaluationId'] WHEN 'approve' THEN ARRAY['evaluationId','grantId','evidenceHash','reviewed','feedback'] WHEN 'revoke' THEN ARRAY['submissionId','feedback'] END;
 IF allowed IS NULL OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR payload-allowed<>'{}' OR NOT (payload ?& allowed) THEN RAISE insufficient_privilege; END IF;
 IF operation='plan' THEN
  SELECT * INTO s FROM agentonic.agent_submissions WHERE id=(payload->>'submissionId')::uuid AND workspace_id=w FOR UPDATE;
  grant_id:=(payload->>'grantId')::uuid;
  IF staff IS NULL OR NOT agentonic.can_review(s.id,grant_id) OR NOT agentonic.valid_evaluation_cases(payload->'cases') OR payload->>'environment' NOT IN ('local','azure_staging') OR (payload->>'budgetUsd')::numeric NOT BETWEEN 0.01 AND 1 THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO r FROM agentonic.configuration_releases WHERE id=s.configuration_release_id;
  IF NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=r.code_release_id AND execution_manifest->>'previewContract'='1') THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.evaluation_runs(workspace_id,agent_id,submission_id,code_release_id,configuration_release_id,requested_by_staff_id,support_access_grant_id,environment,dataset_snapshot,dataset_sha256,grader_sha256,configuration_sha256,requested_access_sha256,budget_usd,expires_at)
  VALUES(w,s.agent_id,s.id,s.code_release_id,s.configuration_release_id,staff,grant_id,payload->>'environment',payload->'cases',agentonic.content_hash(payload->'cases'),agentonic.content_hash('{"version":"phrases-citations-v1","threshold":1}'),r.content_sha256,r.requested_access_sha256,(payload->>'budgetUsd')::numeric,least(clock_timestamp()+interval '7 days',(s.review_consent->>'expiresAt')::timestamptz)) RETURNING id INTO result_id;
 ELSE
  IF operation='revoke' THEN
   SELECT * INTO s FROM agentonic.agent_submissions WHERE id=(payload->>'submissionId')::uuid AND workspace_id=w FOR UPDATE;
   IF s.id IS NULL OR s.status<>'approved' OR NOT EXISTS(SELECT 1 FROM agentonic.platform_staff WHERE id=staff AND role IN ('administrator','operator') AND disabled_at IS NULL) OR payload->>'feedback' IS NULL OR length(btrim(payload->>'feedback')) NOT BETWEEN 10 AND 2000 THEN RAISE insufficient_privilege; END IF;
   SELECT support_access_grant_id INTO grant_id FROM agentonic.submission_review_decisions WHERE submission_id=s.id AND decision='approved' AND actor_staff_id=staff ORDER BY decision_number DESC LIMIT 1;
   -- Revocation narrows authority and does not require fresh private-content access.
   IF grant_id IS NULL THEN
    SELECT id INTO grant_id FROM agentonic.support_access_grants WHERE workspace_id=w AND staff_id=staff AND scope->>'submissionId'=s.id::text ORDER BY created_at DESC LIMIT 1;
   END IF;
   IF grant_id IS NULL THEN RAISE insufficient_privilege; END IF;
   INSERT INTO agentonic.submission_review_decisions(workspace_id,agent_id,submission_id,decision_number,decision,actor_staff_id,support_access_grant_id,feedback,assessment_snapshot)
   SELECT w,s.agent_id,s.id,coalesce(max(decision_number),0)+1,'revoked',staff,grant_id,payload->>'feedback','{"version":2}' FROM agentonic.submission_review_decisions WHERE submission_id=s.id RETURNING id INTO result_id;
   UPDATE agentonic.agent_submissions SET status='revoked' WHERE id=s.id;
  ELSE
   SELECT * INTO e FROM agentonic.evaluation_runs WHERE id=(payload->>'evaluationId')::uuid AND workspace_id=w FOR UPDATE;
   IF e.id IS NULL THEN RAISE insufficient_privilege; END IF;
   SELECT * INTO s FROM agentonic.agent_submissions WHERE id=e.submission_id FOR UPDATE;
   result_id:=e.id; grant_id:=e.support_access_grant_id;
   IF operation='authorize' THEN
    IF agentonic.application_role()<>'agentonic_customer' OR member IS DISTINCT FROM s.submitted_by_member_id OR e.status<>'awaiting_consent'
     OR payload->'consent' IS DISTINCT FROM 'true'::jsonb OR payload->>'datasetHash' IS DISTINCT FROM e.dataset_sha256 OR NOT agentonic.evaluation_authorized(e,false) THEN RAISE insufficient_privilege; END IF;
    UPDATE agentonic.evaluation_runs SET authorized_by_member_id=member,authorized_at=clock_timestamp(),status='queued' WHERE id=e.id;
   ELSIF operation='cancel' THEN
    IF NOT ((agentonic.application_role()='agentonic_customer' AND member=s.submitted_by_member_id AND agentonic.member_can_author(member,e.agent_id)) OR (staff IS NOT NULL AND agentonic.can_review(s.id,e.support_access_grant_id))) THEN RAISE insufficient_privilege; END IF;
    UPDATE agentonic.evaluation_runs SET consent_revoked_at=coalesce(consent_revoked_at,clock_timestamp()),status=CASE WHEN status IN ('awaiting_consent','queued','running') THEN 'cancelled' ELSE status END,lease_token=NULL,lease_until=NULL,current_matches='[]',finished_at=coalesce(finished_at,clock_timestamp()) WHERE id=e.id;
   ELSIF operation='approve' THEN
    grant_id:=(payload->>'grantId')::uuid;
    IF payload->'reviewed' IS DISTINCT FROM 'true'::jsonb OR payload->>'evidenceHash' IS DISTINCT FROM e.evidence_sha256 OR NOT agentonic.evaluation_approvable(e) THEN RAISE insufficient_privilege; END IF;
    INSERT INTO agentonic.submission_review_decisions(workspace_id,agent_id,submission_id,decision_number,decision,actor_staff_id,support_access_grant_id,feedback,approval_expires_at,approved_access_sha256,assessment_snapshot)
    SELECT w,e.agent_id,e.submission_id,coalesce(max(decision_number),0)+1,'approved',staff,grant_id,payload->>'feedback',least(clock_timestamp()+interval '24 hours',e.expires_at),e.requested_access_sha256,
      jsonb_build_object('version',2,'evaluationId',e.id,'evidenceHash',e.evidence_sha256,'configurationHash',e.configuration_sha256,'requestedAccessHash',e.requested_access_sha256,'evaluated',true,'humanReviewed',true)
    FROM agentonic.submission_review_decisions WHERE submission_id=e.submission_id RETURNING id INTO result_id;
    UPDATE agentonic.agent_submissions SET status='approved' WHERE id=s.id;
   END IF;
  END IF;
 END IF;
 INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,support_access_grant_id,action,resource_type,resource_id,outcome,request_id)
 VALUES(w,agentonic.actor_user_id(),CASE WHEN agentonic.application_role()='agentonic_customer' THEN member END,CASE WHEN agentonic.application_role()='agentonic_admin' THEN grant_id END,'evaluation.'||operation,'evaluation',result_id::text,'succeeded',trace_id::text);
 RETURN jsonb_build_object('ok',true,'id',result_id);
END $$;

CREATE FUNCTION agentonic.evaluation_list(target_agent uuid,grant_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=agentonic.workspace_id(); result jsonb;
BEGIN
 IF agentonic.actor_user_id() IS NULL OR w IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 IF NOT ((agentonic.application_role()='agentonic_customer' AND agentonic.can_agent(target_agent,'edit')) OR (agentonic.application_role()='agentonic_admin' AND agentonic.current_staff() IS NOT NULL)) THEN RAISE insufficient_privilege; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
 'id',e.id,'submissionId',e.submission_id,'agentId',e.agent_id,'status',e.status,'environment',e.environment,
 'cases',e.dataset_snapshot,'datasetHash',e.dataset_sha256,'configurationHash',e.configuration_sha256,'codeReleaseId',e.code_release_id,'accessHash',e.requested_access_sha256,
 'evidenceHash',e.evidence_sha256,'budgetUsd',e.budget_usd,'committedMicrousd',e.committed_microusd,'expiresAt',e.expires_at,
 'authorized',e.authorized_at IS NOT NULL AND e.consent_revoked_at IS NULL,
 'canAuthorize',agentonic.application_role()='agentonic_customer' AND e.status='awaiting_consent' AND agentonic.current_member()=(SELECT submitted_by_member_id FROM agentonic.agent_submissions WHERE id=e.submission_id) AND agentonic.evaluation_authorized(e,false),
 'canApprove',agentonic.application_role()='agentonic_admin' AND agentonic.can_review(e.submission_id,grant_id) AND agentonic.evaluation_approvable(e) AND EXISTS(SELECT 1 FROM agentonic.platform_staff WHERE id=agentonic.current_staff() AND role IN ('administrator','operator')),
 'results',coalesce((SELECT jsonb_agg(jsonb_build_object('key',r.case_key,'outcome',r.outcome,'answer',r.answer,'citations',r.citations,'checks',r.checks) ORDER BY r.created_at,r.case_key) FROM agentonic.evaluation_results r WHERE r.evaluation_run_id=e.id AND agentonic.evaluation_authorized(e) AND agentonic.evaluation_sources_current(e)),'[]'::jsonb)
 ) ORDER BY e.created_at DESC,e.id),'[]'::jsonb) INTO result
 FROM agentonic.evaluation_runs e WHERE e.workspace_id=w AND (e.agent_id=target_agent OR e.submission_id=target_agent) AND e.expires_at>clock_timestamp()
 AND (agentonic.application_role()='agentonic_customer' OR agentonic.can_review(e.submission_id,grant_id));
 RETURN result;
END $$;

CREATE FUNCTION agentonic.evaluation_claim(worker_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE worker agentonic.evaluation_workers; candidate agentonic.evaluation_runs; token uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO worker FROM agentonic.evaluation_workers WHERE database_role=agentonic.application_role() AND revoked_at IS NULL AND worker_sha256=worker_hash AND verified_at>clock_timestamp()-interval '7 days';
 IF worker.id IS NULL THEN RAISE insufficient_privilege; END IF;
 -- Lease loss never retries paid work. Outstanding reservations stay charged.
 FOR candidate IN SELECT e.* FROM agentonic.evaluation_runs e WHERE e.environment=worker.environment AND e.status IN ('awaiting_consent','queued','running') ORDER BY e.created_at LIMIT 50 LOOP
  PERFORM 1 FROM agentonic.workspaces WHERE id=candidate.workspace_id FOR SHARE;
  SELECT * INTO candidate FROM agentonic.evaluation_runs WHERE id=candidate.id FOR UPDATE;
  IF candidate.status IN ('awaiting_consent','queued','running') AND (NOT agentonic.evaluation_authorized(candidate,candidate.status<>'awaiting_consent') OR (candidate.status='running' AND (candidate.lease_until<=clock_timestamp() OR candidate.started_at<clock_timestamp()-interval '30 minutes'))) THEN
   UPDATE agentonic.evaluation_runs SET status='error',error_code='lease_lost',lease_token=NULL,lease_until=NULL,current_matches='[]',finished_at=clock_timestamp() WHERE id=candidate.id;
  END IF;
 END LOOP;
 FOR candidate IN SELECT e.* FROM agentonic.evaluation_runs e JOIN agentonic.code_releases c ON c.id=e.code_release_id
 WHERE e.environment=worker.environment AND e.status='queued' AND c.artifact_sha256=worker.runtime_sha256 ORDER BY e.created_at LIMIT 20 LOOP
  PERFORM 1 FROM agentonic.workspaces WHERE id=candidate.workspace_id FOR SHARE;
  SELECT * INTO candidate FROM agentonic.evaluation_runs WHERE id=candidate.id AND status='queued' FOR UPDATE SKIP LOCKED;
  IF candidate.id IS NOT NULL AND agentonic.evaluation_authorized(candidate) THEN
   UPDATE agentonic.evaluation_runs SET status='running',worker_id=worker.id,lease_token=token,lease_until=clock_timestamp()+interval '90 seconds',started_at=clock_timestamp() WHERE id=candidate.id;
   RETURN jsonb_build_object('id',candidate.id,'token',token,'kind','retrieve','caseCount',jsonb_array_length(candidate.dataset_snapshot));
  END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE FUNCTION agentonic.evaluation_worker(operation text,run_id uuid,token uuid,payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE e agentonic.evaluation_runs; worker agentonic.evaluation_workers; config agentonic.configuration_releases; code agentonic.code_releases;
 sources jsonb; hits jsonb; assets jsonb; test_case jsonb; checks jsonb; passed boolean; amount bigint;
 budget agentonic.retrieval_provider_budgets; meter agentonic.retrieval_provider_operations;
BEGIN
 SELECT * INTO worker FROM agentonic.evaluation_workers WHERE database_role=agentonic.application_role() AND revoked_at IS NULL AND verified_at>clock_timestamp()-interval '7 days';
 SELECT * INTO e FROM agentonic.evaluation_runs WHERE id=run_id;
 IF worker.id IS NULL OR e.id IS NULL OR e.worker_id IS DISTINCT FROM worker.id THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=e.workspace_id FOR SHARE;
 SELECT * INTO e FROM agentonic.evaluation_runs WHERE id=run_id FOR UPDATE;
 IF e.status<>'running' OR e.lease_token IS DISTINCT FROM token OR e.lease_until<=clock_timestamp() OR e.started_at<clock_timestamp()-interval '30 minutes' THEN RAISE insufficient_privilege; END IF;
 IF operation='fail' THEN
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
  RETURN jsonb_build_object('kind','retrieve','workspaceId',e.workspace_id,'query',test_case->>'question','generateAnswer',true,'preview',true,'hasCollections',jsonb_array_length(config.requested_access_snapshot->'collectionIds')>0,
  'runtime',jsonb_build_object('gitCommit',code.git_commit_sha,'artifactSha256',code.artifact_sha256,'manifest',code.execution_manifest));
 ELSIF operation='reserve' THEN
  IF NOT coalesce((payload->>'provider'='voyage' AND payload->>'model'='voyage-4') OR (payload->>'provider'='openai' AND payload->>'model'='gpt-4.1-mini-2025-04-14'),false) THEN RAISE insufficient_privilege; END IF;
  amount:=(payload->>'microusd')::bigint;
  IF amount IS NULL OR amount NOT BETWEEN 1 AND 1000000 THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO budget FROM agentonic.retrieval_provider_budgets WHERE provider=payload->>'provider' FOR UPDATE;
  IF budget.provider IS NULL THEN RAISE insufficient_privilege; END IF;
  IF e.committed_microusd+amount>e.budget_usd*1000000 OR budget.committed_microusd+amount>budget.cap_microusd THEN RETURN '{"ok":false,"code":"budget_exhausted"}'; END IF;
  INSERT INTO agentonic.retrieval_provider_operations(id,job_id,workspace_id,provider,model,reserved_microusd,agent_id) VALUES((payload->>'id')::uuid,e.id,e.workspace_id,budget.provider,payload->>'model',amount,e.agent_id);
  UPDATE agentonic.retrieval_provider_budgets SET committed_microusd=committed_microusd+amount,updated_at=clock_timestamp() WHERE provider=budget.provider;
  UPDATE agentonic.evaluation_runs SET committed_microusd=committed_microusd+amount WHERE id=e.id;
  RETURN '{"ok":true}';
 ELSIF operation='settle' THEN
  SELECT * INTO meter FROM agentonic.retrieval_provider_operations WHERE id=(payload->>'id')::uuid AND job_id=e.id AND status='reserved' FOR UPDATE;
  amount:=(payload->>'microusd')::bigint;
  IF meter.id IS NULL OR amount IS NULL OR amount<0 OR payload->>'tokens' IS NULL OR (payload->>'tokens')::bigint<0 OR coalesce((payload->>'outputTokens')::bigint,0)<0 THEN RAISE insufficient_privilege; END IF;
  UPDATE agentonic.retrieval_provider_operations SET status='settled',actual_microusd=amount,input_tokens=(payload->>'tokens')::bigint,output_tokens=coalesce((payload->>'outputTokens')::bigint,0) WHERE id=meter.id;
  UPDATE agentonic.retrieval_provider_budgets SET committed_microusd=committed_microusd-meter.reserved_microusd+amount,updated_at=clock_timestamp() WHERE provider=meter.provider;
  UPDATE agentonic.evaluation_runs SET committed_microusd=committed_microusd-meter.reserved_microusd+amount WHERE id=e.id;
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
 ELSIF operation IN ('context','answer') THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'text',c.content) ORDER BY hit.ordinality),'[]') INTO hits
  FROM jsonb_array_elements(e.current_matches) WITH ORDINALITY hit(value,ordinality)
  JOIN agentonic.document_chunks c ON c.id=(hit.value->>'id')::uuid AND c.workspace_id=e.workspace_id AND c.content_sha256=hit.value->>'hash'
  JOIN agentonic.document_versions v ON v.id=c.document_version_id JOIN agentonic.documents d ON d.id=v.document_id AND d.active_version_id=v.id
  WHERE d.deleted_at IS NULL AND v.status='ready';
  IF jsonb_array_length(hits)<>jsonb_array_length(e.current_matches) THEN RAISE insufficient_privilege; END IF;
  IF operation='context' THEN
   SELECT coalesce(jsonb_agg(jsonb_build_object('path','skills/'||(s->>'name')||'.md','sha256',encode(sha256(convert_to(s->>'instructions','UTF8')),'hex')) ORDER BY s->>'name'),'[]') INTO assets FROM jsonb_array_elements(config.content->'skills') s;
   assets:=jsonb_build_array(jsonb_build_object('path','prompts/system.md','sha256',encode(sha256(convert_to(config.content->>'systemPrompt','UTF8')),'hex')))||assets;
   RETURN jsonb_build_object('query',test_case->>'question','passages',hits,'environment','staging','audience','private','expiresAt',least(e.expires_at,e.started_at+interval '30 minutes'),
   'configurationJson',config.content::text,'contentSha256',config.content_sha256,'composedPromptSha256',config.composed_prompt_sha256,'assetManifestJson',assets::text,'assetManifestSha256',config.asset_manifest_sha256,'accessJson',config.requested_access_snapshot::text,'accessSha256',config.requested_access_sha256,'history','[]'::jsonb);
  END IF;
  IF jsonb_typeof(payload->'text') IS DISTINCT FROM 'string' OR length(payload->>'text') NOT BETWEEN 1 AND 12000 OR jsonb_typeof(payload->'citations') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'citations')>8 OR jsonb_typeof(payload->'insufficientEvidence') IS DISTINCT FROM 'boolean' OR payload->>'model' IS DISTINCT FROM 'gpt-4.1-mini-2025-04-14'
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(payload->'citations') citation WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(hits) h WHERE h->>'id'=citation)) THEN RAISE insufficient_privilege; END IF;
  IF e.committed_microusd>e.budget_usd*1000000 OR EXISTS(SELECT 1 FROM agentonic.retrieval_provider_operations WHERE job_id=e.id AND status='reserved') THEN RAISE insufficient_privilege; END IF;
  checks:=jsonb_build_object('abstention',payload->'insufficientEvidence'=test_case->'insufficientEvidence','citations',payload->'insufficientEvidence'='true' OR jsonb_array_length(payload->'citations')>0,
  'requiredPhrases',NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(test_case->'requiredPhrases') phrase WHERE strpos(lower(payload->>'text'),lower(phrase))=0),
  'forbiddenPhrases',NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(test_case->'forbiddenPhrases') phrase WHERE strpos(lower(payload->>'text'),lower(phrase))>0));
  passed:=NOT EXISTS(SELECT 1 FROM jsonb_each(checks) c WHERE c.value<>'true'::jsonb);
  INSERT INTO agentonic.evaluation_results(workspace_id,evaluation_run_id,case_key,outcome,answer,citations,evidence_sources,checks)
  VALUES(e.workspace_id,e.id,test_case->>'key',CASE WHEN passed THEN 'passed' ELSE 'failed' END,payload->>'text',payload->'citations',e.current_matches,checks);
  IF e.next_case+1=jsonb_array_length(e.dataset_snapshot) THEN
   passed:=NOT EXISTS(SELECT 1 FROM agentonic.evaluation_results WHERE evaluation_run_id=e.id AND outcome<>'passed');
   SELECT jsonb_agg(jsonb_build_object('key',case_key,'outcome',outcome,'answer',answer,'citations',citations,'sources',evidence_sources,'checks',checks) ORDER BY case_key) INTO sources FROM agentonic.evaluation_results WHERE evaluation_run_id=e.id;
   UPDATE agentonic.evaluation_runs SET status=CASE WHEN passed THEN 'passed' ELSE 'failed' END,next_case=next_case+1,current_matches='[]',lease_token=NULL,lease_until=NULL,finished_at=clock_timestamp(),
   evidence_sha256=agentonic.content_hash(jsonb_build_object('results',sources,'dataset',e.dataset_sha256,'grader',e.grader_sha256,'configuration',e.configuration_sha256,'access',e.requested_access_sha256,'runtime',code.artifact_sha256,'worker',worker.worker_sha256,'environment',worker.environment)) WHERE id=e.id;
  ELSE
   UPDATE agentonic.evaluation_runs SET next_case=next_case+1,current_matches='[]' WHERE id=e.id;
  END IF;
  RETURN '{"ok":true}';
 END IF;
 RAISE insufficient_privilege;
END $$;

REVOKE ALL ON FUNCTION agentonic.version_approval_valid(uuid),agentonic.valid_evaluation_cases(jsonb),agentonic.evaluation_authorized(agentonic.evaluation_runs,boolean,boolean),agentonic.evaluation_sources_current(agentonic.evaluation_runs),agentonic.evaluation_approvable(agentonic.evaluation_runs,boolean),agentonic.evaluation_immutable(),agentonic.validate_version_approval(),agentonic.evaluation_command(text,jsonb,uuid),agentonic.evaluation_list(uuid,uuid),agentonic.evaluation_claim(text),agentonic.evaluation_worker(text,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic.evaluation_command(text,jsonb,uuid),agentonic.evaluation_list(uuid,uuid) TO agentonic_admin,agentonic_customer;
GRANT USAGE ON SCHEMA agentonic TO agentonic_eval_local,agentonic_eval_azure;
GRANT EXECUTE ON FUNCTION agentonic.evaluation_claim(text),agentonic.evaluation_worker(text,uuid,uuid,jsonb) TO agentonic_eval_local,agentonic_eval_azure;
COMMIT;
