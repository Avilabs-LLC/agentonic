BEGIN;
-- What is in use and what comes next (architecture section 55). The agent
-- column "status" was set to 'draft' at creation and never changed, so lists
-- showed "Borrador" for agents in use. These functions derive the state from
-- deployments, proposals and approvals instead. The old keys stay in every
-- read so the installed v0.16.0 apps keep working until the next release.

-- An agent's version number: its prepared versions counted in order.
CREATE FUNCTION agentonic.release_number(rid uuid) RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT count(*)::int FROM agentonic.configuration_releases v JOIN agentonic.configuration_releases r ON r.id=rid
 WHERE v.agent_id=r.agent_id AND (v.created_at,v.id)<=(r.created_at,r.id)
$$;

-- "live": running deployments, the VM first. "ended": the latest deployment
-- when nothing runs and it stopped or failed. "next": the newest proposal for
-- a version newer than the one running (any version when nothing runs),
-- with its pending deployment when one is on the way. Metadata only.
CREATE FUNCTION agentonic.agent_version_summary(aid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE live jsonb;live_at timestamptz;ended jsonb;nxt jsonb;s record;pending jsonb;approval record;archived boolean;
BEGIN
 SELECT a.archived_at IS NOT NULL OR a.status='archived' INTO archived FROM agentonic.agents a WHERE a.id=aid;
 IF archived IS NULL THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('environment',d.environment,
   'status',CASE WHEN NOT agentonic.deployment_authorized(d) THEN 'unauthorized' WHEN agentonic.deployment_online(d) THEN 'running' ELSE 'offline' END,
   'resting',d.resting_since IS NOT NULL,'versionNumber',agentonic.release_number(d.configuration_release_id),'submissionId',d.submission_id)
   ORDER BY d.environment='local',d.environment),'[]'::jsonb),max(r.created_at)
  INTO live,live_at
  FROM agentonic.deployments d JOIN agentonic.configuration_releases r ON r.id=d.configuration_release_id
  WHERE d.agent_id=aid AND d.status='running';
 IF live='[]'::jsonb THEN
  SELECT jsonb_build_object('environment',d.environment,'status',d.status,'versionNumber',agentonic.release_number(d.configuration_release_id))
   INTO ended FROM agentonic.deployments d WHERE d.agent_id=aid ORDER BY d.created_at DESC,d.id DESC LIMIT 1;
  IF ended IS NOT NULL AND ended->>'status' NOT IN ('stopped','failed') THEN ended:=NULL; END IF;
 END IF;
 SELECT x.id,x.submission_number,x.status,x.configuration_release_id INTO s
  FROM agentonic.agent_submissions x JOIN agentonic.configuration_releases r ON r.id=x.configuration_release_id
  WHERE x.agent_id=aid AND x.status<>'withdrawn' AND (live_at IS NULL OR r.created_at>live_at)
  ORDER BY r.created_at DESC,x.submission_number DESC LIMIT 1;
 IF s.id IS NOT NULL THEN
  SELECT jsonb_build_object('environment',d.environment,'status',CASE WHEN agentonic.deployment_authorized(d) THEN d.status ELSE 'unauthorized' END)
   INTO pending FROM agentonic.deployments d
   WHERE d.agent_id=aid AND d.configuration_release_id=s.configuration_release_id AND d.status IN ('awaiting_activation','queued','preparing')
   ORDER BY d.created_at DESC,d.id DESC LIMIT 1;
  SELECT dec.id,dec.approval_expires_at INTO approval FROM agentonic.submission_review_decisions dec
   WHERE dec.submission_id=s.id AND dec.decision='approved' ORDER BY dec.decision_number DESC LIMIT 1;
  nxt:=jsonb_build_object('submissionId',s.id,'number',s.submission_number,'versionNumber',agentonic.release_number(s.configuration_release_id),
   'status',s.status,'approvalReason',CASE WHEN approval.id IS NULL THEN NULL ELSE agentonic.approval_reason(approval.id) END,
   'approvalExpiresAt',approval.approval_expires_at,'deployment',pending);
 END IF;
 RETURN jsonb_build_object('archived',archived,'live',live,'ended',ended,'next',nxt);
