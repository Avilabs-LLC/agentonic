BEGIN;
-- An expired Google authorization pauses the agent and ends the turn cleanly
-- (architecture §84, owner decisions 29 October 2026). While the Google app is
-- in Testing, every Gmail and Drive consent lasts 7 days. On 22 October one
-- expired during a NicolAI-Mail turn: the reconnect marking cleared the chosen
-- Gmail actions, the deployment lost its authority at once, the turn's own
-- `fail` was refused, the deployment stopped, and the turn stayed `running`.

-- 1. A refused Google token keeps the account's chosen Gmail actions. Five
-- places mark a connection for reconnect; only disconnecting clears actions.
CREATE FUNCTION agentonic.gmail_reconnect_keeps_operations() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.status='reconnect' AND OLD.status IN ('connected','reconnect') THEN NEW.operations:=OLD.operations; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reconnect_keeps_operations BEFORE UPDATE OF status ON agentonic.gmail_connections FOR EACH ROW EXECUTE FUNCTION agentonic.gmail_reconnect_keeps_operations();

-- 2. An account waiting to be reconnected still stands behind a deployment's
-- grant: same owner, same agent, the action still chosen. Mailbox and Drive
-- access still need a credential (gmail_allowed, drive_allowed), so nothing is
-- read or written while it waits, and reconnecting resumes the same deployment.
CREATE FUNCTION agentonic.gmail_grant_standing(c agentonic.gmail_connections,m uuid,aid uuid,op text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(c.id IS NOT NULL AND ((c.status='connected' AND c.credential_ciphertext IS NOT NULL) OR c.status='reconnect') AND c.agent_id=aid AND c.owner_member_id=m
 AND agentonic.member_can_author(m,aid) AND c.operations ? op,false)
$$;
CREATE FUNCTION agentonic.drive_grant_standing(c agentonic.drive_connections,m uuid,aid uuid,op text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(c.id IS NOT NULL AND c.purpose='tools' AND ((c.status='connected' AND c.credential_ciphertext IS NOT NULL) OR c.status='reconnect') AND c.agent_id=aid AND c.owner_member_id=m
 AND agentonic.member_can_author(m,aid) AND c.operations ? op,false)
$$;

CREATE OR REPLACE FUNCTION agentonic.gmail_deployment_scope(r agentonic.configuration_releases,m uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE g jsonb; op text;c agentonic.gmail_connections;
BEGIN
 IF NOT agentonic.valid_gmail_tools(agentonic.gmail_grants(r.requested_access_snapshot->'tools')) THEN RETURN false; END IF;
 IF agentonic.gmail_grants(r.requested_access_snapshot->'tools')='[]' THEN RETURN true; END IF;
 IF NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=r.code_release_id AND execution_manifest->>'gmailContract'='1') THEN RETURN false; END IF;
 FOR g IN SELECT value FROM jsonb_array_elements(agentonic.gmail_grants(r.requested_access_snapshot->'tools')) LOOP
  SELECT * INTO c FROM agentonic.gmail_connections WHERE id=(g->>'connectionId')::uuid AND workspace_id=r.workspace_id AND agent_id=r.agent_id;
  FOR op IN SELECT jsonb_array_elements_text(g->'operations') LOOP
   IF NOT agentonic.gmail_grant_standing(c,m,r.agent_id,op) OR NOT EXISTS(SELECT 1 FROM agentonic.configuration_tools config JOIN agentonic.code_tools code ON code.id=config.code_tool_id AND code.code_release_id=config.code_release_id WHERE config.configuration_release_id=r.id AND config.enabled AND code.package_key='gmail-v1' AND code.name=op AND config.effective_policy->>'connectionId'=c.id::text) THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION agentonic.drive_deployment_scope(r agentonic.configuration_releases,m uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE g jsonb; op text; c agentonic.drive_connections; grants jsonb:=agentonic.drive_grants(coalesce(r.requested_access_snapshot->'tools','[]'));
BEGIN
 IF NOT agentonic.valid_drive_tools(grants) THEN RETURN false; END IF;
 IF grants='[]' THEN RETURN true; END IF;
 IF NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=r.code_release_id AND execution_manifest->>'driveContract'='1') THEN RETURN false; END IF;
 FOR g IN SELECT value FROM jsonb_array_elements(grants) LOOP
  SELECT * INTO c FROM agentonic.drive_connections WHERE id=(g->>'driveConnectionId')::uuid AND workspace_id=r.workspace_id AND agent_id=r.agent_id;
  FOR op IN SELECT jsonb_array_elements_text(g->'operations') LOOP
   IF NOT agentonic.drive_grant_standing(c,m,r.agent_id,op) OR NOT EXISTS(SELECT 1 FROM agentonic.configuration_tools config JOIN agentonic.code_tools code ON code.id=config.code_tool_id AND code.code_release_id=config.code_release_id
    WHERE config.configuration_release_id=r.id AND config.enabled AND code.package_key='drive-v1' AND code.name=op AND config.effective_policy->>'connectionId'=c.id::text) THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END $$;


-- 3. A deployment waits for Google when an account behind one of its frozen
-- Gmail or Drive grants must be reconnected, or its consent has expired.
CREATE FUNCTION agentonic.deployment_waiting_google(d agentonic.deployments) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(EXISTS(SELECT 1 FROM agentonic.configuration_releases r
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.requested_access_snapshot->'tools','[]')) g(grant_)
  LEFT JOIN agentonic.gmail_connections gc ON gc.id=(g.grant_->>'connectionId')::uuid
  LEFT JOIN agentonic.drive_connections dc ON dc.id=(g.grant_->>'driveConnectionId')::uuid
  LEFT JOIN agentonic.connections s ON s.id=coalesce(gc.id,dc.id)
  WHERE r.id=d.configuration_release_id
   AND (gc.status='reconnect' OR dc.status='reconnect' OR (coalesce(gc.status,dc.status)='connected' AND s.credential_expires_at<=clock_timestamp()))),false)
