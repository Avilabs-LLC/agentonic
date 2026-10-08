-- Admin Agentes shows the same Recursos column as the customer agent list
-- (owner request, 8 October 2026): the saved draft's instruction characters
-- and counts of skills, collections, tools and connections. Metadata only, like
-- the rest of the operations screens; additive key, so older apps ignore it.
CREATE OR REPLACE FUNCTION agentonic.operations_agents()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 PERFORM agentonic.operations_staff();
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
  'id',a.id,'name',a.name,'status',a.status,'workspaceId',w.id,'workspaceName',w.name,'ownerName',u.display_name,'createdAt',a.created_at,
  'latestVersion',CASE WHEN latest.version IS NULL THEN NULL ELSE agentonic.release_number(latest.id)::text END,
  'tools',jsonb_build_object(
   'gmail',coalesce(EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(latest.access->'tools','[]')) t WHERE t ? 'connectionId'),false),
   'web',coalesce(EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(latest.access->'tools','[]')) t WHERE t->>'capability'='web'),false),
   'collections',coalesce(jsonb_array_length(latest.access->'collectionIds'),0)),
  'deployment',(SELECT jsonb_build_object('status',CASE WHEN d.status='running' THEN CASE WHEN agentonic.deployment_online(d) THEN 'running' ELSE 'offline' END ELSE d.status END,
    'environment',d.environment,'resting',d.resting_since IS NOT NULL,'authorizedUntil',d.authorized_until)
   FROM agentonic.deployments d WHERE d.agent_id=a.id ORDER BY d.created_at DESC LIMIT 1),
  -- The saved draft's resources, counted as the customer agent list counts them.
  'resources',CASE WHEN dr.id IS NULL THEN NULL ELSE jsonb_build_object(
   'promptCharacters',length(translate(coalesce(dr.content->>'systemPrompt',''),U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF','')),
   'skillsCount',coalesce(jsonb_array_length(dr.content->'skills'),0),
   'collectionsCount',coalesce(jsonb_array_length(dr.requested_access->'collectionIds'),0),
   'toolsCount',coalesce(jsonb_array_length(dr.requested_access->'tools'),0),
   'connectionsCount',0) END,
  'summary',agentonic.agent_version_summary(a.id),
  'lastRunAt',(SELECT max(r.created_at) FROM agentonic.agent_runs r WHERE r.agent_id=a.id),
  'runs7d',(SELECT count(*) FROM agentonic.agent_runs r WHERE r.agent_id=a.id AND r.created_at>clock_timestamp()-interval '7 days'))
  ORDER BY w.name,a.name)
 FROM agentonic.agents a JOIN agentonic.workspaces w ON w.id=a.workspace_id
 JOIN agentonic.workspace_members m ON m.id=a.owner_member_id JOIN agentonic.users u ON u.id=m.user_id
 LEFT JOIN LATERAL (SELECT r.id,r.version,r.requested_access_snapshot access FROM agentonic.configuration_releases r WHERE r.agent_id=a.id ORDER BY r.created_at DESC LIMIT 1) latest ON true
 LEFT JOIN agentonic.configuration_drafts dr ON dr.agent_id=a.id AND dr.workspace_id=a.workspace_id AND dr.status='draft'
 WHERE w.deleted_at IS NULL),'[]'::jsonb);
END $function$;
