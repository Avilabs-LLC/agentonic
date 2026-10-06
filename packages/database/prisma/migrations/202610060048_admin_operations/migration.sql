BEGIN;
-- Admin operations screens (architecture section 52). Staff checked agents,
-- deployments, hosts, spend and runtime releases with scripts on the Mac. These
-- read functions give the Admin app the same facts. Each returns metadata only:
-- names, states, counts, times and amounts, never prompts, documents, chat text,
-- email addresses or secrets. Only active Agentonic staff in the Admin app may
-- call them; customers and services cannot.
CREATE FUNCTION agentonic.operations_staff() RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF agentonic.application_role()<>'agentonic_admin' OR agentonic.current_staff() IS NULL THEN RAISE insufficient_privilege; END IF;
END $$;

-- Every agent, with its owner, frozen capabilities, deployment and recent runs.
CREATE FUNCTION agentonic.operations_agents() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM agentonic.operations_staff();
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
  'id',a.id,'name',a.name,'status',a.status,'workspaceId',w.id,'workspaceName',w.name,'ownerName',u.display_name,'createdAt',a.created_at,
  'latestVersion',latest.version,
  'tools',jsonb_build_object(
   'gmail',coalesce(EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(latest.access->'tools','[]')) t WHERE t ? 'connectionId'),false),
   'web',coalesce(EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(latest.access->'tools','[]')) t WHERE t->>'capability'='web'),false),
   'collections',coalesce(jsonb_array_length(latest.access->'collectionIds'),0)),
  'deployment',(SELECT jsonb_build_object('status',CASE WHEN d.status='running' THEN CASE WHEN agentonic.deployment_online(d) THEN 'running' ELSE 'offline' END ELSE d.status END,
    'environment',d.environment,'resting',d.resting_since IS NOT NULL,'authorizedUntil',d.authorized_until)
   FROM agentonic.deployments d WHERE d.agent_id=a.id ORDER BY d.created_at DESC LIMIT 1),
  'lastRunAt',(SELECT max(r.created_at) FROM agentonic.agent_runs r WHERE r.agent_id=a.id),
  'runs7d',(SELECT count(*) FROM agentonic.agent_runs r WHERE r.agent_id=a.id AND r.created_at>clock_timestamp()-interval '7 days'))
  ORDER BY w.name,a.name)
 FROM agentonic.agents a JOIN agentonic.workspaces w ON w.id=a.workspace_id
 JOIN agentonic.workspace_members m ON m.id=a.owner_member_id JOIN agentonic.users u ON u.id=m.user_id
 LEFT JOIN LATERAL (SELECT r.version,r.requested_access_snapshot access FROM agentonic.configuration_releases r WHERE r.agent_id=a.id ORDER BY r.created_at DESC LIMIT 1) latest ON true
 WHERE w.deleted_at IS NULL),'[]'::jsonb);
END $$;

-- What changed recently, and how runs, approvals and spend stand today. Reads
-- (lists, details, receipts) are counted, not listed.
CREATE FUNCTION agentonic.operations_activity() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE reads text[]:=ARRAY['list','detail','review.read','review.receipt.read','review.queue'];
BEGIN
 PERFORM agentonic.operations_staff();
 RETURN jsonb_build_object(
  'runs',jsonb_build_object(
   'succeeded',(SELECT count(*) FROM agentonic.agent_runs WHERE status='succeeded' AND created_at>clock_timestamp()-interval '24 hours'),
   'failed',(SELECT count(*) FROM agentonic.agent_runs WHERE status IN ('failed','timed_out') AND created_at>clock_timestamp()-interval '24 hours'),
   'active',(SELECT count(*) FROM agentonic.agent_runs WHERE status IN ('queued','running','awaiting_approval'))),
  'awaitingApproval',(SELECT count(*) FROM agentonic.tool_approvals WHERE decision='pending' AND expires_at>clock_timestamp()),
  'reads24h',(SELECT count(*) FROM agentonic.audit_events WHERE action=ANY(reads) AND created_at>clock_timestamp()-interval '24 hours'),
  'events',coalesce((SELECT jsonb_agg(jsonb_build_object('id',x.id,'at',x.created_at,'workspaceName',x.workspace_name,'action',x.action,'resourceType',x.resource_type,
    'resourceId',left(x.resource_id,8),'outcome',x.outcome,'actor',x.actor) ORDER BY x.created_at DESC)
   FROM (SELECT e.*,w.name workspace_name,
    CASE WHEN e.actor_member_id IS NOT NULL THEN 'member' WHEN EXISTS(SELECT 1 FROM agentonic.platform_staff s WHERE s.user_id=e.actor_user_id) THEN 'staff' ELSE 'system' END actor
    FROM agentonic.audit_events e JOIN agentonic.workspaces w ON w.id=e.workspace_id
    WHERE NOT e.action=ANY(reads) ORDER BY e.created_at DESC LIMIT 200) x),'[]'::jsonb));
