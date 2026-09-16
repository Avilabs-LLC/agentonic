BEGIN;
-- Content-free discovery for the verified caller. No session creation, renewal,
-- provider call or direct table grant is involved.
CREATE FUNCTION agentonic.active_agent_previews(target_agent uuid)
RETURNS TABLE(id uuid, candidate_id uuid, expires_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF agentonic.application_role()<>'agentonic_customer'
    OR agentonic.current_member() IS NULL
    OR NOT agentonic.can_agent(target_agent,'edit') THEN
  RETURN;
 END IF;
 RETURN QUERY
 SELECT p.id,p.configuration_release_id,p.expires_at
 FROM agentonic.agent_previews p
 WHERE p.workspace_id=agentonic.workspace_id() AND p.agent_id=target_agent
   AND p.requested_by_member_id=agentonic.current_member()
   AND agentonic.preview_authorized(p)
 ORDER BY p.created_at DESC,p.id DESC;
END $$;
REVOKE ALL ON FUNCTION agentonic.active_agent_previews(uuid) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic.active_agent_previews(uuid) TO agentonic_customer;
COMMIT;
