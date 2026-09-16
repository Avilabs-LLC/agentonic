BEGIN;
-- Deliver cited excerpts only through the existing live consent/source checks.
CREATE OR REPLACE FUNCTION agentonic.evaluation_list(target_agent uuid,grant_id uuid DEFAULT NULL) RETURNS jsonb
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
 'canCancel',(agentonic.application_role()='agentonic_customer' AND agentonic.current_member()=(SELECT submitted_by_member_id FROM agentonic.agent_submissions WHERE id=e.submission_id) AND agentonic.member_can_author(agentonic.current_member(),e.agent_id) OR agentonic.application_role()='agentonic_admin' AND agentonic.can_review(e.submission_id,grant_id)) AND e.consent_revoked_at IS NULL,
 'canApprove',agentonic.application_role()='agentonic_admin' AND agentonic.can_review(e.submission_id,grant_id) AND agentonic.evaluation_approvable(e) AND EXISTS(SELECT 1 FROM agentonic.platform_staff WHERE id=agentonic.current_staff() AND role IN ('administrator','operator')),
 'results',coalesce((SELECT jsonb_agg(jsonb_build_object('key',r.case_key,'outcome',r.outcome,'answer',r.answer,'citations',r.citations,'checks',r.checks,'sources',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'text',c.content)) FROM agentonic.document_chunks c WHERE c.workspace_id=e.workspace_id AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.citations) citation WHERE citation=c.id::text)),'[]'::jsonb)) ORDER BY r.created_at,r.case_key) FROM agentonic.evaluation_results r WHERE r.evaluation_run_id=e.id AND agentonic.evaluation_authorized(e) AND agentonic.evaluation_sources_current(e)),'[]'::jsonb)
 ) ORDER BY e.created_at DESC,e.id),'[]'::jsonb) INTO result
 FROM agentonic.evaluation_runs e WHERE e.workspace_id=w AND (e.agent_id=target_agent OR e.submission_id=target_agent) AND e.expires_at>clock_timestamp()
 AND (agentonic.application_role()='agentonic_customer' OR agentonic.can_review(e.submission_id,grant_id));
 RETURN result;
END $$;

COMMIT;
