-- Despliegues shows each deployment's version number, as the agent page's
-- deployments already do (UI contract §3.1). Additive: a new key only, so an
-- installed Admin that does not know it keeps parsing the result.
CREATE OR REPLACE FUNCTION agentonic.operations_deployments() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM agentonic.operations_staff();
 RETURN jsonb_build_object(
  'deployments',coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'agentId',a.id,'agentName',a.name,'workspaceName',w.name,'environment',d.environment,
   'status',CASE WHEN d.status='running' THEN CASE WHEN agentonic.deployment_online(d) THEN 'running' ELSE 'offline' END ELSE d.status END,
   'resting',d.resting_since IS NOT NULL,'versionNumber',agentonic.release_number(d.configuration_release_id),
   'broker',left(d.broker_sha256,8),'authorizedUntil',d.authorized_until,
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
