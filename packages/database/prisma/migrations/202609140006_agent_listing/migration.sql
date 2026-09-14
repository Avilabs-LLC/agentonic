BEGIN;
-- One actor/workspace-scoped read for listing metadata. Never return prompts,
-- instructions, collection IDs or counts for metadata-only agent access.
CREATE FUNCTION agentonic.agent_listing() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=agentonic.workspace_id(); result jsonb;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR agentonic.actor_user_id() IS NULL OR w IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR SHARE;
 IF NOT FOUND OR agentonic.current_member() IS NULL THEN RAISE insufficient_privilege; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id',a.id,'name',a.name,'slug',a.slug,'description',a.description,'status',a.status,
  'canEdit',agentonic.can_agent(a.id,'edit'),
  'configuration',CASE WHEN agentonic.can_agent(a.id,'edit') THEN jsonb_build_object(
   -- ECMAScript whitespace, matching the shared prompt character counter.
   'promptCharacters',length(translate(coalesce(d.content->>'systemPrompt',''),U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF','')),
   'skillsCount',coalesce(jsonb_array_length(d.content->'skills'),0),
   'collectionsCount',coalesce(jsonb_array_length(d.requested_access->'collectionIds'),0),
   'toolsCount',coalesce(jsonb_array_length(d.requested_access->'tools'),0),
   -- Connections and deployments are not implemented in the authoring slice.
   'connectionsCount',0,'liveVersion',NULL,
   'reviewVersions',coalesce((SELECT jsonb_agg(jsonb_build_object('version',r.version,'revision',r.source_draft_revision,'status',s.status) ORDER BY s.submission_number DESC)
    FROM agentonic.agent_submissions s JOIN agentonic.configuration_releases r ON r.id=s.configuration_release_id AND r.workspace_id=w AND r.agent_id=a.id
    WHERE s.workspace_id=w AND s.agent_id=a.id AND s.status IN ('submitted','in_review')),'[]'::jsonb)
  ) ELSE NULL END
 ) ORDER BY a.created_at DESC,a.id),'[]'::jsonb) INTO result
 FROM agentonic.agents a
 LEFT JOIN agentonic.configuration_drafts d ON d.agent_id=a.id AND d.workspace_id=w AND d.status='draft'
 WHERE a.workspace_id=w AND agentonic.can_agent(a.id,'read');
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION agentonic.agent_listing() FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic.agent_listing() TO agentonic_customer;
COMMIT;
