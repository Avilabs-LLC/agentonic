BEGIN;
-- Keep the approval's frozen evidence as the initial view, while allowing staff
-- to follow a newly authorized rerun without rewriting that approval receipt.
ALTER FUNCTION agentonic.approved_review_receipt(uuid,uuid) RENAME TO approved_review_receipt_v36;
CREATE FUNCTION agentonic.approved_review_receipt(target uuid,trace_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; p agentonic.evaluation_preparations;
BEGIN
 result:=agentonic.approved_review_receipt_v36(target,trace_id);
 IF result IS NULL THEN RETURN NULL; END IF;
 IF result->'reportAvailable'='true' THEN
  SELECT preparation.* INTO p FROM agentonic.evaluation_runs e JOIN agentonic.evaluation_preparations preparation ON preparation.id=e.preparation_id AND preparation.workspace_id=e.workspace_id
   WHERE e.id=(result->'evaluation'->>'id')::uuid AND e.workspace_id=agentonic.workspace_id();
  IF p.id IS NOT NULL AND agentonic.preparation_authorized(p,true) AND agentonic.preparation_sources_current(p) THEN
   RETURN result||jsonb_build_object('reviewBatches',agentonic.evaluation_batch_state(p),'currentCriteriaRevision',p.revision,'totalCommittedMicrousd',p.committed_microusd);
  END IF;
 END IF;
 RETURN result||'{"reviewBatches":[]}'::jsonb;
END $$;
REVOKE ALL ON FUNCTION agentonic.approved_review_receipt_v36(uuid,uuid),agentonic.approved_review_receipt(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role,agentonic_customer,agentonic_admin,agentonic_worker,agentonic_eval_local,agentonic_eval_azure;
GRANT EXECUTE ON FUNCTION agentonic.approved_review_receipt(uuid,uuid) TO agentonic_admin;
COMMIT;