END $$;

-- Admin "Agentes": unchanged, plus the summary.
CREATE OR REPLACE FUNCTION agentonic.operations_agents() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
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
  'summary',agentonic.agent_version_summary(a.id),
  'lastRunAt',(SELECT max(r.created_at) FROM agentonic.agent_runs r WHERE r.agent_id=a.id),
  'runs7d',(SELECT count(*) FROM agentonic.agent_runs r WHERE r.agent_id=a.id AND r.created_at>clock_timestamp()-interval '7 days'))
  ORDER BY w.name,a.name)
 FROM agentonic.agents a JOIN agentonic.workspaces w ON w.id=a.workspace_id
 JOIN agentonic.workspace_members m ON m.id=a.owner_member_id JOIN agentonic.users u ON u.id=m.user_id
 LEFT JOIN LATERAL (SELECT r.version,r.requested_access_snapshot access FROM agentonic.configuration_releases r WHERE r.agent_id=a.id ORDER BY r.created_at DESC LIMIT 1) latest ON true
 WHERE w.deleted_at IS NULL),'[]'::jsonb);
END $$;

-- One agent for the Admin agent page: the same metadata, every proposal and
-- deployment, and turn and spend counts. Never prompts, documents or chat text;
-- a proposal's content stays behind its review.
CREATE FUNCTION agentonic.operations_agent(target uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM agentonic.operations_staff();
 RETURN (SELECT jsonb_build_object(
  'id',a.id,'name',a.name,'workspaceId',w.id,'workspaceName',w.name,'ownerName',u.display_name,'createdAt',a.created_at,
  'latestVersion',(SELECT count(*)::int FROM agentonic.configuration_releases r WHERE r.agent_id=a.id),
  'tools',jsonb_build_object(
   'gmail',coalesce(EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(latest.access->'tools','[]')) t WHERE t ? 'connectionId'),false),
   'web',coalesce(EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(latest.access->'tools','[]')) t WHERE t->>'capability'='web'),false),
   'collections',coalesce(jsonb_array_length(latest.access->'collectionIds'),0)),
  'summary',agentonic.agent_version_summary(a.id),
  'proposals',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'number',s.submission_number,
    'versionNumber',agentonic.release_number(s.configuration_release_id),'status',s.status,'submittedAt',s.submitted_at,
    'approvalReason',CASE WHEN d.id IS NULL THEN NULL ELSE agentonic.approval_reason(d.id) END,'approvalExpiresAt',d.approval_expires_at)
    ORDER BY s.submission_number DESC)
   FROM agentonic.agent_submissions s
   LEFT JOIN LATERAL(SELECT x.id,x.approval_expires_at FROM agentonic.submission_review_decisions x WHERE x.submission_id=s.id AND x.decision='approved' ORDER BY x.decision_number DESC LIMIT 1) d ON true
   WHERE s.agent_id=a.id),'[]'::jsonb),
  'deployments',coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'submissionId',d.submission_id,'environment',d.environment,
    'status',CASE WHEN d.status IN ('awaiting_activation','queued','preparing','running') AND NOT agentonic.deployment_authorized(d) THEN 'unauthorized'
     WHEN d.status='running' THEN CASE WHEN agentonic.deployment_online(d) THEN 'running' ELSE 'offline' END ELSE d.status END,
    'resting',d.resting_since IS NOT NULL,'versionNumber',agentonic.release_number(d.configuration_release_id),'authorizedUntil',d.authorized_until,
    'budgetUsd',d.budget_usd,'spentUsd',round(d.committed_microusd::numeric/1000000,6),'createdAt',d.created_at,'activatedAt',d.activated_at)
    ORDER BY d.created_at DESC) FROM agentonic.deployments d WHERE d.agent_id=a.id),'[]'::jsonb),
  'activity',jsonb_build_object(
   'lastRunAt',(SELECT max(r.created_at) FROM agentonic.agent_runs r WHERE r.agent_id=a.id),
   'runs7d',(SELECT count(*) FROM agentonic.agent_runs r WHERE r.agent_id=a.id AND r.created_at>clock_timestamp()-interval '7 days'),
   'failed7d',(SELECT count(*) FROM agentonic.agent_runs r WHERE r.agent_id=a.id AND r.status IN ('failed','timed_out') AND r.created_at>clock_timestamp()-interval '7 days'),
   'knownUsd30d',(SELECT coalesce(sum(e.provider_cost_usd),0) FROM agentonic.usage_events e WHERE e.agent_id=a.id AND e.occurred_at>clock_timestamp()-interval '30 days')))
 FROM agentonic.agents a JOIN agentonic.workspaces w ON w.id=a.workspace_id AND w.deleted_at IS NULL
 JOIN agentonic.workspace_members m ON m.id=a.owner_member_id JOIN agentonic.users u ON u.id=m.user_id
 LEFT JOIN LATERAL (SELECT r.requested_access_snapshot access FROM agentonic.configuration_releases r WHERE r.agent_id=a.id ORDER BY r.created_at DESC LIMIT 1) latest ON true
 WHERE a.id=target);