END $$;

-- Workspaces with their people, and Agentonic's own staff.
CREATE FUNCTION agentonic.operations_workspaces() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM agentonic.operations_staff();
 RETURN jsonb_build_object(
  'workspaces',coalesce((SELECT jsonb_agg(jsonb_build_object('id',w.id,'name',w.name,'kind',w.kind,'status',w.status,'timezone',w.timezone,'createdAt',w.created_at,
   'members',(SELECT count(*) FROM agentonic.workspace_members m WHERE m.workspace_id=w.id AND m.status='active' AND m.removed_at IS NULL),
   'agents',(SELECT count(*) FROM agentonic.agents a WHERE a.workspace_id=w.id AND a.status<>'archived'),
   'pendingInvitations',(SELECT count(*) FROM agentonic.workspace_invitations i WHERE i.workspace_id=w.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>clock_timestamp()))
   ORDER BY w.name) FROM agentonic.workspaces w WHERE w.deleted_at IS NULL),'[]'::jsonb),
  'staff',coalesce((SELECT jsonb_agg(jsonb_build_object('name',u.display_name,'role',s.role,'status',CASE WHEN s.disabled_at IS NULL THEN 'active' ELSE 'disabled' END,'since',s.created_at)
   ORDER BY s.disabled_at IS NOT NULL,u.display_name) FROM agentonic.platform_staff s JOIN agentonic.users u ON u.id=s.user_id),'[]'::jsonb));
END $$;

-- Deployments, and what each host and evaluator runs (as staging:reverify prints).
CREATE FUNCTION agentonic.operations_deployments() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM agentonic.operations_staff();
 RETURN jsonb_build_object(
  'deployments',coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'agentName',a.name,'workspaceName',w.name,'environment',d.environment,
   'status',CASE WHEN d.status='running' THEN CASE WHEN agentonic.deployment_online(d) THEN 'running' ELSE 'offline' END ELSE d.status END,
   'resting',d.resting_since IS NOT NULL,'broker',left(d.broker_sha256,8),'authorizedUntil',d.authorized_until,
   'budgetUsd',d.budget_usd,'spentUsd',round(d.committed_microusd::numeric/1000000,6),'createdAt',d.created_at,'activatedAt',d.activated_at)
   ORDER BY d.created_at DESC) FROM agentonic.deployments d JOIN agentonic.agents a ON a.id=d.agent_id JOIN agentonic.workspaces w ON w.id=d.workspace_id),'[]'::jsonb),
  'hosts',coalesce((SELECT jsonb_agg(jsonb_build_object('environment',h.environment,'state',agentonic.registration_state(h.verified_at,h.revoked_at,NULL),
   'heartbeatAt',h.heartbeat_at,'current',left(h.broker_sha256,8),
   'workers',coalesce((SELECT jsonb_agg(left(b.broker_sha256,8) ORDER BY b.installed_at) FROM agentonic.runtime_host_brokers b WHERE b.host_id=h.id AND b.retired_at IS NULL AND b.revoked_at IS NULL),'[]'::jsonb),
   'runtimes',agentonic.operations_runtimes((SELECT array_agg(x.runtime_sha256) FROM agentonic.runtime_host_artifacts x WHERE x.host_id=h.id AND x.retired_at IS NULL)))
   ORDER BY h.environment) FROM agentonic.runtime_hosts h),'[]'::jsonb),
  'evaluators',coalesce((SELECT jsonb_agg(jsonb_build_object('environment',e.environment,'state',agentonic.registration_state(e.verified_at,e.revoked_at,e.retired_at),
   'current',left(e.worker_sha256,8),'toolFixtures',coalesce(e.verification @> '{"toolFixtures":1}',false),
   'runtimes',agentonic.operations_runtimes((SELECT array_agg(x.runtime_sha256) FROM agentonic.evaluation_worker_runtimes x WHERE x.worker_id=e.id)))
   ORDER BY e.environment) FROM (SELECT DISTINCT ON (database_role) * FROM agentonic.evaluation_workers ORDER BY database_role,(revoked_at IS NULL AND retired_at IS NULL) DESC,created_at DESC) e),'[]'::jsonb));
END $$;
-- Runtime releases by catalog version and source commit; an unknown one by its hash.
CREATE FUNCTION agentonic.operations_runtimes(hashes text[]) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('version',coalesce(r.version,left(h,12)),'commit',left(r.git_commit_sha,7)) ORDER BY coalesce(r.version,h)),'[]'::jsonb)
 FROM unnest(coalesce(hashes,'{}')) h LEFT JOIN LATERAL (SELECT version,git_commit_sha FROM agentonic.code_releases WHERE artifact_sha256=h ORDER BY created_at DESC LIMIT 1) r ON true
