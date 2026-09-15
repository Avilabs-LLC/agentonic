BEGIN;
-- Operational metadata across states; content still requires the existing audited
-- review.open action and a live, exact-submission support grant.
CREATE FUNCTION agentonic.review_queue() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=agentonic.workspace_id(); result jsonb;
BEGIN
 IF agentonic.application_role()<>'agentonic_admin' OR agentonic.current_staff() IS NULL OR w IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 WITH versions AS (
  SELECT id,agent_id,workspace_id,
   (row_number() OVER (PARTITION BY agent_id ORDER BY created_at,id))::integer AS number
  FROM agentonic.configuration_releases WHERE workspace_id=w
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id',s.id,'agentName',a.name,'number',s.submission_number,'status',s.status,
  'userId',u.id,'userName',CASE WHEN u.deleted_at IS NULL THEN u.display_name ELSE 'Usuario eliminado' END,
  'userEmail',CASE WHEN u.deleted_at IS NULL THEN agentonic_bootstrap.review_user_email(u.auth_user_id) ELSE NULL END,
  'versionNumber',v.number,
  'canOpen',s.status IN ('submitted','in_review')
   AND (s.review_consent->>'expiresAt')::timestamptz>clock_timestamp()
   AND agentonic.member_can_author(s.submitted_by_member_id,s.agent_id)
 ) ORDER BY s.submitted_at DESC,s.id),'[]'::jsonb) INTO result
 FROM agentonic.agent_submissions s
 JOIN agentonic.agents a ON a.id=s.agent_id AND a.workspace_id=s.workspace_id
 JOIN agentonic.workspace_members m ON m.id=s.submitted_by_member_id AND m.workspace_id=s.workspace_id
 JOIN agentonic.users u ON u.id=m.user_id
 JOIN versions v ON v.id=s.configuration_release_id AND v.agent_id=s.agent_id AND v.workspace_id=s.workspace_id
 WHERE s.workspace_id=w;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION agentonic.review_queue() FROM PUBLIC,anon,authenticated,service_role,agentonic_customer,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic.review_queue() TO agentonic_admin;

-- Keep workspaces discoverable when their last submission leaves the active queue.
CREATE OR REPLACE FUNCTION agentonic.review_workspaces() RETURNS TABLE(id uuid,name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT DISTINCT w.id,w.name FROM agentonic.workspaces w JOIN agentonic.agent_submissions s ON s.workspace_id=w.id
 WHERE agentonic.application_role()='agentonic_admin' AND agentonic.current_staff() IS NOT NULL
 AND w.status='active' AND w.deleted_at IS NULL
$$;
COMMIT;
