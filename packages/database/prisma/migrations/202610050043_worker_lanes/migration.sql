BEGIN;
-- Knowledge worker lanes (architecture section 45). The worker ran one job at a
-- time for every workspace, so one slow document held up every search and
-- preview. Each kind of work now has its own lane: cleanup (purge), document
-- processing (ingest), searches (retrieve) and preview turns (preview). The
-- worker keeps its own slots per lane and claims only from lanes with a free one.
-- Within a lane, the workspace with the fewest jobs running goes first, then the
-- oldest job, and no workspace holds more than its share of a lane while others
-- wait: one preview turn per workspace beyond the first, one job in every other lane.
CREATE FUNCTION agentonic.job_lane(kind text,preview_id uuid) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN kind='retrieve' AND preview_id IS NOT NULL THEN 'preview' ELSE kind END
$$;
-- How many jobs of one lane a workspace may have running at once.
CREATE FUNCTION agentonic.lane_workspace_limit(lane text) RETURNS integer LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN lane='preview' THEN 2 ELSE 1 END
$$;
-- The single claim behind both entry points. Maintenance is unchanged from the
-- previous rag_claim (previews first, then the knowledge queue). With fair=false
-- it is the previous order exactly: cleanup first, then the oldest job, no shares.
CREATE FUNCTION agentonic.claim_knowledge_job(lanes text[],fair boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j agentonic.background_jobs;
BEGIN
 -- One claim at a time across workers, so the running counts below are exact.
 PERFORM pg_advisory_xact_lock(hashtext('agentonic.claim_knowledge_job'));
 -- Maintenance uses the same workspace-before-preview/job lock order as mutations.
 PERFORM 1 FROM agentonic.workspaces WHERE id IN (SELECT workspace_id FROM agentonic.agent_previews WHERE status='running') ORDER BY id FOR UPDATE;
 UPDATE agentonic.background_jobs SET status='failed',error_code='lease_lost',lease_token=NULL,lease_until=NULL
 WHERE preview_id IS NOT NULL AND status='running' AND lease_until<clock_timestamp();
 UPDATE agentonic.agent_previews p SET status='cancelled' WHERE status='running' AND expires_at>clock_timestamp() AND NOT agentonic.preview_authorized(p);
 UPDATE agentonic.agent_previews SET status='expired' WHERE status='running' AND expires_at<=clock_timestamp();
 DELETE FROM agentonic.background_jobs WHERE preview_id IN (SELECT id FROM agentonic.agent_previews WHERE status IN ('expired','cancelled'));
 -- Short-lived query records never become a transcript or a content cache.
 DELETE FROM agentonic.background_jobs WHERE kind='retrieve' AND created_at<clock_timestamp()-interval '10 minutes';
 UPDATE agentonic.background_jobs SET status='failed',error_code='attempts_exhausted',lease_token=NULL,lease_until=NULL WHERE kind<>'purge' AND attempts>=5 AND (status='queued' OR status='running' AND lease_until<clock_timestamp());
 LOOP
  SELECT c.* INTO j FROM agentonic.background_jobs c
  CROSS JOIN LATERAL (SELECT agentonic.job_lane(c.kind,c.preview_id) lane) l
  CROSS JOIN LATERAL (SELECT count(*) n FROM agentonic.background_jobs r WHERE r.workspace_id=c.workspace_id AND r.status='running'
   AND r.lease_until>=clock_timestamp() AND agentonic.job_lane(r.kind,r.preview_id)=l.lane) busy
  WHERE l.lane=ANY(lanes) AND c.available_at<=clock_timestamp() AND (c.status='queued' OR c.status='running' AND c.lease_until<clock_timestamp())
   AND (NOT fair OR busy.n<agentonic.lane_workspace_limit(l.lane))
  ORDER BY c.kind<>'purge',CASE WHEN fair THEN busy.n END,c.created_at FOR UPDATE OF c SKIP LOCKED LIMIT 1;
  IF j.id IS NULL THEN RETURN NULL; END IF;
  EXIT WHEN agentonic.rag_job_authorized(j);
  -- Work its requester can no longer authorize is dropped; look for the next job.
  UPDATE agentonic.background_jobs SET status='cancelled',payload='{}',result='{}',lease_token=NULL,lease_until=NULL WHERE id=j.id;
 END LOOP;
 UPDATE agentonic.background_jobs SET status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
 RETURN jsonb_build_object('id',j.id,'token',j.lease_token,'kind',j.kind,'lane',agentonic.job_lane(j.kind,j.preview_id));
END $$;
-- The worker's claim: one job from the named lanes, shared fairly between workspaces.
CREATE FUNCTION agentonic.knowledge_claim(lanes text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF agentonic.application_role()<>'agentonic_worker' THEN RAISE insufficient_privilege; END IF;
 IF coalesce(cardinality(lanes),0)=0 OR array_position(lanes,NULL) IS NOT NULL OR NOT lanes<@ARRAY['purge','ingest','retrieve','preview'] THEN RAISE invalid_parameter_value; END IF;
 RETURN agentonic.claim_knowledge_job(lanes,true);
END $$;
-- The previous claim, kept for the benchmarks and for a worker still running the
-- previous release: any job, cleanup first, then the oldest.
CREATE OR REPLACE FUNCTION agentonic.rag_claim(purge_only boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF agentonic.application_role()<>'agentonic_worker' THEN RAISE insufficient_privilege; END IF;
 RETURN agentonic.claim_knowledge_job(CASE WHEN purge_only THEN ARRAY['purge'] ELSE ARRAY['purge','ingest','retrieve','preview'] END,false);
END $$;
DROP FUNCTION agentonic.rag_claim_v7(boolean);
REVOKE ALL ON FUNCTION agentonic.job_lane(text,uuid),agentonic.lane_workspace_limit(text),agentonic.claim_knowledge_job(text[],boolean) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
REVOKE ALL ON FUNCTION agentonic.knowledge_claim(text[]) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer;
GRANT EXECUTE ON FUNCTION agentonic.knowledge_claim(text[]) TO agentonic_worker;
COMMIT;