$$;

-- 4. Its chats take no new turn: nothing is queued or spent, and the
-- conversation says who must reconnect. The function that answered until now
-- is kept as it runs live and called after this check.
ALTER FUNCTION agentonic.staging_chat(text,jsonb) RENAME TO staging_chat_v77;
CREATE FUNCTION agentonic.staging_chat(operation text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d agentonic.deployments;
BEGIN
 IF operation='turn' THEN
  SELECT dep.* INTO d FROM agentonic.staging_conversations c JOIN agentonic.deployments dep ON dep.id=c.deployment_id
   WHERE c.id=(payload->>'conversationId')::uuid AND c.workspace_id=agentonic.workspace_id() AND c.owner_member_id=agentonic.current_member()
    AND agentonic.staging_conversation_authorized(c);
  IF d.id IS NOT NULL AND agentonic.deployment_waiting_google(d) THEN RETURN '{"ok":false,"code":"google_reconnect"}'; END IF;
 END IF;
 RETURN agentonic.staging_chat_v77(operation,payload);
END $$;

-- 5. A turn always ends. Its copy records the failure even after the deployment
-- has lost authority: `fail` only closes the lease it holds. Every other
-- operation still goes through the full check.
ALTER FUNCTION agentonic.staging_worker(text,uuid,text,uuid,uuid,jsonb) RENAME TO staging_worker_v77;
CREATE FUNCTION agentonic.staging_worker(operation text,deployment_id uuid,secret text,job_id uuid,token uuid,payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE d agentonic.deployments;t agentonic.staging_turns;
BEGIN
 IF operation<>'fail' THEN RETURN agentonic.staging_worker_v77(operation,deployment_id,secret,job_id,token,payload); END IF;
 SELECT * INTO d FROM agentonic.deployments WHERE id=deployment_id;
 IF coalesce(agentonic.deployment_copy(d,secret) NOT IN ('serving','draining'),true) THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=d.workspace_id FOR SHARE;
 SELECT * INTO d FROM agentonic.deployments WHERE id=deployment_id FOR UPDATE;
 IF coalesce(agentonic.deployment_copy(d,secret) NOT IN ('serving','draining'),true) THEN RAISE insufficient_privilege; END IF;
 SELECT turn.* INTO t FROM agentonic.staging_turns turn JOIN agentonic.staging_conversations conv ON conv.id=turn.conversation_id WHERE turn.id=job_id AND conv.deployment_id=d.id FOR UPDATE OF turn;
 IF t.id IS NULL OR t.status<>'running' OR t.lease_token IS DISTINCT FROM token OR t.lease_until<=clock_timestamp() OR t.started_at<clock_timestamp()-agentonic.staging_turn_window(d.code_release_id) THEN RAISE insufficient_privilege; END IF;
 UPDATE agentonic.staging_turns SET status='failed',error_code=CASE WHEN payload->>'code' IN ('provider_unavailable','budget_exhausted','configuration_required','runtime_mismatch','google_reconnect') THEN payload->>'code' ELSE 'lease_lost' END,lease_token=NULL,lease_until=NULL WHERE id=t.id;
 RETURN '{"ok":true}';
END $$;

-- 6. A stopped deployment's turns end. Each full poll closes the turns still
-- queued, or running with an expired lease, of this host's deployments that no
-- longer run, including those a poll has just stopped.
ALTER FUNCTION agentonic.deployment_host(text,uuid,jsonb) RENAME TO deployment_host_v77;
CREATE FUNCTION agentonic.deployment_host(operation text,target_id uuid,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 result:=agentonic.deployment_host_v77(operation,target_id,payload);
 IF operation='poll' THEN
  UPDATE agentonic.staging_turns t SET status='failed',error_code='deployment_stopped',lease_token=NULL,lease_until=NULL
  FROM agentonic.staging_conversations c,agentonic.deployments d,agentonic.runtime_hosts h
  WHERE c.id=t.conversation_id AND d.id=c.deployment_id AND h.id=d.host_id
   AND h.database_role=agentonic.application_role() AND h.broker_sha256=payload->>'brokerHash' AND h.revoked_at IS NULL
   AND d.status NOT IN ('awaiting_activation','queued','preparing','running')
   AND (t.status='queued' OR (t.status='running' AND coalesce(t.lease_until<=clock_timestamp(),true)));
 END IF;
 RETURN result;
END $$;

-- 7. A scheduled run skips while its deployment waits for Google.
ALTER TABLE agentonic.agent_schedule_runs DROP CONSTRAINT agent_schedule_runs_reason_check;
ALTER TABLE agentonic.agent_schedule_runs ADD CONSTRAINT agent_schedule_runs_reason_check
 CHECK(reason IS NULL OR reason IN ('no_deployment','offline','busy','turn_limit','member_inactive','agent_unavailable','google_reconnect'));

CREATE OR REPLACE FUNCTION agentonic.schedule_launch(s agentonic.agent_schedules,slot timestamptz,manual boolean) RETURNS agentonic.agent_schedule_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d agentonic.deployments; c agentonic.staging_conversations; r agentonic.agent_schedule_runs; models jsonb; choice jsonb; n integer; skip text; run_id uuid:=gen_random_uuid(); turn uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM agentonic.workspace_members m JOIN agentonic.workspaces w ON w.id=m.workspace_id WHERE m.id=s.member_id AND m.status='active' AND m.removed_at IS NULL AND w.status='active' AND w.deleted_at IS NULL) THEN skip:='member_inactive';
 ELSIF NOT EXISTS(SELECT 1 FROM agentonic.agents a WHERE a.id=s.agent_id AND a.status<>'archived') THEN skip:='agent_unavailable';
 ELSE
  SELECT * INTO d FROM agentonic.deployments dep WHERE dep.workspace_id=s.workspace_id AND dep.agent_id=s.agent_id AND dep.authorized_by_member_id=s.member_id
   AND dep.status='running' AND agentonic.deployment_authorized(dep) ORDER BY dep.activated_at DESC NULLS LAST,dep.created_at DESC LIMIT 1;
  IF d.id IS NULL THEN skip:='no_deployment';
  ELSIF NOT agentonic.deployment_online(d) THEN skip:='offline';
  ELSIF agentonic.deployment_waiting_google(d) THEN skip:='google_reconnect';
  END IF;
 END IF;
 IF skip IS NULL THEN
  -- One conversation per schedule and deployment, renewed when it fills or ends.
  SELECT * INTO c FROM agentonic.staging_conversations sc WHERE sc.schedule_id=s.id AND sc.deployment_id=d.id AND sc.closed_at IS NULL AND sc.expires_at>clock_timestamp()+interval '5 minutes'
   AND (SELECT count(*) FROM agentonic.staging_turns t WHERE t.conversation_id=sc.id)<100 AND agentonic.staging_conversation_authorized(sc) ORDER BY sc.created_at DESC LIMIT 1 FOR UPDATE;
  IF c.id IS NULL THEN
   INSERT INTO agentonic.staging_conversations(workspace_id,agent_id,deployment_id,owner_member_id,title,expires_at,schedule_id)
   VALUES(s.workspace_id,s.agent_id,d.id,s.member_id,'Programación: '||btrim(s.name),clock_timestamp()+interval '30 days',s.id) RETURNING * INTO c;
  END IF;
  IF NOT agentonic.staging_conversation_authorized(c) THEN skip:='no_deployment';
  ELSIF EXISTS(SELECT 1 FROM agentonic.staging_turns t WHERE t.conversation_id=c.id AND t.status IN ('queued','running')) THEN skip:='busy';
  END IF;
 END IF;
 IF skip IS NOT NULL THEN
  INSERT INTO agentonic.agent_schedule_runs(id,workspace_id,schedule_id,scheduled_for,manual,status,reason,deployment_id,conversation_id,finished_at)
  VALUES(run_id,s.workspace_id,s.id,slot,manual,'skipped',skip,d.id,c.id,clock_timestamp()) RETURNING * INTO r;
  RETURN r;
 END IF;
 -- The schedule's model when the approved version allows it, else the deployment's first.
 models:=agentonic.deployment_models(d);
 choice:=CASE WHEN models @> jsonb_build_array(jsonb_build_object('model',s.model,'reasoning',s.reasoning)) THEN jsonb_build_object('model',s.model,'reasoning',s.reasoning) ELSE models->0 END;
 SELECT coalesce(max(number),0)+1 INTO n FROM agentonic.staging_turns WHERE conversation_id=c.id;
 INSERT INTO agentonic.staging_turns(workspace_id,conversation_id,request_id,number,query,response_model,reasoning_effort)
 VALUES(s.workspace_id,c.id,run_id,n,agentonic.schedule_message(s),choice->>'model',choice->>'reasoning') RETURNING id INTO turn;
 INSERT INTO agentonic.agent_schedule_runs(id,workspace_id,schedule_id,scheduled_for,manual,status,deployment_id,conversation_id,turn_id)
 VALUES(run_id,s.workspace_id,s.id,slot,manual,'queued',d.id,c.id,turn) RETURNING * INTO r;
 RETURN r;
END $$;


-- 8. Customers and staff see a running deployment that waits for Google as
-- "Esperando reconexión" instead of "En funcionamiento".

CREATE OR REPLACE FUNCTION agentonic.agent_version_summary(aid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE live jsonb;live_at timestamptz;ended jsonb;nxt jsonb;s record;pending jsonb;approval record;archived boolean;
BEGIN
 SELECT a.archived_at IS NOT NULL OR a.status='archived' INTO archived FROM agentonic.agents a WHERE a.id=aid;
 IF archived IS NULL THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('environment',d.environment,
   'status',CASE WHEN NOT agentonic.deployment_authorized(d) THEN 'unauthorized' WHEN agentonic.deployment_online(d) THEN CASE WHEN agentonic.deployment_waiting_google(d) THEN 'waiting_reconnect' ELSE 'running' END ELSE 'offline' END,
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

CREATE OR REPLACE FUNCTION agentonic.operations_agent(target uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM agentonic.operations_staff();
 RETURN (SELECT jsonb_build_object(
  'id',a.id,'name',a.name,'workspaceId',w.id,'workspaceName',w.name,'ownerName',u.display_name,'createdAt',a.created_at,
  'latestVersion',(SELECT count(*)::int FROM agentonic.configuration_releases r WHERE r.agent_id=a.id),
  'tools',jsonb_build_object(
   'gmail',coalesce(EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(latest.access->'tools','[]')) t WHERE t ? 'connectionId'),false),
   'drive',coalesce(EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(latest.access->'tools','[]')) t WHERE t ? 'driveConnectionId'),false),
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
     WHEN d.status='running' THEN CASE WHEN agentonic.deployment_online(d) THEN CASE WHEN agentonic.deployment_waiting_google(d) THEN 'waiting_reconnect' ELSE 'running' END ELSE 'offline' END ELSE d.status END,
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
  'deployment',(SELECT jsonb_build_object('status',CASE WHEN d.status='running' THEN CASE WHEN agentonic.deployment_online(d) THEN CASE WHEN agentonic.deployment_waiting_google(d) THEN 'waiting_reconnect' ELSE 'running' END ELSE 'offline' END ELSE d.status END,
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

CREATE OR REPLACE FUNCTION agentonic.operations_deployments() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM agentonic.operations_staff();
 RETURN jsonb_build_object(
  'deployments',coalesce((SELECT jsonb_agg(jsonb_build_object('id',d.id,'agentId',a.id,'agentName',a.name,'workspaceName',w.name,'environment',d.environment,
   'status',CASE WHEN d.status IN ('awaiting_activation','queued','preparing','running') AND NOT agentonic.deployment_authorized(d) THEN 'unauthorized'
    WHEN d.status='running' THEN CASE WHEN agentonic.deployment_online(d) THEN CASE WHEN agentonic.deployment_waiting_google(d) THEN 'waiting_reconnect' ELSE 'running' END ELSE 'offline' END ELSE d.status END,
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

ALTER FUNCTION agentonic.lifecycle_state(uuid) RENAME TO lifecycle_state_v77;
CREATE FUNCTION agentonic.lifecycle_state(target_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 result:=agentonic.lifecycle_state_v77(target_id);
 RETURN jsonb_set(result,'{deployments}',coalesce((SELECT jsonb_agg(x.item||jsonb_build_object('waitingGoogle',coalesce(agentonic.deployment_waiting_google(dep),false)) ORDER BY x.n)
  FROM jsonb_array_elements(result->'deployments') WITH ORDINALITY x(item,n) LEFT JOIN agentonic.deployments dep ON dep.id=(x.item->>'id')::uuid),'[]'::jsonb));
END $$;

-- 9. When Google's authorization ends. While the app is in Testing a consent
-- lasts 7 days; the server sends that date, or Google's own when earlier, and
-- each consent or reconnect records it on the general connection (§49).
CREATE FUNCTION agentonic.google_grant_expiry(value text) RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE t timestamptz;
BEGIN
 IF value IS NULL THEN RETURN NULL; END IF;
 t:=value::timestamptz;
 IF t<=clock_timestamp() OR t>clock_timestamp()+interval '400 days' THEN RAISE insufficient_privilege; END IF;
 RETURN t;
END $$;
-- The accounts a member lists carry that date.
CREATE FUNCTION agentonic.google_expiries(items jsonb) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(x.item||jsonb_build_object('expiresAt',s.credential_expires_at) ORDER BY x.n),'[]'::jsonb)
 FROM jsonb_array_elements(coalesce(items,'[]')) WITH ORDINALITY x(item,n) LEFT JOIN agentonic.connections s ON s.id=(x.item->>'id')::uuid
$$;
ALTER FUNCTION agentonic.gmail_command(text,jsonb) RENAME TO gmail_command_v77;
CREATE FUNCTION agentonic.gmail_command(operation text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;expires timestamptz;
BEGIN
 IF operation='oauth.finish' THEN expires:=agentonic.google_grant_expiry(payload->>'expiresAt'); END IF;
 result:=agentonic.gmail_command_v77(operation,payload);
 IF operation='oauth.finish' THEN
  UPDATE agentonic.connections SET credential_expires_at=expires
  WHERE id=(SELECT coalesce(s.reconnects,s.connection_id) FROM agentonic.gmail_oauth_states s WHERE s.state_hash=payload->>'state' AND s.workspace_id=agentonic.workspace_id() AND s.finished_at IS NOT NULL);
 ELSIF operation='list' THEN
  result:=jsonb_set(result,'{connections}',agentonic.google_expiries(result->'connections'));
 END IF;
 RETURN result;
END $$;
ALTER FUNCTION agentonic.drive_command(text,jsonb) RENAME TO drive_command_v77;
CREATE FUNCTION agentonic.drive_command(operation text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;expires timestamptz;
BEGIN
 IF operation='oauth.finish' THEN expires:=agentonic.google_grant_expiry(payload->>'expiresAt'); END IF;
 result:=agentonic.drive_command_v77(operation,payload);
 IF operation='oauth.finish' THEN
  UPDATE agentonic.connections SET credential_expires_at=expires WHERE id=(result->>'connectionId')::uuid AND workspace_id=agentonic.workspace_id();
 ELSIF operation IN ('list','knowledge.connections') THEN
  result:=jsonb_set(result,'{connections}',agentonic.google_expiries(result->'connections'));
 END IF;
 RETURN result;
END $$;

-- 10. Probar agente records the same reason when Google refuses the account.
ALTER FUNCTION agentonic.rag_worker(text,uuid,uuid,jsonb) RENAME TO rag_worker_v77;
CREATE FUNCTION agentonic.rag_worker(operation text,job_id uuid,token uuid,payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF operation='fail' AND payload->>'code'='google_reconnect' THEN
  IF NOT EXISTS(SELECT 1 FROM agentonic.background_jobs WHERE id=job_id AND preview_id IS NOT NULL) THEN RAISE insufficient_privilege; END IF;
  result:=agentonic.rag_worker_v77('fail',job_id,token,'{"code":"lease_lost"}');
  UPDATE agentonic.background_jobs SET error_code='google_reconnect' WHERE id=job_id AND status='failed' AND error_code='lease_lost';
  RETURN result;
 END IF;
 RETURN agentonic.rag_worker_v77(operation,job_id,token,payload);
END $$;

REVOKE ALL ON FUNCTION agentonic.gmail_reconnect_keeps_operations(),agentonic.gmail_grant_standing(agentonic.gmail_connections,uuid,uuid,text),agentonic.drive_grant_standing(agentonic.drive_connections,uuid,uuid,text),
 agentonic.deployment_waiting_google(agentonic.deployments),agentonic.google_grant_expiry(text),agentonic.google_expiries(jsonb),
 agentonic.staging_chat_v77(text,jsonb),agentonic.staging_chat(text,jsonb),agentonic.staging_worker_v77(text,uuid,text,uuid,uuid,jsonb),agentonic.staging_worker(text,uuid,text,uuid,uuid,jsonb),
 agentonic.deployment_host_v77(text,uuid,jsonb),agentonic.deployment_host(text,uuid,jsonb),agentonic.lifecycle_state_v77(uuid),agentonic.lifecycle_state(uuid),
 agentonic.gmail_command_v77(text,jsonb),agentonic.gmail_command(text,jsonb),agentonic.drive_command_v77(text,jsonb),agentonic.drive_command(text,jsonb),
 agentonic.rag_worker_v77(text,uuid,uuid,jsonb),agentonic.rag_worker(text,uuid,uuid,jsonb)
 FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_runtime_local,agentonic_runtime_azure,agentonic_deployer_local,agentonic_deployer_azure;
GRANT EXECUTE ON FUNCTION agentonic.staging_chat(text,jsonb),agentonic.gmail_command(text,jsonb),agentonic.drive_command(text,jsonb) TO agentonic_customer;
GRANT EXECUTE ON FUNCTION agentonic.lifecycle_state(uuid) TO agentonic_admin,agentonic_customer;
GRANT EXECUTE ON FUNCTION agentonic.staging_worker(text,uuid,text,uuid,uuid,jsonb) TO agentonic_runtime_local,agentonic_runtime_azure;
GRANT EXECUTE ON FUNCTION agentonic.deployment_host(text,uuid,jsonb) TO agentonic_deployer_local,agentonic_deployer_azure;
GRANT EXECUTE ON FUNCTION agentonic.rag_worker(text,uuid,uuid,jsonb) TO agentonic_worker;
COMMIT;
