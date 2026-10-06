BEGIN;
-- Admin "Agentes" showed the latest version as its internal release label
-- (for example "r2-63c0a65a") next to "Versión 1" in the version columns
-- (architecture section 55). latestVersion now carries the same counted,
-- human-readable number, still as text so installed apps keep parsing it.
CREATE OR REPLACE FUNCTION agentonic.operations_agents() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
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
  'summary',agentonic.agent_version_summary(a.id),
  'lastRunAt',(SELECT max(r.created_at) FROM agentonic.agent_runs r WHERE r.agent_id=a.id),
  'runs7d',(SELECT count(*) FROM agentonic.agent_runs r WHERE r.agent_id=a.id AND r.created_at>clock_timestamp()-interval '7 days'))
  ORDER BY w.name,a.name)
 FROM agentonic.agents a JOIN agentonic.workspaces w ON w.id=a.workspace_id
 JOIN agentonic.workspace_members m ON m.id=a.owner_member_id JOIN agentonic.users u ON u.id=m.user_id
 LEFT JOIN LATERAL (SELECT r.id,r.version,r.requested_access_snapshot access FROM agentonic.configuration_releases r WHERE r.agent_id=a.id ORDER BY r.created_at DESC LIMIT 1) latest ON true
 WHERE w.deleted_at IS NULL),'[]'::jsonb);
END $$;
COMMIT;