END $$;

-- The other Admin screens name agents; they now carry the agent's ID so the
-- name opens the agent page.
CREATE OR REPLACE FUNCTION agentonic.operations_deployments() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM agentonic.operations_staff();
 RETURN jsonb_build_object(
  'deployments',coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'agentId',a.id,'agentName',a.name,'workspaceName',w.name,'environment',d.environment,
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
CREATE OR REPLACE FUNCTION agentonic.operations_costs() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
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
   SELECT jsonb_build_object('agentId',a.id,'agentName',coalesce(a.name,'Agente eliminado'),'workspaceName',w.name,'knownUsd',sum(e.provider_cost_usd),'operations',count(*)) x
   FROM agentonic.usage_events e JOIN agentonic.workspaces w ON w.id=e.workspace_id LEFT JOIN agentonic.agents a ON a.id=e.agent_id
   WHERE e.agent_id IS NOT NULL AND e.occurred_at>clock_timestamp()-interval '30 days' GROUP BY e.agent_id,a.id,a.name,w.name ORDER BY sum(e.provider_cost_usd) DESC LIMIT 20) top),'[]'::jsonb));
END $$;
-- An event about an agent, one of its proposals or one of its deployments
-- names that agent.
CREATE OR REPLACE FUNCTION agentonic.operations_activity() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
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
    'resourceId',left(x.resource_id,8),'outcome',x.outcome,'actor',x.actor,'agentId',ag.id,'agentName',ag.name) ORDER BY x.created_at DESC)
   FROM (SELECT e.*,w.name workspace_name,
    CASE WHEN e.actor_member_id IS NOT NULL THEN 'member' WHEN EXISTS(SELECT 1 FROM agentonic.platform_staff s WHERE s.user_id=e.actor_user_id) THEN 'staff' ELSE 'system' END actor,
    CASE WHEN e.resource_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN e.resource_id::uuid END resource_uuid
    FROM agentonic.audit_events e JOIN agentonic.workspaces w ON w.id=e.workspace_id
    WHERE NOT e.action=ANY(reads) ORDER BY e.created_at DESC LIMIT 200) x
   LEFT JOIN LATERAL (SELECT a.id,a.name FROM agentonic.agents a WHERE a.workspace_id=x.workspace_id AND a.id=CASE x.resource_type
     WHEN 'agent' THEN x.resource_uuid
     WHEN 'submission' THEN (SELECT s.agent_id FROM agentonic.agent_submissions s WHERE s.id=x.resource_uuid)
     WHEN 'deployment' THEN (SELECT d.agent_id FROM agentonic.deployments d WHERE d.id=x.resource_uuid) END) ag ON true),'[]'::jsonb));
