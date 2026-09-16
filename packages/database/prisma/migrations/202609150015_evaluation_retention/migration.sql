BEGIN;
ALTER TABLE agentonic.evaluation_runs ADD COLUMN scrubbed_at timestamptz;
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='agentonic.evaluation_runs'::regclass AND contype='c'
 AND (pg_get_constraintdef(oid) LIKE '%valid_evaluation_cases%' OR pg_get_constraintdef(oid) LIKE '%dataset_sha256 =%') LOOP
 EXECUTE format('ALTER TABLE agentonic.evaluation_runs DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE agentonic.evaluation_runs ADD CHECK((scrubbed_at IS NULL AND agentonic.valid_evaluation_cases(dataset_snapshot) AND dataset_sha256=agentonic.content_hash(dataset_snapshot)) OR (scrubbed_at IS NOT NULL AND dataset_snapshot='[]'));
ALTER TABLE agentonic.evaluation_runs ADD CHECK(grader_sha256=agentonic.content_hash(grader_snapshot) AND grader_snapshot='{"version":"phrases-citations-v1","threshold":1}');
CREATE OR REPLACE FUNCTION agentonic.evaluation_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_TABLE_NAME='evaluation_workers' THEN
  IF TG_OP='DELETE' OR to_jsonb(NEW)-'revoked_at' IS DISTINCT FROM to_jsonb(OLD)-'revoked_at' OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN RAISE EXCEPTION 'Immutable worker attestation'; END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME='evaluation_results' THEN
  IF TG_OP='UPDATE' AND NEW.answer='' AND NEW.citations='[]' AND NEW.evidence_sources='[]'
   AND to_jsonb(NEW)-ARRAY['answer','citations','evidence_sources'] IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['answer','citations','evidence_sources']
   AND EXISTS(SELECT 1 FROM agentonic.evaluation_runs e WHERE e.id=OLD.evaluation_run_id AND e.scrubbed_at IS NOT NULL) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Immutable evaluation result';
 END IF;
 IF OLD.scrubbed_at IS NULL AND NEW.scrubbed_at IS NOT NULL AND NEW.dataset_snapshot='[]'
  AND (OLD.expires_at<=clock_timestamp() OR OLD.consent_revoked_at IS NOT NULL)
  AND to_jsonb(NEW)-ARRAY['scrubbed_at','dataset_snapshot'] IS NOT DISTINCT FROM to_jsonb(OLD)-ARRAY['scrubbed_at','dataset_snapshot'] THEN RETURN NEW; END IF;

 IF to_jsonb(NEW)-ARRAY['status','authorized_by_member_id','authorized_at','consent_revoked_at','committed_microusd','worker_id','lease_token','lease_until','next_case','current_matches','evidence_sha256','error_code','started_at','finished_at']
 IS DISTINCT FROM to_jsonb(OLD)-ARRAY['status','authorized_by_member_id','authorized_at','consent_revoked_at','committed_microusd','worker_id','lease_token','lease_until','next_case','current_matches','evidence_sha256','error_code','started_at','finished_at'] THEN RAISE EXCEPTION 'Immutable evaluation specification'; END IF;
 IF OLD.authorized_at IS NOT NULL AND (NEW.authorized_at IS DISTINCT FROM OLD.authorized_at OR NEW.authorized_by_member_id IS DISTINCT FROM OLD.authorized_by_member_id) THEN RAISE EXCEPTION 'Immutable consent'; END IF;
 IF OLD.consent_revoked_at IS NOT NULL AND NEW.consent_revoked_at IS DISTINCT FROM OLD.consent_revoked_at THEN RAISE EXCEPTION 'Irreversible consent revocation'; END IF;
 IF OLD.worker_id IS NOT NULL AND NEW.worker_id IS DISTINCT FROM OLD.worker_id THEN RAISE EXCEPTION 'Immutable execution worker'; END IF;
 IF OLD.status IN ('passed','failed','error','cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN RAISE EXCEPTION 'Terminal evaluation'; END IF;
 IF OLD.evidence_sha256 IS NOT NULL AND NEW.evidence_sha256 IS DISTINCT FROM OLD.evidence_sha256 THEN RAISE EXCEPTION 'Immutable evaluation evidence'; END IF;
 RETURN NEW;
END $$;

-- Only exact content erasure is permitted; hashes, decisions, outcomes and usage
-- remain immutable. Expiry denies reads even when a worker is offline.
CREATE FUNCTION agentonic.evaluation_cleanup() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE e agentonic.evaluation_runs;
BEGIN
 FOR e IN SELECT * FROM agentonic.evaluation_runs WHERE scrubbed_at IS NULL AND (expires_at<=clock_timestamp() OR consent_revoked_at IS NOT NULL) ORDER BY created_at LIMIT 50 LOOP
  PERFORM 1 FROM agentonic.workspaces WHERE id=e.workspace_id FOR SHARE;
  SELECT * INTO e FROM agentonic.evaluation_runs WHERE id=e.id AND scrubbed_at IS NULL FOR UPDATE SKIP LOCKED;
  IF e.id IS NOT NULL AND (e.expires_at<=clock_timestamp() OR e.consent_revoked_at IS NOT NULL) THEN
   UPDATE agentonic.evaluation_runs SET scrubbed_at=clock_timestamp(),dataset_snapshot='[]' WHERE id=e.id;
   UPDATE agentonic.evaluation_results SET answer='',citations='[]',evidence_sources='[]' WHERE evaluation_run_id=e.id;
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION agentonic.evaluation_cleanup() FROM PUBLIC,anon,authenticated,service_role,agentonic_customer,agentonic_admin,agentonic_worker;
CREATE OR REPLACE FUNCTION agentonic.evaluation_claim(worker_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE worker agentonic.evaluation_workers; candidate agentonic.evaluation_runs; token uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO worker FROM agentonic.evaluation_workers WHERE database_role=agentonic.application_role() AND revoked_at IS NULL AND worker_sha256=worker_hash AND verified_at>clock_timestamp()-interval '7 days';
 IF worker.id IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM agentonic.evaluation_cleanup();
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
COMMIT;