$$;

-- Spend: provider caps, known spend per day and workspace, and the largest agents.
CREATE FUNCTION agentonic.operations_costs() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM agentonic.operations_staff();
 RETURN jsonb_build_object(
  'providers',coalesce((SELECT jsonb_agg(jsonb_build_object('provider',b.provider,'capUsd',round(b.cap_microusd::numeric/1000000,6),'committedUsd',round(b.committed_microusd::numeric/1000000,6),
   'settledUsd',(SELECT round(coalesce(sum(o.actual_microusd),0)::numeric/1000000,6) FROM agentonic.retrieval_provider_operations o WHERE o.provider=b.provider AND o.status='settled'),
   'unknownOperations',(SELECT count(*) FROM agentonic.retrieval_provider_operations o WHERE o.provider=b.provider AND o.status='reserved' AND o.created_at<clock_timestamp()-interval '1 hour'))
   ORDER BY b.provider) FROM agentonic.retrieval_provider_budgets b),'[]'::jsonb),
  'days',coalesce((SELECT jsonb_agg(jsonb_build_object('date',s.local_date,'workspaceId',s.workspace_id,'workspaceName',w.name,'timezone',s.reporting_timezone,
   'knownUsd',s.known_cost_usd,'unknownOperations',s.unknown_cost_operations) ORDER BY s.local_date DESC,w.name)
   FROM agentonic.daily_cost_summaries s JOIN agentonic.workspaces w ON w.id=s.workspace_id
   WHERE s.agent_id IS NULL AND s.local_date>(clock_timestamp() AT TIME ZONE s.reporting_timezone)::date-30),'[]'::jsonb),
  'agents',coalesce((SELECT jsonb_agg(x ORDER BY (x->>'knownUsd')::numeric DESC) FROM (
   SELECT jsonb_build_object('agentName',coalesce(a.name,'Agente eliminado'),'workspaceName',w.name,'knownUsd',sum(e.provider_cost_usd),'operations',count(*)) x
   FROM agentonic.usage_events e JOIN agentonic.workspaces w ON w.id=e.workspace_id LEFT JOIN agentonic.agents a ON a.id=e.agent_id
   WHERE e.agent_id IS NOT NULL AND e.occurred_at>clock_timestamp()-interval '30 days' GROUP BY e.agent_id,a.name,w.name ORDER BY sum(e.provider_cost_usd) DESC LIMIT 20) top),'[]'::jsonb));
END $$;

-- The runtime catalog: each release, where it is installed and who may use it.
CREATE FUNCTION agentonic.operations_releases() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM agentonic.operations_staff();
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'version',r.version,'commit',left(r.git_commit_sha,7),'artifact',left(r.artifact_sha256,12),
  'status',CASE WHEN r.revoked_at IS NOT NULL THEN 'revoked' WHEN r.retired_at IS NOT NULL THEN 'retired' ELSE 'available' END,'createdAt',r.created_at,
  'hosts',coalesce((SELECT jsonb_agg(DISTINCT h.environment) FROM agentonic.runtime_host_artifacts x JOIN agentonic.runtime_hosts h ON h.id=x.host_id WHERE x.runtime_sha256=r.artifact_sha256 AND x.retired_at IS NULL),'[]'::jsonb),
  'evaluators',coalesce((SELECT jsonb_agg(DISTINCT e.environment) FROM agentonic.evaluation_worker_runtimes x JOIN agentonic.evaluation_workers e ON e.id=x.worker_id WHERE x.runtime_sha256=r.artifact_sha256 AND e.revoked_at IS NULL AND e.retired_at IS NULL),'[]'::jsonb),
  'workspaces',(SELECT count(*) FROM agentonic.workspace_code_release_grants g WHERE g.code_release_id=r.id))
  ORDER BY r.created_at DESC) FROM agentonic.code_releases r),'[]'::jsonb);
END $$;

REVOKE ALL ON FUNCTION agentonic.operations_staff(),agentonic.operations_runtimes(text[]),agentonic.operations_agents(),agentonic.operations_activity(),
 agentonic.operations_workspaces(),agentonic.operations_deployments(),agentonic.operations_costs(),agentonic.operations_releases()
 FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure,
 agentonic_runtime_local,agentonic_runtime_azure,agentonic_deployer_local,agentonic_deployer_azure;
GRANT EXECUTE ON FUNCTION agentonic.operations_agents(),agentonic.operations_activity(),agentonic.operations_workspaces(),
 agentonic.operations_deployments(),agentonic.operations_costs(),agentonic.operations_releases() TO agentonic_admin;
COMMIT;