END $$;
-- The review queue (Revisiones, Vencimientos): unchanged, plus the agent's ID.
CREATE OR REPLACE FUNCTION agentonic.review_queue() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE row jsonb;state jsonb;result jsonb:='[]';approval jsonb;deployment jsonb;
BEGIN
 FOR row IN SELECT value FROM jsonb_array_elements(agentonic.review_queue_before_deployments()) LOOP
  state:=agentonic.lifecycle_state((row->>'id')::uuid);
  SELECT value INTO approval FROM jsonb_array_elements(state->'submissions') WHERE value->>'id'=row->>'id';
  SELECT value INTO deployment FROM jsonb_array_elements(state->'deployments') WHERE value->>'submissionId'=row->>'id' LIMIT 1;
  result:=result||jsonb_build_array(row||jsonb_build_object('agentId',state->'agentId','approvalReason',approval->>'reason','approvalExpiresAt',approval->'expiresAt',
   'deploymentStatus',coalesce(CASE WHEN deployment->>'status'='running' THEN CASE WHEN deployment->>'online'='true' THEN 'running' ELSE 'offline' END ELSE deployment->>'status' END,'none'))
   ||CASE WHEN deployment IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('deploymentEnvironment',deployment->'environment',
    'deploymentAuthorized',deployment->'authorized','consentExpiresAt',deployment->'expiresAt') END);
 END LOOP;
 RETURN result;
END $$;
-- Customer "Agentes": unchanged, plus the summary for editors (the same
-- people who already see the live and in-review versions).
CREATE OR REPLACE FUNCTION agentonic.agent_listing() RETURNS jsonb
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
   -- Connections remain unavailable; observed staging deployments are separate from drafts.
   'connectionsCount',0,'liveVersion',(SELECT string_agg(r.version || ' · ' || CASE dep.environment WHEN 'local' THEN 'Pruebas locales' ELSE 'Pruebas VM' END || CASE WHEN agentonic.deployment_online(dep) THEN '' ELSE ' · Sin conexión' END, ', ' ORDER BY dep.environment)
     FROM agentonic.agent_environments ae JOIN agentonic.deployments dep ON dep.id=ae.current_deployment_id JOIN agentonic.configuration_releases r ON r.id=dep.configuration_release_id
     WHERE ae.workspace_id=w AND ae.agent_id=a.id AND dep.status='running' AND dep.desired_state='running' AND agentonic.deployment_authorized(dep)),
   'reviewVersions',coalesce((SELECT jsonb_agg(jsonb_build_object('version',r.version,'revision',r.source_draft_revision,'status',s.status) ORDER BY s.submission_number DESC)
    FROM agentonic.agent_submissions s JOIN agentonic.configuration_releases r ON r.id=s.configuration_release_id AND r.workspace_id=w AND r.agent_id=a.id
    WHERE s.workspace_id=w AND s.agent_id=a.id AND s.status IN ('submitted','in_review')),'[]'::jsonb),
   'summary',agentonic.agent_version_summary(a.id)
  ) ELSE NULL END
 ) ORDER BY a.created_at DESC,a.id),'[]'::jsonb) INTO result
 FROM agentonic.agents a
 LEFT JOIN agentonic.configuration_drafts d ON d.agent_id=a.id AND d.workspace_id=w AND d.status='draft'
 WHERE a.workspace_id=w AND agentonic.can_agent(a.id,'read');
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION agentonic.release_number(uuid),agentonic.agent_version_summary(uuid),agentonic.operations_agent(uuid)
 FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure,
 agentonic_runtime_local,agentonic_runtime_azure,agentonic_deployer_local,agentonic_deployer_azure;
GRANT EXECUTE ON FUNCTION agentonic.operations_agent(uuid) TO agentonic_admin;
COMMIT;
