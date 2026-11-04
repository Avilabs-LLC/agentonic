BEGIN;
-- New versions may approve Google operations for the invoking member. The null
-- account in a version is a declaration only. A personal deployment pins real
-- connection IDs once, under the workspace lock, and retains its own ledger.
ALTER TABLE agentonic.deployments ADD COLUMN member_tools jsonb;
DROP INDEX agentonic.deployment_preparing_slot;
DROP INDEX agentonic.deployment_running_slot;
CREATE UNIQUE INDEX deployment_preparing_slot ON agentonic.deployments(workspace_id,agent_id,environment,authorized_by_member_id) WHERE status IN ('queued','preparing');
CREATE UNIQUE INDEX deployment_running_slot ON agentonic.deployments(workspace_id,agent_id,environment,authorized_by_member_id) WHERE status='running';

CREATE UNIQUE INDEX deployment_legacy_preparing_slot ON agentonic.deployments(workspace_id,agent_id,environment) WHERE member_tools IS NULL AND status IN ('queued','preparing');
CREATE UNIQUE INDEX deployment_legacy_running_slot ON agentonic.deployments(workspace_id,agent_id,environment) WHERE member_tools IS NULL AND status='running';

CREATE FUNCTION agentonic.has_member_tools(tools jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT coalesce(tools @> '[{"connectionId":null}]' OR tools @> '[{"driveConnectionId":null}]',false)
$$;

CREATE OR REPLACE FUNCTION agentonic.member_can_invoke(m uuid,a uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM agentonic.agents a1 JOIN agentonic.workspace_members own ON own.id=a1.owner_member_id
 JOIN agentonic.users ou ON ou.id=own.user_id JOIN agentonic.workspace_members m1 ON m1.id=m AND m1.workspace_id=a1.workspace_id
 JOIN agentonic.users u ON u.id=m1.user_id JOIN agentonic.workspaces w ON w.id=a1.workspace_id
 WHERE a1.id=a AND a1.archived_at IS NULL AND a1.status<>'archived' AND own.status='active' AND own.removed_at IS NULL AND ou.deleted_at IS NULL
 AND m1.status='active' AND m1.removed_at IS NULL AND u.deleted_at IS NULL AND w.status='active' AND w.deleted_at IS NULL
 AND (a1.owner_member_id=m OR EXISTS(SELECT 1 FROM agentonic.agent_member_grants g WHERE g.agent_id=a AND g.member_id=m AND g.role IN ('maintainer','operator') AND g.revoked_at IS NULL AND g.granted_by_member_id=a1.owner_member_id)))
$$;

CREATE OR REPLACE FUNCTION agentonic.valid_gmail_tools(tools jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
DECLARE g jsonb; op text;
BEGIN
 IF jsonb_typeof(tools) IS DISTINCT FROM 'array' OR jsonb_array_length(tools)>1 THEN RETURN false; END IF;
 FOR g IN SELECT value FROM jsonb_array_elements(tools) LOOP
  IF jsonb_typeof(g) IS DISTINCT FROM 'object' OR g-ARRAY['connectionId','operations']<>'{}' OR NOT g ? 'connectionId' OR g->'connectionId' <> 'null'::jsonb AND coalesce(g->>'connectionId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR jsonb_typeof(g->'operations') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(g->'operations') NOT BETWEEN 1 AND 9 OR (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(g->'operations')) THEN RETURN false; END IF;
  FOR op IN SELECT jsonb_array_elements_text(g->'operations') LOOP
   IF op IS NULL OR op NOT IN ('gmail.search','gmail.read','gmail.drafts.list','gmail.drafts.read','gmail.drafts.create','gmail.drafts.update','gmail.drafts.delete','gmail.send','gmail.labels.apply') THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END $function$;

CREATE OR REPLACE FUNCTION agentonic.gmail_scope_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE tools jsonb; g jsonb; c agentonic.gmail_connections; m uuid;
BEGIN
 tools:=CASE WHEN TG_TABLE_NAME='configuration_drafts' THEN to_jsonb(NEW)->'requested_access'->'tools' ELSE to_jsonb(NEW)->'requested_access_snapshot'->'tools' END;
 m:=agentonic.current_member();
 IF NOT agentonic.valid_tools(tools) THEN RAISE insufficient_privilege; END IF;
 FOR g IN SELECT value FROM jsonb_array_elements(agentonic.gmail_grants(tools)) LOOP
  IF g->'connectionId'='null'::jsonb AND TG_TABLE_NAME='configuration_releases' AND NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=(to_jsonb(NEW)->>'code_release_id')::uuid AND execution_manifest->>'memberGoogleTools'='1') THEN RAISE EXCEPTION 'Member Google runtime required'; END IF;
  IF g->'connectionId' <> 'null'::jsonb THEN
   SELECT * INTO c FROM agentonic.gmail_connections WHERE id=(g->>'connectionId')::uuid AND workspace_id=NEW.workspace_id AND agent_id=NEW.agent_id;
  IF c.id IS NULL OR c.owner_member_id IS DISTINCT FROM m OR c.status<>'connected' OR NOT agentonic.member_can_author(m,NEW.agent_id)
   OR NOT (c.operations @> (g->'operations')) THEN RAISE insufficient_privilege; END IF;
  END IF;
  IF TG_TABLE_NAME='configuration_releases' AND NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=(to_jsonb(NEW)->>'code_release_id')::uuid AND execution_manifest->>'gmailContract'='1') THEN RAISE EXCEPTION 'Gmail runtime required'; END IF;
 END LOOP;
 IF agentonic.has_web(tools) AND TG_TABLE_NAME='configuration_releases' AND NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=(to_jsonb(NEW)->>'code_release_id')::uuid AND execution_manifest->>'webContract'='1') THEN RAISE EXCEPTION 'Web runtime required'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION agentonic.gmail_allowed(c agentonic.gmail_connections,m uuid,aid uuid,op text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(c.id IS NOT NULL AND c.status='connected' AND c.credential_ciphertext IS NOT NULL AND c.agent_id=aid AND c.owner_member_id=m
 AND agentonic.member_can_invoke(m,aid) AND c.operations ? op,false)
$$;

CREATE OR REPLACE FUNCTION agentonic.gmail_grant_standing(c agentonic.gmail_connections,m uuid,aid uuid,op text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(c.id IS NOT NULL AND ((c.status='connected' AND c.credential_ciphertext IS NOT NULL) OR c.status='reconnect') AND c.agent_id=aid AND c.owner_member_id=m
 AND agentonic.member_can_invoke(m,aid) AND c.operations ? op,false)
$$;

CREATE OR REPLACE FUNCTION agentonic.valid_drive_tools(tools jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE g jsonb; op text;
BEGIN
 IF jsonb_typeof(tools) IS DISTINCT FROM 'array' OR jsonb_array_length(tools)>1 THEN RETURN false; END IF;
 FOR g IN SELECT value FROM jsonb_array_elements(tools) LOOP
  IF jsonb_typeof(g) IS DISTINCT FROM 'object' OR g-ARRAY['driveConnectionId','operations']<>'{}' OR NOT g ? 'driveConnectionId' OR g->'driveConnectionId' <> 'null'::jsonb AND coalesce(g->>'driveConnectionId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
   OR jsonb_typeof(g->'operations') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(g->'operations') NOT BETWEEN 1 AND 4 OR (SELECT count(*)<>count(DISTINCT value) FROM jsonb_array_elements(g->'operations')) THEN RETURN false; END IF;
  FOR op IN SELECT jsonb_array_elements_text(g->'operations') LOOP
   IF op IS NULL OR op NOT IN ('drive.files.list','drive.files.read','drive.docs.create','drive.docs.update') THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION agentonic.drive_scope_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE tools jsonb; g jsonb; c agentonic.drive_connections; m uuid;
BEGIN
 tools:=CASE WHEN TG_TABLE_NAME='configuration_drafts' THEN to_jsonb(NEW)->'requested_access'->'tools' ELSE to_jsonb(NEW)->'requested_access_snapshot'->'tools' END;
 m:=agentonic.current_member();
 IF NOT agentonic.valid_drive_tools(agentonic.drive_grants(coalesce(tools,'[]'))) THEN RAISE insufficient_privilege; END IF;
 FOR g IN SELECT value FROM jsonb_array_elements(agentonic.drive_grants(coalesce(tools,'[]'))) LOOP
  IF g->'driveConnectionId'='null'::jsonb AND TG_TABLE_NAME='configuration_releases' AND NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=(to_jsonb(NEW)->>'code_release_id')::uuid AND execution_manifest->>'memberGoogleTools'='1') THEN RAISE EXCEPTION 'Member Google runtime required'; END IF;
  IF g->'driveConnectionId' <> 'null'::jsonb THEN
   SELECT * INTO c FROM agentonic.drive_connections WHERE id=(g->>'driveConnectionId')::uuid AND workspace_id=NEW.workspace_id AND agent_id=NEW.agent_id AND purpose='tools';
  IF c.id IS NULL OR c.owner_member_id IS DISTINCT FROM m OR c.status<>'connected' OR NOT agentonic.member_can_author(m,NEW.agent_id)
   OR NOT (c.operations @> (g->'operations')) THEN RAISE insufficient_privilege; END IF;
  END IF;
  IF TG_TABLE_NAME='configuration_releases' AND NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=(to_jsonb(NEW)->>'code_release_id')::uuid AND execution_manifest->>'driveContract'='1') THEN RAISE EXCEPTION 'Drive runtime required'; END IF;
 END LOOP;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION agentonic.drive_allowed(c agentonic.drive_connections,m uuid,aid uuid,op text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(c.id IS NOT NULL AND c.purpose='tools' AND c.status='connected' AND c.credential_ciphertext IS NOT NULL AND c.agent_id=aid AND c.owner_member_id=m
 AND agentonic.member_can_invoke(m,aid) AND c.operations ? op,false)
$$;

CREATE OR REPLACE FUNCTION agentonic.drive_grant_standing(c agentonic.drive_connections,m uuid,aid uuid,op text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(c.id IS NOT NULL AND c.purpose='tools' AND ((c.status='connected' AND c.credential_ciphertext IS NOT NULL) OR c.status='reconnect') AND c.agent_id=aid AND c.owner_member_id=m
 AND agentonic.member_can_invoke(m,aid) AND c.operations ? op,false)
$$;

CREATE FUNCTION agentonic.member_google_choices(r agentonic.configuration_releases, m uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('key',k,'operations',g->'operations','accounts',accounts)),'[]')
 FROM (
  SELECT 'connectionId' k, g, (SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.account) ORDER BY c.account,c.id),'[]')
   FROM agentonic.gmail_connections c WHERE c.workspace_id=r.workspace_id AND c.agent_id=r.agent_id AND c.owner_member_id=m
   AND c.status='connected' AND c.credential_ciphertext IS NOT NULL AND c.operations @> (g->'operations')
   AND (NOT (g->'operations' ? 'gmail.labels.apply') OR c.can_label)) accounts
  FROM jsonb_array_elements(r.requested_access_snapshot->'tools') g WHERE g->'connectionId'='null'::jsonb
  UNION ALL
  SELECT 'driveConnectionId', g, (SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.account) ORDER BY c.account,c.id),'[]')
   FROM agentonic.drive_connections c WHERE c.workspace_id=r.workspace_id AND c.agent_id=r.agent_id AND c.owner_member_id=m
   AND c.status='connected' AND c.purpose='tools' AND c.credential_ciphertext IS NOT NULL AND c.operations @> (g->'operations'))
  FROM jsonb_array_elements(r.requested_access_snapshot->'tools') g WHERE g->'driveConnectionId'='null'::jsonb
 ) matches
$$;

CREATE FUNCTION agentonic.bind_member_tools(r agentonic.configuration_releases, m uuid, selected jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE g jsonb; bindings jsonb:='[]'; choices jsonb:=agentonic.member_google_choices(r,m); accounts jsonb; k text; chosen text;
BEGIN
 FOR g IN SELECT value FROM jsonb_array_elements(r.requested_access_snapshot->'tools') LOOP
  k:=CASE WHEN g->'connectionId'='null'::jsonb THEN 'connectionId' WHEN g->'driveConnectionId'='null'::jsonb THEN 'driveConnectionId' END;
  IF k IS NOT NULL THEN
   SELECT c->'accounts' INTO accounts FROM jsonb_array_elements(choices) c WHERE c->>'key'=k;
   chosen:=coalesce(selected->>k, CASE WHEN jsonb_array_length(accounts)=1 THEN accounts->0->>'id' END);
   IF chosen IS NULL OR NOT accounts @> jsonb_build_array(jsonb_build_object('id',chosen)) THEN RETURN NULL; END IF;
   g:=jsonb_set(g,ARRAY[k],to_jsonb(chosen));
  END IF;
  bindings:=bindings||jsonb_build_array(g);
 END LOOP;
 RETURN bindings;
END $$;

CREATE OR REPLACE FUNCTION agentonic.gmail_deployment_scope(r agentonic.configuration_releases,m uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE g jsonb; op text;c agentonic.gmail_connections;
BEGIN
 IF NOT agentonic.valid_gmail_tools(agentonic.gmail_grants(r.requested_access_snapshot->'tools')) THEN RETURN false; END IF;
 IF agentonic.gmail_grants(r.requested_access_snapshot->'tools')='[]' THEN RETURN true; END IF;
 IF NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=r.code_release_id AND execution_manifest->>'gmailContract'='1') THEN RETURN false; END IF;
 FOR g IN SELECT value FROM jsonb_array_elements(agentonic.gmail_grants(r.requested_access_snapshot->'tools')) LOOP
  SELECT * INTO c FROM agentonic.gmail_connections WHERE id=(g->>'connectionId')::uuid AND workspace_id=r.workspace_id AND agent_id=r.agent_id;
  FOR op IN SELECT jsonb_array_elements_text(g->'operations') LOOP
   IF NOT agentonic.gmail_grant_standing(c,m,r.agent_id,op) OR NOT EXISTS(SELECT 1 FROM agentonic.configuration_tools config JOIN agentonic.code_tools code ON code.id=config.code_tool_id AND code.code_release_id=config.code_release_id WHERE config.configuration_release_id=r.id AND config.enabled AND code.package_key='gmail-v1' AND code.name=op AND (config.effective_policy->>'connectionId'=c.id::text OR
      (config.effective_policy->'connectionId'='null'::jsonb AND EXISTS(SELECT 1 FROM agentonic.configuration_releases frozen
        WHERE frozen.id=r.id AND frozen.requested_access_snapshot->'tools' @> jsonb_build_array(jsonb_build_object('connectionId',NULL,'operations',jsonb_build_array(op))))))) THEN RETURN false; END IF;
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
    WHERE config.configuration_release_id=r.id AND config.enabled AND code.package_key='drive-v1' AND code.name=op AND (config.effective_policy->>'connectionId'=c.id::text OR
      (config.effective_policy->'connectionId'='null'::jsonb AND EXISTS(SELECT 1 FROM agentonic.configuration_releases frozen
        WHERE frozen.id=r.id AND frozen.requested_access_snapshot->'tools' @> jsonb_build_array(jsonb_build_object('driveConnectionId',NULL,'operations',jsonb_build_array(op))))))) THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 RETURN true;
END $$;

CREATE FUNCTION agentonic.bound_release(r agentonic.configuration_releases, tools jsonb) RETURNS agentonic.configuration_releases
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
BEGIN
 IF tools IS NOT NULL THEN r.requested_access_snapshot:=jsonb_set(r.requested_access_snapshot,'{tools}',tools); END IF;
 RETURN r;
END $$;

CREATE OR REPLACE FUNCTION agentonic.deployment_authorized_v30(d agentonic.deployments)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE r agentonic.configuration_releases;decision agentonic.submission_review_decisions;
BEGIN
 IF d.id IS NULL OR d.revoked_at IS NOT NULL OR d.authorized_until<=clock_timestamp() OR NOT (CASE WHEN d.member_tools IS NULL THEN agentonic.member_can_author(d.authorized_by_member_id,d.agent_id) ELSE agentonic.member_can_invoke(d.authorized_by_member_id,d.agent_id) END) THEN RETURN false; END IF;
 SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id AND workspace_id=d.workspace_id;
 SELECT * INTO decision FROM agentonic.submission_review_decisions WHERE id=d.approval_id;
 RETURN coalesce(r.retired_at IS NULL AND r.id IS NOT NULL AND agentonic.gmail_deployment_scope(agentonic.bound_release(r,d.member_tools),d.authorized_by_member_id)
 AND decision.decision='approved' AND decision.approved_access_sha256=r.requested_access_sha256
 AND NOT EXISTS(SELECT 1 FROM agentonic.submission_review_decisions later WHERE later.submission_id=d.submission_id AND later.decision_number>decision.decision_number)
 AND EXISTS(SELECT 1 FROM agentonic.agent_submissions s WHERE s.id=d.submission_id AND s.status='approved')
 AND EXISTS(SELECT 1 FROM agentonic.evaluation_runs e WHERE e.id=(decision.assessment_snapshot->>'evaluationId')::uuid AND e.consent_revoked_at IS NULL)
 AND (decision.actor_staff_id IS NULL OR EXISTS(SELECT 1 FROM agentonic.platform_staff st JOIN agentonic.users u ON u.id=st.user_id WHERE st.id=decision.actor_staff_id AND st.disabled_at IS NULL AND st.role IN ('administrator','operator') AND u.deleted_at IS NULL))
 AND EXISTS(SELECT 1 FROM agentonic.code_releases code JOIN agentonic.workspace_code_release_grants g ON g.code_release_id=code.id AND g.workspace_id=d.workspace_id
  JOIN agentonic.code_repositories repo ON repo.id=code.code_repository_id JOIN agentonic.runtime_hosts h ON h.id=d.host_id
  WHERE code.id=d.code_release_id AND code.revoked_at IS NULL AND code.retired_at IS NULL AND g.revoked_at IS NULL
  AND repo.provisioning_status='ready' AND (repo.visibility='platform' OR repo.workspace_id=d.workspace_id)
  AND code.execution_manifest->>'previewContract'='1' AND h.environment=d.environment AND h.revoked_at IS NULL AND h.verified_at>clock_timestamp()-interval '30 days' AND agentonic.host_runs(h.id,code.artifact_sha256))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.requested_access_snapshot->'collectionIds') c WHERE NOT agentonic.member_can_collection(d.authorized_by_member_id,c::uuid,'read'))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.requested_access_snapshot->'collections') col CROSS JOIN LATERAL jsonb_array_elements(col->'sources') src
  WHERE NOT EXISTS(SELECT 1 FROM agentonic.knowledge_sources k WHERE k.id=(src->>'id')::uuid AND k.workspace_id=d.workspace_id AND k.collection_id=(col->>'id')::uuid
   AND k.definition_sha256=src->>'hash' AND k.definition_revision=(src->>'revision')::bigint AND k.environment='staging' AND agentonic.knowledge_source_usable(k) AND k.access_mode='collection'
   AND k.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb AND agentonic.member_can_collection(k.authorized_by_member_id,k.collection_id,'curate')))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d.evidence_sources) hit WHERE NOT EXISTS(
  SELECT 1 FROM agentonic.document_chunks c JOIN agentonic.document_versions v ON v.id=c.document_version_id JOIN agentonic.documents doc ON doc.id=v.document_id
  WHERE c.workspace_id=d.workspace_id AND c.id=(hit->>'id')::uuid AND c.content_sha256=hit->>'hash' AND v.status='ready' AND doc.active_version_id=v.id AND doc.deleted_at IS NULL)),false);
END $function$;

CREATE OR REPLACE FUNCTION agentonic.deployment_authorized(d agentonic.deployments) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT agentonic.deployment_authorized_v30(d) AND EXISTS(SELECT 1 FROM agentonic.configuration_releases r WHERE r.id=d.configuration_release_id AND agentonic.valid_tools(r.requested_access_snapshot->'tools') AND agentonic.web_scope(r) AND agentonic.drive_deployment_scope(agentonic.bound_release(r,d.member_tools),d.authorized_by_member_id))
$$;

CREATE OR REPLACE FUNCTION agentonic.gmail_staging(operation text, deployment_id uuid, secret text, job_id uuid, token uuid, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_variable
DECLARE d agentonic.deployments;conv agentonic.staging_conversations;t agentonic.staging_turns;r agentonic.configuration_releases;c agentonic.gmail_connections;g jsonb;op text:=payload->>'operation';
BEGIN
 PERFORM agentonic.staging_worker('heartbeat',deployment_id,secret,job_id,token,'{}');
 SELECT * INTO d FROM agentonic.deployments WHERE id=deployment_id;
 SELECT * INTO t FROM agentonic.staging_turns WHERE id=job_id;
 SELECT * INTO conv FROM agentonic.staging_conversations WHERE id=t.conversation_id;
 SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id;
 IF NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=r.code_release_id AND execution_manifest->>'gmailContract'='1') THEN RAISE insufficient_privilege; END IF;
 IF operation='gmail-tools' THEN RETURN jsonb_build_object('tools',agentonic.gmail_tools_usable(coalesce(d.member_tools,r.requested_access_snapshot->'tools'))); END IF;
 SELECT value INTO g FROM jsonb_array_elements(coalesce(d.member_tools,r.requested_access_snapshot->'tools')) WHERE value->>'connectionId'=payload->>'connectionId' AND value->'operations' ? op;
 SELECT * INTO c FROM agentonic.gmail_connections WHERE id=(g->>'connectionId')::uuid AND workspace_id=d.workspace_id AND agent_id=d.agent_id FOR UPDATE;
 IF NOT agentonic.gmail_allowed(c,conv.owner_member_id,d.agent_id,op) THEN RAISE insufficient_privilege; END IF;
 IF operation='gmail-read' AND op IN ('gmail.search','gmail.read','gmail.drafts.list','gmail.drafts.read') THEN RETURN jsonb_build_object('credential',c.credential_ciphertext,'account',c.account); END IF;
 IF operation='gmail-reconnect' THEN
  UPDATE agentonic.gmail_connections SET status='reconnect',credential_ciphertext=NULL,operations='[]' WHERE id=c.id;
  UPDATE agentonic.gmail_invocations SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,arguments_ciphertext=NULL WHERE connection_id=c.id;
  RETURN '{"ok":true}';
 END IF;
 IF operation='gmail-check' THEN RETURN '{"ok":true}'; END IF;
 IF operation='gmail-propose' AND op IN ('gmail.drafts.create','gmail.drafts.update','gmail.drafts.delete','gmail.send','gmail.labels.apply') AND (op<>'gmail.labels.apply' OR c.can_label) THEN
  IF (SELECT count(*) FROM agentonic.gmail_invocations WHERE turn_id=job_id)>=10 OR (SELECT count(*) FROM agentonic.gmail_invocations WHERE owner_member_id=conv.owner_member_id AND created_at>clock_timestamp()-interval '1 hour')>=30 THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.gmail_invocations(id,workspace_id,agent_id,connection_id,owner_member_id,turn_id,conversation_id,operation,arguments_ciphertext,arguments_sha256)
  VALUES((payload->>'id')::uuid,d.workspace_id,d.agent_id,c.id,conv.owner_member_id,job_id,conv.id,op,payload->>'argumentsCiphertext',payload->>'hash');
  RETURN jsonb_build_object('pendingApproval',true,'id',payload->>'id','automatic',(SELECT approved_by_schedule_id IS NOT NULL FROM agentonic.gmail_invocations WHERE id=(payload->>'id')::uuid));
 END IF;
 RAISE insufficient_privilege;
END $function$;

CREATE OR REPLACE FUNCTION agentonic.drive_staging(operation text,deployment_id uuid,secret text,job_id uuid,token uuid,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE d agentonic.deployments;conv agentonic.staging_conversations;t agentonic.staging_turns;r agentonic.configuration_releases;
BEGIN
 PERFORM agentonic.staging_worker('heartbeat',deployment_id,secret,job_id,token,'{}');
 SELECT * INTO d FROM agentonic.deployments WHERE id=deployment_id;
 SELECT * INTO t FROM agentonic.staging_turns WHERE id=job_id;
 SELECT * INTO conv FROM agentonic.staging_conversations WHERE id=t.conversation_id;
 SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id;
 RETURN agentonic.drive_tool_step(operation,r,coalesce(d.member_tools,r.requested_access_snapshot->'tools'),d.workspace_id,d.agent_id,conv.owner_member_id,job_id,conv.id,'staging',NULL,payload);
END $$;

CREATE OR REPLACE FUNCTION agentonic.gmail_command_v29(operation text, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_variable
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();aid uuid:=(payload->>'agentId')::uuid;
 s agentonic.gmail_oauth_states;c agentonic.gmail_connections;i agentonic.gmail_invocations;conv agentonic.staging_conversations;d agentonic.deployments;r agentonic.configuration_releases;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR w IS NULL OR m IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 -- Expired private proposals are erased; only content-free audit remains.
 UPDATE agentonic.gmail_invocations SET status=CASE WHEN status='pending' THEN 'expired' WHEN status='executing' THEN 'uncertain' ELSE status END,arguments_ciphertext=NULL
 WHERE workspace_id=w AND expires_at<=clock_timestamp() AND arguments_ciphertext IS NOT NULL;
 DELETE FROM agentonic.gmail_oauth_states WHERE workspace_id=w AND expires_at<clock_timestamp()-interval '1 hour';
 IF operation IN ('list','oauth.start','permissions') AND (aid IS NULL OR NOT agentonic.can_agent(aid,'invoke')) THEN RAISE insufficient_privilege; END IF;
 IF operation='list' THEN
  RETURN jsonb_build_object('connections',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'account',account,'status',status,'operations',operations,'canLabel',can_label) ORDER BY created_at) FROM agentonic.gmail_connections WHERE workspace_id=w AND agent_id=aid AND owner_member_id=m AND status<>'disconnected'),'[]'));
 ELSIF operation='oauth.start' THEN
  IF (SELECT count(*) FROM agentonic.gmail_oauth_states WHERE owner_member_id=m AND expires_at>clock_timestamp())>=5 THEN RAISE insufficient_privilege; END IF;
  -- A reconnect refreshes one of the member's own connections for this agent (§68).
  IF payload ? 'reconnect' AND NOT EXISTS(SELECT 1 FROM agentonic.gmail_connections WHERE id=(payload->>'reconnect')::uuid AND workspace_id=w AND agent_id=aid AND owner_member_id=m AND status<>'disconnected') THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.gmail_oauth_states(state_hash,workspace_id,agent_id,owner_member_id,connection_id,verifier_ciphertext,reconnects) VALUES(payload->>'state',w,aid,m,(payload->>'connectionId')::uuid,payload->>'verifier',(payload->>'reconnect')::uuid); RETURN '{"ok":true}';
 ELSIF operation IN ('oauth.consume','oauth.finish') THEN
  SELECT * INTO s FROM agentonic.gmail_oauth_states WHERE state_hash=payload->>'state' AND workspace_id=w AND owner_member_id=m FOR UPDATE;
  IF s.state_hash IS NULL OR s.expires_at<=clock_timestamp() OR s.finished_at IS NOT NULL OR NOT agentonic.can_agent(s.agent_id,'invoke') THEN RAISE insufficient_privilege; END IF;
  IF operation='oauth.consume' THEN
   IF s.consumed_at IS NOT NULL THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.gmail_oauth_states SET consumed_at=clock_timestamp() WHERE state_hash=s.state_hash;
   RETURN jsonb_build_object('agentId',s.agent_id,'connectionId',coalesce(s.reconnects,s.connection_id),'verifier',s.verifier_ciphertext);
  END IF;
  IF s.consumed_at IS NULL THEN RAISE insufficient_privilege; END IF;
  IF s.reconnects IS NOT NULL THEN
   SELECT * INTO c FROM agentonic.gmail_connections WHERE id=s.reconnects AND workspace_id=w AND agent_id=s.agent_id AND owner_member_id=m FOR UPDATE;
   -- Only the same Google account refreshes a connection; its tools stay.
   IF c.id IS NULL OR c.status='disconnected' OR lower(c.account)<>lower(payload->>'account') THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.gmail_connections SET credential_ciphertext=payload->>'credential',status='connected',can_label=coalesce((payload->>'canLabel')::boolean,false) WHERE id=c.id;
  ELSE
   INSERT INTO agentonic.gmail_connections(id,workspace_id,agent_id,owner_member_id,account,credential_ciphertext,can_label) VALUES(s.connection_id,w,s.agent_id,m,payload->>'account',payload->>'credential',coalesce((payload->>'canLabel')::boolean,false));
  END IF;
  UPDATE agentonic.gmail_oauth_states SET finished_at=clock_timestamp(),verifier_ciphertext='' WHERE state_hash=s.state_hash;
  RETURN jsonb_build_object('agentId',s.agent_id);
 ELSIF operation IN ('disconnect','permissions','credential','reconnect') THEN
  SELECT * INTO c FROM agentonic.gmail_connections WHERE id=(payload->>'connectionId')::uuid AND workspace_id=w AND owner_member_id=m FOR UPDATE;
  IF c.id IS NULL OR NOT agentonic.can_agent(c.agent_id,'invoke') THEN RAISE insufficient_privilege; END IF;
  IF operation='disconnect' THEN
   UPDATE agentonic.gmail_connections SET status='disconnected',credential_ciphertext=NULL,operations='[]' WHERE id=c.id;
   UPDATE agentonic.gmail_invocations SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,arguments_ciphertext=NULL WHERE connection_id=c.id;
   RETURN jsonb_build_object('credential',c.credential_ciphertext);
  ELSIF operation='reconnect' THEN
   UPDATE agentonic.gmail_connections SET status='reconnect',credential_ciphertext=NULL,operations='[]' WHERE id=c.id; RETURN '{"ok":true}';
  ELSIF operation='permissions' THEN
   IF c.agent_id<>aid OR c.status<>'connected' OR (payload->'operations' ? 'gmail.labels.apply' AND NOT c.can_label) OR NOT agentonic.valid_gmail_tools(jsonb_build_array(jsonb_build_object('connectionId',c.id,'operations',payload->'operations'))) AND payload->'operations'<>'[]' THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.gmail_connections SET operations=payload->'operations' WHERE id=c.id; RETURN '{"ok":true}';
  ELSE RAISE insufficient_privilege; END IF;
 ELSIF operation IN ('invocations','inspect','confirm','cancel','complete') THEN
  IF operation='invocations' THEN
   SELECT * INTO conv FROM agentonic.staging_conversations WHERE id=(payload->>'conversationId')::uuid AND workspace_id=w AND owner_member_id=m;
   IF conv.id IS NULL OR NOT agentonic.staging_conversation_readable(conv) THEN RAISE insufficient_privilege; END IF;
   RETURN jsonb_build_object('items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'operation',v.operation,'account',gc.account,'status',v.status,'hash',v.arguments_sha256,'expiresAt',v.expires_at,'argumentsCiphertext',v.arguments_ciphertext,'result',v.result,'automatic',v.approved_by_schedule_id IS NOT NULL) ORDER BY v.created_at) FROM agentonic.gmail_invocations v JOIN agentonic.gmail_connections gc ON gc.id=v.connection_id WHERE v.conversation_id=conv.id AND v.owner_member_id=m AND gc.status='connected'),'[]'));
  END IF;
  SELECT * INTO i FROM agentonic.gmail_invocations WHERE id=(payload->>'id')::uuid AND workspace_id=w AND owner_member_id=m FOR UPDATE;
  IF i.id IS NULL THEN RAISE insufficient_privilege; END IF;
  IF operation='complete' THEN
   IF i.status<>'executing' OR payload->>'status' NOT IN ('succeeded','failed','uncertain') THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.gmail_invocations SET status=payload->>'status',result=payload->'result',finished_at=clock_timestamp(),arguments_ciphertext=NULL WHERE id=i.id; RETURN '{"ok":true}';
  END IF;
  SELECT * INTO conv FROM agentonic.staging_conversations WHERE id=i.conversation_id AND owner_member_id=m;
  SELECT * INTO c FROM agentonic.gmail_connections WHERE id=i.connection_id;
  SELECT * INTO d FROM agentonic.deployments WHERE id=conv.deployment_id;
  SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id;
  IF NOT agentonic.staging_conversation_authorized(conv) OR NOT agentonic.gmail_allowed(c,m,i.agent_id,i.operation)
   OR NOT (coalesce(d.member_tools,r.requested_access_snapshot->'tools')) @> jsonb_build_array(jsonb_build_object('connectionId',c.id,'operations',jsonb_build_array(i.operation))) THEN RAISE insufficient_privilege; END IF;
  IF operation='cancel' THEN
   IF i.status<>'pending' THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.gmail_invocations SET status='cancelled',arguments_ciphertext=NULL WHERE id=i.id; RETURN '{"ok":true}';
  END IF;
  IF i.status<>'pending' OR i.expires_at<=clock_timestamp() OR i.arguments_ciphertext IS NULL OR i.arguments_sha256 IS DISTINCT FROM payload->>'hash' OR i.approved_by_schedule_id IS NOT NULL THEN RAISE insufficient_privilege; END IF;
  IF operation='confirm' THEN
   UPDATE agentonic.gmail_invocations SET status='executing',approved_at=clock_timestamp() WHERE id=i.id;
  END IF;
  RETURN jsonb_build_object('credential',c.credential_ciphertext,'connectionId',c.id,'account',c.account,'argumentsCiphertext',i.arguments_ciphertext,'operation',i.operation);
 END IF;
 RAISE insufficient_privilege;
END $function$;

CREATE OR REPLACE FUNCTION agentonic.drive_command_v77(operation text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();aid uuid:=(payload->>'agentId')::uuid;
 s agentonic.drive_oauth_states;c agentonic.drive_connections;i agentonic.drive_invocations;conv agentonic.staging_conversations;p agentonic.agent_previews;
 d agentonic.deployments;r agentonic.configuration_releases;f agentonic.drive_knowledge_files;item jsonb;target uuid;src uuid;doc uuid;n integer:=0;tools jsonb;collection uuid;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR w IS NULL OR m IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 -- Expired proposals are erased; only content-free audit remains. A write still
 -- executing keeps 15 minutes past its window to record its real outcome.
 UPDATE agentonic.drive_invocations SET status='expired',arguments_ciphertext=NULL WHERE workspace_id=w AND status='pending' AND expires_at<=clock_timestamp();
 UPDATE agentonic.drive_invocations SET status='uncertain',arguments_ciphertext=NULL WHERE workspace_id=w AND status='executing' AND expires_at<=clock_timestamp()-interval '15 minutes';
 DELETE FROM agentonic.drive_oauth_states WHERE workspace_id=w AND expires_at<clock_timestamp()-interval '1 hour';
 IF operation='list' THEN
  IF aid IS NULL OR NOT agentonic.can_agent(aid,'invoke') THEN RAISE insufficient_privilege; END IF;
  RETURN jsonb_build_object('connections',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c0.id,'account',c0.account,'status',c0.status,'operations',c0.operations,
   'files',coalesce((SELECT jsonb_agg(jsonb_build_object('fileId',f0.file_id,'name',f0.name,'mimeType',f0.mime_type,'origin',f0.origin,'addedAt',f0.created_at) ORDER BY f0.created_at,f0.file_id) FROM agentonic.drive_files f0 WHERE f0.connection_id=c0.id),'[]'::jsonb))
   ORDER BY c0.created_at) FROM agentonic.drive_connections c0 WHERE c0.workspace_id=w AND c0.agent_id=aid AND c0.purpose='tools' AND c0.owner_member_id=m AND c0.status<>'disconnected'),'[]'));
 ELSIF operation='knowledge.connections' THEN
  RETURN jsonb_build_object('connections',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c0.id,'account',c0.account,'status',c0.status,
   'files',(SELECT count(*) FROM agentonic.drive_knowledge_files f0 WHERE f0.connection_id=c0.id)) ORDER BY c0.created_at)
   FROM agentonic.drive_connections c0 WHERE c0.workspace_id=w AND c0.purpose='knowledge' AND c0.owner_member_id=m AND c0.status<>'disconnected'),'[]'));
 ELSIF operation='oauth.start' THEN
  IF payload->>'purpose'='tools' THEN
   IF aid IS NULL OR NOT agentonic.can_agent(aid,'invoke') THEN RAISE insufficient_privilege; END IF;
  ELSIF payload->>'purpose'='knowledge' THEN
   aid:=NULL;
   IF NOT EXISTS(SELECT 1 FROM agentonic.knowledge_collections kc WHERE kc.workspace_id=w AND kc.archived_at IS NULL AND agentonic.can_collection(kc.id,'curate')) THEN RAISE insufficient_privilege; END IF;
  ELSE RAISE insufficient_privilege; END IF;
  IF (SELECT count(*) FROM agentonic.drive_oauth_states WHERE owner_member_id=m AND expires_at>clock_timestamp())>=5 THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.drive_oauth_states(state_hash,workspace_id,purpose,agent_id,owner_member_id,connection_id,verifier_ciphertext)
  VALUES(payload->>'state',w,payload->>'purpose',aid,m,(payload->>'connectionId')::uuid,payload->>'verifier');
  RETURN '{"ok":true}';
 ELSIF operation IN ('oauth.consume','oauth.target','oauth.finish') THEN
  SELECT * INTO s FROM agentonic.drive_oauth_states WHERE state_hash=payload->>'state' AND workspace_id=w AND owner_member_id=m FOR UPDATE;
  IF s.state_hash IS NULL OR s.expires_at<=clock_timestamp() OR s.finished_at IS NOT NULL OR (s.purpose='tools' AND NOT agentonic.can_agent(s.agent_id,'invoke')) THEN RAISE insufficient_privilege; END IF;
  IF operation='oauth.consume' THEN
   IF s.consumed_at IS NOT NULL THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.drive_oauth_states SET consumed_at=clock_timestamp() WHERE state_hash=s.state_hash;
   RETURN jsonb_build_object('purpose',s.purpose,'agentId',s.agent_id,'connectionId',s.connection_id,'verifier',s.verifier_ciphertext);
  END IF;
  IF s.consumed_at IS NULL OR coalesce(length(payload->>'account'),0) NOT BETWEEN 3 AND 254 THEN RAISE insufficient_privilege; END IF;
  -- Connecting the same account again revives its connection, with its files,
  -- operations and imported knowledge, instead of starting another.
  SELECT * INTO c FROM agentonic.drive_connections WHERE workspace_id=w AND purpose=s.purpose AND owner_member_id=m AND agent_id IS NOT DISTINCT FROM s.agent_id
   AND account=lower(payload->>'account') AND status<>'disconnected' ORDER BY created_at LIMIT 1 FOR UPDATE;
  target:=coalesce(c.id,s.connection_id);
  IF operation='oauth.target' THEN RETURN jsonb_build_object('connectionId',target); END IF;
  IF (payload->>'connectionId')::uuid IS DISTINCT FROM target OR payload->>'credential' IS NULL THEN RAISE insufficient_privilege; END IF;
  IF c.id IS NULL THEN
   INSERT INTO agentonic.drive_connections(id,workspace_id,purpose,agent_id,owner_member_id,account,credential_ciphertext)
   VALUES(s.connection_id,w,s.purpose,s.agent_id,m,lower(payload->>'account'),payload->>'credential');
  ELSE
   UPDATE agentonic.drive_connections SET status='connected',credential_ciphertext=payload->>'credential' WHERE id=c.id;
  END IF;
  UPDATE agentonic.drive_oauth_states SET finished_at=clock_timestamp(),verifier_ciphertext='' WHERE state_hash=s.state_hash;
  RETURN jsonb_build_object('purpose',s.purpose,'agentId',s.agent_id,'connectionId',target);
 ELSIF operation IN ('disconnect','reconnect','permissions','credential','files.add','files.remove') THEN
  SELECT * INTO c FROM agentonic.drive_connections WHERE id=(payload->>'connectionId')::uuid AND workspace_id=w AND owner_member_id=m FOR UPDATE;
  IF c.id IS NULL OR c.status='disconnected' OR (c.purpose='tools' AND NOT agentonic.can_agent(c.agent_id,'invoke')) THEN RAISE insufficient_privilege; END IF;
  IF operation='disconnect' THEN
   PERFORM agentonic.drive_disconnect(c.id);
   RETURN jsonb_build_object('credential',c.credential_ciphertext,'account',c.account);
  ELSIF operation='reconnect' THEN
   UPDATE agentonic.drive_connections SET status='reconnect',credential_ciphertext=NULL WHERE id=c.id;
   RETURN '{"ok":true}';
  ELSIF operation='credential' THEN
   IF c.status<>'connected' THEN RAISE insufficient_privilege; END IF;
   RETURN jsonb_build_object('credential',c.credential_ciphertext,'account',c.account,'purpose',c.purpose);
  ELSIF operation='permissions' THEN
   IF c.purpose<>'tools' OR c.agent_id IS DISTINCT FROM aid OR c.status<>'connected' OR jsonb_typeof(payload->'operations') IS DISTINCT FROM 'array'
    OR (payload->'operations'<>'[]' AND NOT agentonic.valid_drive_tools(jsonb_build_array(jsonb_build_object('driveConnectionId',c.id,'operations',payload->'operations')))) THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.drive_connections SET operations=payload->'operations' WHERE id=c.id;
   RETURN '{"ok":true}';
  ELSIF operation='files.add' THEN
   IF c.purpose<>'tools' OR c.agent_id IS DISTINCT FROM aid OR c.status<>'connected' OR jsonb_typeof(payload->'files') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'files') NOT BETWEEN 1 AND 25 THEN RAISE insufficient_privilege; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'files') x WHERE NOT agentonic.drive_type_supported(x.value->>'mimeType') OR coalesce(x.value->>'fileId','') !~ '^[a-zA-Z0-9_-]{10,200}$' OR coalesce(length(x.value->>'name'),0)=0) THEN RAISE insufficient_privilege; END IF;
   IF (SELECT count(*) FROM (SELECT file_id FROM agentonic.drive_files WHERE connection_id=c.id UNION SELECT x.value->>'fileId' FROM jsonb_array_elements(payload->'files') x) ids)>25 THEN RETURN '{"ok":false,"code":"too_many_files"}'; END IF;
   FOR item IN SELECT value FROM jsonb_array_elements(payload->'files') LOOP
    INSERT INTO agentonic.drive_files(workspace_id,connection_id,file_id,name,mime_type,origin,added_by_member_id) VALUES(w,c.id,item->>'fileId',left(item->>'name',500),item->>'mimeType','picked',m)
    ON CONFLICT(connection_id,file_id) DO UPDATE SET name=EXCLUDED.name,mime_type=EXCLUDED.mime_type;
   END LOOP;
   RETURN '{"ok":true}';
  ELSE
   IF c.purpose<>'tools' OR c.agent_id IS DISTINCT FROM aid THEN RAISE insufficient_privilege; END IF;
   DELETE FROM agentonic.drive_files WHERE connection_id=c.id AND file_id=payload->>'fileId';
   RETURN '{"ok":true}';
  END IF;
 ELSIF operation='invocations' THEN
  IF payload->>'context'='preview' THEN
   SELECT * INTO p FROM agentonic.agent_previews WHERE id=(payload->>'conversationId')::uuid AND workspace_id=w AND requested_by_member_id=m;
   IF p.id IS NULL OR NOT agentonic.preview_authorized(p) THEN RAISE insufficient_privilege; END IF;
  ELSE
   SELECT * INTO conv FROM agentonic.staging_conversations WHERE id=(payload->>'conversationId')::uuid AND workspace_id=w AND owner_member_id=m;
   IF conv.id IS NULL OR NOT agentonic.staging_conversation_readable(conv) THEN RAISE insufficient_privilege; END IF;
  END IF;
  RETURN jsonb_build_object('items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'operation',v.operation,'account',dc.account,'status',v.status,'hash',v.arguments_sha256,
    'expiresAt',v.expires_at,'argumentsCiphertext',v.arguments_ciphertext,'result',v.result,'automatic',v.approved_by_schedule_id IS NOT NULL) ORDER BY v.created_at)
   FROM agentonic.drive_invocations v JOIN agentonic.drive_connections dc ON dc.id=v.connection_id
   WHERE v.conversation_id=coalesce(p.id,conv.id) AND v.execution_context=CASE WHEN p.id IS NULL THEN 'staging' ELSE 'preview' END AND v.owner_member_id=m AND dc.status='connected'),'[]'));
 ELSIF operation IN ('inspect','confirm','cancel','complete') THEN
  SELECT * INTO i FROM agentonic.drive_invocations WHERE id=(payload->>'id')::uuid AND workspace_id=w AND owner_member_id=m FOR UPDATE;
  IF i.id IS NULL THEN RAISE insufficient_privilege; END IF;
  IF operation='complete' THEN
   -- Records an attempted provider call's outcome, never repeats it, even if
   -- the chat or preview ended meanwhile.
   IF i.status<>'executing' OR i.approved_by_schedule_id IS NOT NULL OR payload->>'status' NOT IN ('succeeded','failed','uncertain') THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.drive_invocations SET status=payload->>'status',result=agentonic.drive_result(payload->'result'),finished_at=clock_timestamp(),arguments_ciphertext=NULL WHERE id=i.id;
   IF payload->>'status'='succeeded' THEN PERFORM agentonic.drive_record_result(i,payload->'result'); END IF;
   RETURN '{"ok":true}';
  END IF;
  SELECT * INTO c FROM agentonic.drive_connections WHERE id=i.connection_id;
  IF i.execution_context='preview' THEN
   SELECT * INTO p FROM agentonic.agent_previews WHERE id=i.conversation_id AND workspace_id=w AND requested_by_member_id=m AND agent_id=i.agent_id;
   IF p.id IS NULL OR NOT agentonic.preview_authorized(p) THEN RAISE insufficient_privilege; END IF;
   tools:=p.execution_policy->'tools';
  ELSE
   SELECT * INTO conv FROM agentonic.staging_conversations WHERE id=i.conversation_id AND owner_member_id=m;
   IF conv.id IS NULL OR NOT agentonic.staging_conversation_authorized(conv) THEN RAISE insufficient_privilege; END IF;
   SELECT * INTO d FROM agentonic.deployments WHERE id=conv.deployment_id;
   SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id;
   tools:=coalesce(d.member_tools,r.requested_access_snapshot->'tools');
  END IF;
  IF NOT agentonic.drive_allowed(c,m,i.agent_id,i.operation)
   OR NOT coalesce(tools @> jsonb_build_array(jsonb_build_object('driveConnectionId',c.id,'operations',jsonb_build_array(i.operation))),false)
   OR (i.file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agentonic.drive_files WHERE connection_id=c.id AND file_id=i.file_id)) THEN RAISE insufficient_privilege; END IF;
  IF operation='cancel' THEN
   IF i.status<>'pending' THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.drive_invocations SET status='cancelled',arguments_ciphertext=NULL WHERE id=i.id;
   RETURN '{"ok":true}';
  END IF;
  IF i.status<>'pending' OR i.expires_at<=clock_timestamp() OR i.arguments_ciphertext IS NULL OR i.arguments_sha256 IS DISTINCT FROM payload->>'hash' OR i.approved_by_schedule_id IS NOT NULL THEN RAISE insufficient_privilege; END IF;
  IF operation='confirm' THEN UPDATE agentonic.drive_invocations SET status='executing',approved_at=clock_timestamp() WHERE id=i.id; END IF;
  RETURN jsonb_build_object('credential',c.credential_ciphertext,'connectionId',c.id,'account',c.account,'argumentsCiphertext',i.arguments_ciphertext,'operation',i.operation,'fileId',i.file_id);
 ELSIF operation='knowledge.list' THEN
  RETURN jsonb_build_object('files',coalesce((SELECT jsonb_agg(jsonb_build_object('sourceId',f0.source_id,'collectionId',f0.collection_id,'name',f0.name,'mimeType',f0.mime_type,
    'url',dd.source_url,'status',CASE WHEN EXISTS(SELECT 1 FROM agentonic.background_jobs b WHERE b.kind='drive_sync' AND b.payload->>'sourceId'=f0.source_id::text AND b.status='running') THEN 'syncing'
     WHEN f0.status='pending' OR EXISTS(SELECT 1 FROM agentonic.background_jobs b WHERE b.kind='drive_sync' AND b.payload->>'sourceId'=f0.source_id::text AND b.status='queued') THEN 'queued' ELSE f0.status END,
    'errorCode',f0.error_code,'checkedAt',f0.checked_at,'syncedAt',f0.synced_at,'modifiedAt',dd.source_modified_at,
    'chunkCount',(SELECT count(*) FROM agentonic.document_chunks ch WHERE ch.document_version_id=dd.active_version_id),
    'account',CASE WHEN c0.owner_member_id=m THEN c0.account END,'connectionStatus',c0.status,
    'canManage',agentonic.can_collection(f0.collection_id,'curate'),
    'citedBy',CASE WHEN f0.status='held' THEN agentonic.drive_document_citations(dd) ELSE '[]'::jsonb END) ORDER BY f0.created_at,f0.source_id)
   FROM agentonic.drive_knowledge_files f0 JOIN agentonic.documents dd ON dd.id=f0.document_id JOIN agentonic.drive_connections c0 ON c0.id=f0.connection_id
   WHERE f0.workspace_id=w AND agentonic.can_collection(f0.collection_id,'read')),'[]'));
 ELSIF operation='knowledge.add' THEN
  collection:=(payload->>'collectionId')::uuid;
  SELECT * INTO c FROM agentonic.drive_connections WHERE id=(payload->>'connectionId')::uuid AND workspace_id=w AND owner_member_id=m AND purpose='knowledge' AND status='connected' FOR UPDATE;
  IF c.id IS NULL OR NOT EXISTS(SELECT 1 FROM agentonic.knowledge_collections WHERE id=collection AND workspace_id=w AND archived_at IS NULL) OR NOT agentonic.can_collection(collection,'curate')
   OR jsonb_typeof(payload->'files') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'files') NOT BETWEEN 1 AND 50 THEN RAISE insufficient_privilege; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(payload->'files') x WHERE NOT agentonic.drive_type_supported(x.value->>'mimeType') OR coalesce(x.value->>'fileId','') !~ '^[a-zA-Z0-9_-]{10,200}$' OR coalesce(length(x.value->>'name'),0)=0) THEN RAISE insufficient_privilege; END IF;
  IF (SELECT count(*) FROM (SELECT file_id,collection_id FROM agentonic.drive_knowledge_files WHERE connection_id=c.id UNION SELECT x.value->>'fileId',collection FROM jsonb_array_elements(payload->'files') x) ids)>50 THEN RETURN '{"ok":false,"code":"too_many_files"}'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(payload->'files') LOOP
   -- A file already in this collection, from any account, is kept as it is.
   IF EXISTS(SELECT 1 FROM agentonic.knowledge_sources WHERE workspace_id=w AND collection_id=collection AND kind='google_drive' AND locator=item->>'fileId') THEN CONTINUE; END IF;
   src:=gen_random_uuid(); doc:=gen_random_uuid();
   INSERT INTO agentonic.knowledge_sources(id,workspace_id,collection_id,connection_id,kind,locator,configuration,authorized_by_member_id,sync_interval_seconds,environment,definition_sha256)
   VALUES(src,w,collection,c.id,'google_drive',item->>'fileId',jsonb_build_object('fileId',item->>'fileId','mimeType',item->>'mimeType'),m,3600,'staging',
    agentonic.content_hash(jsonb_build_object('kind','google_drive','fileId',item->>'fileId','collectionId',collection,'connectionId',c.id)));
   INSERT INTO agentonic.documents(id,workspace_id,source_id,external_document_id,title,source_url)
   VALUES(doc,w,src,item->>'fileId',left(item->>'name',500),agentonic.drive_url(item->>'fileId',item->>'mimeType'));
   INSERT INTO agentonic.drive_knowledge_files(source_id,workspace_id,connection_id,collection_id,document_id,file_id,name,mime_type,status)
   VALUES(src,w,c.id,collection,doc,item->>'fileId',left(item->>'name',500),item->>'mimeType','pending');
   PERFORM agentonic.drive_enqueue(src,false);
   n:=n+1;
  END LOOP;
  RETURN jsonb_build_object('ok',true,'added',n);
 ELSIF operation IN ('knowledge.sync','knowledge.apply','knowledge.remove') THEN
  SELECT * INTO f FROM agentonic.drive_knowledge_files WHERE source_id=(payload->>'sourceId')::uuid AND workspace_id=w FOR UPDATE;
  IF f.source_id IS NULL OR NOT agentonic.can_collection(f.collection_id,'curate') THEN RAISE insufficient_privilege; END IF;
  IF operation='knowledge.remove' THEN
   PERFORM agentonic.drive_purge_source(f.source_id);
   RETURN '{"ok":true}';
  END IF;
  IF operation='knowledge.apply' AND f.status<>'held' THEN RAISE insufficient_privilege; END IF;
  IF NOT EXISTS(SELECT 1 FROM agentonic.drive_connections WHERE id=f.connection_id AND status='connected') THEN RETURN '{"ok":false,"code":"reconnect"}'; END IF;
  IF operation='knowledge.sync' AND f.checked_at>clock_timestamp()-interval '1 minute' THEN RETURN '{"ok":false,"code":"rate_limit"}'; END IF;
  PERFORM agentonic.drive_enqueue(f.source_id,operation='knowledge.apply');
  RETURN '{"ok":true}';
 END IF;
 RAISE insufficient_privilege;
END $$;

CREATE OR REPLACE FUNCTION agentonic.drive_action_claim() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE i agentonic.drive_invocations; s agentonic.agent_schedules; conv agentonic.staging_conversations; c agentonic.drive_connections; d agentonic.deployments; r agentonic.configuration_releases;
BEGIN
 IF agentonic.application_role()<>'agentonic_worker' THEN RAISE insufficient_privilege; END IF;
 FOR i IN SELECT * FROM agentonic.drive_invocations WHERE approved_by_schedule_id IS NOT NULL AND status='pending' ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED LOOP
  SELECT * INTO s FROM agentonic.agent_schedules WHERE id=i.approved_by_schedule_id;
  SELECT * INTO conv FROM agentonic.staging_conversations WHERE id=i.conversation_id;
  SELECT * INTO c FROM agentonic.drive_connections WHERE id=i.connection_id;
  SELECT * INTO d FROM agentonic.deployments WHERE id=conv.deployment_id;
  SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id;
  IF i.expires_at<=clock_timestamp() OR i.arguments_ciphertext IS NULL OR s.status='deleted' OR NOT s.autonomy ? i.operation OR s.member_id<>i.owner_member_id
   OR NOT agentonic.staging_conversation_authorized(conv) OR NOT agentonic.drive_allowed(c,i.owner_member_id,i.agent_id,i.operation)
   OR NOT (coalesce(d.member_tools,r.requested_access_snapshot->'tools')) @> jsonb_build_array(jsonb_build_object('driveConnectionId',c.id,'operations',jsonb_build_array(i.operation)))
   OR (i.file_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agentonic.drive_files WHERE connection_id=c.id AND file_id=i.file_id)) THEN
   UPDATE agentonic.drive_invocations SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'cancelled' END,arguments_ciphertext=NULL WHERE id=i.id;
   CONTINUE;
  END IF;
  UPDATE agentonic.drive_invocations SET status='executing',approved_at=clock_timestamp() WHERE id=i.id;
  RETURN jsonb_build_object('id',i.id,'token',gen_random_uuid(),'kind','action','lane','action','provider','drive','queuedAt',i.created_at,
   'connectionId',c.id,'credential',c.credential_ciphertext,'account',c.account,'operation',i.operation,'argumentsCiphertext',i.arguments_ciphertext,'hash',i.arguments_sha256);
 END LOOP;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION agentonic.schedule_action_claim() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE i agentonic.gmail_invocations; s agentonic.agent_schedules; conv agentonic.staging_conversations; c agentonic.gmail_connections; d agentonic.deployments; r agentonic.configuration_releases;
BEGIN
 IF agentonic.application_role()<>'agentonic_worker' THEN RAISE insufficient_privilege; END IF;
 FOR i IN SELECT * FROM agentonic.gmail_invocations WHERE approved_by_schedule_id IS NOT NULL AND status='pending' ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED LOOP
  SELECT * INTO s FROM agentonic.agent_schedules WHERE id=i.approved_by_schedule_id;
  SELECT * INTO conv FROM agentonic.staging_conversations WHERE id=i.conversation_id;
  SELECT * INTO c FROM agentonic.gmail_connections WHERE id=i.connection_id;
  SELECT * INTO d FROM agentonic.deployments WHERE id=conv.deployment_id;
  SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id;
  IF i.expires_at<=clock_timestamp() OR i.arguments_ciphertext IS NULL OR s.status='deleted' OR NOT s.autonomy ? i.operation OR s.member_id<>i.owner_member_id
   OR NOT agentonic.staging_conversation_authorized(conv) OR NOT agentonic.gmail_allowed(c,i.owner_member_id,i.agent_id,i.operation)
   OR NOT (coalesce(d.member_tools,r.requested_access_snapshot->'tools')) @> jsonb_build_array(jsonb_build_object('connectionId',c.id,'operations',jsonb_build_array(i.operation))) THEN
   UPDATE agentonic.gmail_invocations SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'cancelled' END,arguments_ciphertext=NULL WHERE id=i.id;
   CONTINUE;
  END IF;
  UPDATE agentonic.gmail_invocations SET status='executing',approved_at=clock_timestamp() WHERE id=i.id;
  RETURN jsonb_build_object('id',i.id,'token',gen_random_uuid(),'kind','action','lane','action','queuedAt',i.created_at,
   'connectionId',c.id,'credential',c.credential_ciphertext,'account',c.account,'operation',i.operation,'argumentsCiphertext',i.arguments_ciphertext,'hash',i.arguments_sha256);
 END LOOP;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION agentonic.deployment_waiting_google(d agentonic.deployments) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(EXISTS(SELECT 1 FROM agentonic.configuration_releases r
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(coalesce(d.member_tools,r.requested_access_snapshot->'tools'),'[]')) g(grant_)
  LEFT JOIN agentonic.gmail_connections gc ON gc.id=(g.grant_->>'connectionId')::uuid
  LEFT JOIN agentonic.drive_connections dc ON dc.id=(g.grant_->>'driveConnectionId')::uuid
  LEFT JOIN agentonic.connections s ON s.id=coalesce(gc.id,dc.id)
  WHERE r.id=d.configuration_release_id
   AND (gc.status='reconnect' OR dc.status='reconnect' OR (coalesce(gc.status,dc.status)='connected' AND s.credential_expires_at<=clock_timestamp()))),false)
$$;

CREATE OR REPLACE FUNCTION agentonic.preview_command_v30(operation text,payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE w uuid:=agentonic.workspace_id(); m uuid:=agentonic.current_member(); p agentonic.agent_previews; r agentonic.configuration_releases;
 j agentonic.background_jobs; turns jsonb:='[]'; response jsonb; n integer; preview_tools jsonb:='[]';
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR m IS NULL OR w IS NULL THEN RAISE insufficient_privilege; END IF;
 -- Exclusive workspace lock serializes starts/turns with revocation and deletion.
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 IF operation='start' THEN
  payload:=jsonb_build_object('enableTools',false,'budgetUsd',0.25)||payload;
  IF (payload->>'budgetUsd')::numeric NOT IN (0.25,3) THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO r FROM agentonic.configuration_releases WHERE id=(payload->>'candidateId')::uuid AND agent_id=(payload->>'agentId')::uuid AND workspace_id=w;
  IF r.id IS NULL OR NOT agentonic.can_agent(r.agent_id,'edit') OR NOT agentonic.can_use_code(r.code_release_id) THEN RAISE insufficient_privilege; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.requested_access_snapshot->'collectionIds') c WHERE NOT agentonic.can_collection(c::uuid,'read')) THEN RAISE insufficient_privilege; END IF;
  IF NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=r.code_release_id AND execution_manifest->>'previewContract'='1') THEN RETURN '{"ok":false,"code":"runtime_unavailable"}'; END IF;
  -- A private preview can answer plain questions before the author connects any Google accounts.
  IF payload->>'enableTools'='true' THEN preview_tools:=coalesce(agentonic.bind_member_tools(r,m),'[]'::jsonb); END IF;
  SELECT * INTO p FROM agentonic.agent_previews WHERE workspace_id=w AND agent_id=r.agent_id AND configuration_release_id=r.id AND requested_by_member_id=m AND budget_usd=(payload->>'budgetUsd')::numeric AND status='running' AND expires_at>clock_timestamp() AND execution_policy->'tools'=preview_tools ORDER BY created_at DESC LIMIT 1;
  IF p.id IS NOT NULL AND agentonic.preview_authorized(p) THEN RETURN jsonb_build_object('ok',true,'id',p.id); END IF;
  IF (SELECT count(*) FROM agentonic.agent_previews WHERE workspace_id=w AND requested_by_member_id=m AND created_at>clock_timestamp()-interval '1 minute')>=3 THEN RETURN '{"ok":false,"code":"rate_limit"}'; END IF;
  INSERT INTO agentonic.agent_previews(workspace_id,agent_id,code_release_id,configuration_release_id,requested_by_member_id,budget_usd,execution_policy)
  VALUES(w,r.agent_id,r.code_release_id,r.id,m,(payload->>'budgetUsd')::numeric,jsonb_build_object('audience','private','tools',preview_tools,'collections',r.requested_access_snapshot->'collections')) RETURNING * INTO p;
  IF NOT agentonic.preview_authorized(p) THEN RAISE insufficient_privilege; END IF;
  RETURN jsonb_build_object('ok',true,'id',p.id);
 END IF;
 SELECT * INTO p FROM agentonic.agent_previews WHERE id=(payload->>'previewId')::uuid AND workspace_id=w AND requested_by_member_id=m AND agent_id=(payload->>'agentId')::uuid FOR UPDATE;
 IF p.id IS NULL THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
 IF operation='cancel' THEN
  UPDATE agentonic.agent_previews SET status='cancelled' WHERE id=p.id;
  UPDATE agentonic.background_jobs SET status='cancelled',payload='{}',result='{}',lease_token=NULL,lease_until=NULL WHERE preview_id=p.id;
  RETURN '{"ok":true}';
 END IF;
 IF NOT agentonic.preview_authorized(p) THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
 IF operation='turn' THEN
  payload:=jsonb_build_object('model','gpt-5.4-mini')||payload;
  IF NOT payload ? 'reasoning' THEN payload:=payload||jsonb_build_object('reasoning',CASE WHEN payload->>'model'='gpt-4.1-mini-2025-04-14' THEN NULL WHEN payload->>'model'='gpt-6-astra' THEN 'low' ELSE 'medium' END); END IF;
  IF NOT agentonic.valid_model_configuration(payload->>'model',payload->>'reasoning') THEN RAISE insufficient_privilege; END IF;
  IF length(btrim(payload->>'query')) NOT BETWEEN 1 AND 1000 OR payload->>'query' IS NULL OR payload->>'requestKey' IS NULL THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO j FROM agentonic.background_jobs WHERE preview_id=p.id AND request_key=(payload->>'requestKey')::uuid;
  IF j.id IS NOT NULL THEN
   IF j.reasoning_effort IS DISTINCT FROM payload->>'reasoning' OR j.response_model IS DISTINCT FROM payload->>'model' OR j.payload->>'query' IS DISTINCT FROM btrim(payload->>'query') THEN RETURN '{"ok":false,"code":"request_conflict"}'; END IF;
   RETURN jsonb_build_object('ok',true,'id',j.id);
  END IF;
  IF EXISTS(SELECT 1 FROM agentonic.background_jobs WHERE preview_id=p.id AND status IN ('queued','running')) THEN RETURN '{"ok":false,"code":"busy"}'; END IF;
  SELECT coalesce(max(turn_number),0)+1 INTO n FROM agentonic.background_jobs WHERE preview_id=p.id;
  IF n>10 THEN RETURN '{"ok":false,"code":"turn_limit"}'; END IF;
  INSERT INTO agentonic.background_jobs(workspace_id,member_id,kind,preview_id,turn_number,request_key,response_model,reasoning_effort,payload)
  SELECT w,m,'retrieve',p.id,n,(payload->>'requestKey')::uuid,payload->>'model',payload->>'reasoning',jsonb_build_object('query',btrim(payload->>'query'),'collectionIds',frozen.requested_access_snapshot->'collectionIds','generateAnswer',true)
  FROM agentonic.configuration_releases frozen WHERE frozen.id=p.configuration_release_id RETURNING * INTO j;
  RETURN jsonb_build_object('ok',true,'id',j.id);
 ELSIF operation='state' THEN
  FOR j IN SELECT * FROM agentonic.background_jobs WHERE preview_id=p.id ORDER BY turn_number LOOP
   response:=agentonic.rag_command('result',jsonb_build_object('id',j.id));
   IF response->>'status'='unavailable' THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
   turns:=turns||jsonb_build_array(response||jsonb_build_object('id',j.id,'number',j.turn_number,'model',j.response_model,'reasoning',j.reasoning_effort,'query',j.payload->>'query'));
  END LOOP;
  RETURN jsonb_build_object('ok',true,'id',p.id,'expiresAt',p.expires_at,'budgetUsd',p.budget_usd,'committedMicrousd',p.committed_microusd,'toolsEnabled',jsonb_array_length(p.execution_policy->'tools')>0,'turns',turns);
 END IF;
 RAISE insufficient_privilege;
END $$;

CREATE FUNCTION agentonic.member_scope_matches(frozen jsonb, bound jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT coalesce(jsonb_array_length(frozen)=jsonb_array_length(bound) AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(frozen) f WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(bound) b
   WHERE b=f OR (f->'connectionId'='null'::jsonb AND b ? 'connectionId' AND b->>'connectionId' IS NOT NULL AND b-'connectionId'=f-'connectionId')
   OR (f->'driveConnectionId'='null'::jsonb AND b ? 'driveConnectionId' AND b->>'driveConnectionId' IS NOT NULL AND b-'driveConnectionId'=f-'driveConnectionId'))),false)
$$;

CREATE OR REPLACE FUNCTION agentonic.preview_authorized_v30(p agentonic.agent_previews) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE base agentonic.agent_previews:=p; r agentonic.configuration_releases; tools jsonb:=p.execution_policy->'tools';
BEGIN
 base.execution_policy:=jsonb_set(p.execution_policy,'{tools}','[]');
 IF NOT agentonic.preview_authorized_v29(base) THEN RETURN false; END IF;
 IF tools='[]' THEN RETURN true; END IF;
 SELECT * INTO r FROM agentonic.configuration_releases WHERE id=p.configuration_release_id;
 RETURN coalesce(agentonic.member_scope_matches(r.requested_access_snapshot->'tools',tools) AND agentonic.gmail_deployment_scope(agentonic.bound_release(r,tools),p.requested_by_member_id),false);
END $$;

CREATE OR REPLACE FUNCTION agentonic.preview_authorized(p agentonic.agent_previews) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT agentonic.preview_authorized_v30(p) AND (NOT agentonic.has_web(p.execution_policy->'tools') OR EXISTS(SELECT 1 FROM agentonic.configuration_releases r WHERE r.id=p.configuration_release_id AND agentonic.web_scope(r)))
 AND (agentonic.drive_grants(coalesce(p.execution_policy->'tools','[]'))='[]' OR EXISTS(SELECT 1 FROM agentonic.configuration_releases r WHERE r.id=p.configuration_release_id AND agentonic.drive_deployment_scope(agentonic.bound_release(r,p.execution_policy->'tools'),p.requested_by_member_id)))
$$;

CREATE OR REPLACE FUNCTION agentonic.deployment_in_place(submission uuid, environment text) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM agentonic.deployments dep WHERE dep.submission_id=submission AND dep.environment=deployment_in_place.environment
  AND (dep.member_tools IS NULL OR dep.authorized_by_member_id=agentonic.current_member())
  AND dep.status IN ('awaiting_activation','queued','preparing','running') AND dep.revoked_at IS NULL AND agentonic.deployment_authorized(dep))
$$;

CREATE OR REPLACE FUNCTION agentonic.deployment_command(operation text, payload jsonb, trace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();staff uuid:=agentonic.current_staff();s agentonic.agent_submissions;
 d agentonic.deployments;decision agentonic.submission_review_decisions;h agentonic.runtime_hosts;sources jsonb; r agentonic.configuration_releases; bindings jsonb; personal boolean;
BEGIN
 IF w IS NULL OR trace_id IS NULL OR agentonic.actor_user_id() IS NULL OR agentonic.application_role() NOT IN ('agentonic_customer','agentonic_admin') THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 IF operation='authorize' THEN
  SELECT * INTO s FROM agentonic.agent_submissions WHERE id=(payload->>'submissionId')::uuid AND workspace_id=w;
  SELECT * INTO r FROM agentonic.configuration_releases WHERE id=s.configuration_release_id AND workspace_id=w;
  personal:=agentonic.has_member_tools(r.requested_access_snapshot->'tools');
  IF agentonic.application_role()<>'agentonic_customer' OR m IS NULL OR NOT agentonic.can_agent(s.agent_id,'invoke')
   OR (NOT personal AND (s.submitted_by_member_id IS DISTINCT FROM m OR NOT agentonic.can_agent(s.agent_id,'edit'))) OR payload->'consent' IS DISTINCT FROM 'true'::jsonb OR payload->>'requestId' IS NULL
   OR jsonb_typeof(payload->'budgetUsd') IS DISTINCT FROM 'number' OR (payload->>'budgetUsd')::numeric NOT BETWEEN 0.05 AND 20
   OR (payload ? 'autoRenew' AND jsonb_typeof(payload->'autoRenew') IS DISTINCT FROM 'boolean') THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO d FROM agentonic.deployments WHERE workspace_id=w AND authorized_by_member_id=m AND request_id=(payload->>'requestId')::uuid;
  IF d.id IS NOT NULL THEN
   IF d.submission_id IS DISTINCT FROM s.id OR d.environment IS DISTINCT FROM payload->>'environment' OR d.budget_usd IS DISTINCT FROM (payload->>'budgetUsd')::numeric
    OR EXISTS(SELECT 1 FROM jsonb_each(coalesce(payload->'accounts','{}')) requested
     WHERE NOT coalesce(d.member_tools @> jsonb_build_array(jsonb_build_object(requested.key,requested.value)),false)) THEN RAISE insufficient_privilege; END IF;
   RETURN jsonb_build_object('ok',true,'id',d.id);
  END IF;
  -- The workspace lock serializes repeat authorizations. Personal versions reserve a slot per member.
  IF agentonic.deployment_in_place(s.id,payload->>'environment') THEN RETURN '{"ok":false,"code":"already_authorized"}'; END IF;
  SELECT * INTO decision FROM agentonic.submission_review_decisions WHERE submission_id=s.id ORDER BY decision_number DESC LIMIT 1;
  IF NOT coalesce(agentonic.version_approval_valid(decision.id),false) THEN RETURN '{"ok":false,"code":"approval_required"}'; END IF;
  IF personal THEN
   IF decision.actor_staff_id IS NULL THEN RAISE insufficient_privilege; END IF;
   bindings:=agentonic.bind_member_tools(r,m,payload->'accounts');
   IF bindings IS NULL THEN RETURN '{"ok":false,"code":"connection_required"}'; END IF;
  END IF;
  SELECT * INTO h FROM agentonic.runtime_hosts WHERE environment=payload->>'environment' AND revoked_at IS NULL AND verified_at>clock_timestamp()-interval '30 days' AND heartbeat_at>clock_timestamp()-interval '90 seconds';
  IF h.id IS NULL THEN RETURN '{"ok":false,"code":"host_unavailable"}'; END IF;
  SELECT coalesce(jsonb_agg(hit),'[]') INTO sources FROM agentonic.evaluation_results er CROSS JOIN LATERAL jsonb_array_elements(er.evidence_sources) hit WHERE er.evaluation_run_id=(decision.assessment_snapshot->>'evaluationId')::uuid;
  -- 30-day periods with a budget each, renewed automatically unless the customer opts out (§59).
  INSERT INTO agentonic.deployments(workspace_id,agent_id,code_release_id,configuration_release_id,submission_id,approval_id,host_id,environment,authorized_by_member_id,request_id,budget_usd,authorized_until,evidence_sources,
   member_tools,auto_renew,period_budget_usd,period_started_at)
  VALUES(w,s.agent_id,s.code_release_id,s.configuration_release_id,s.id,decision.id,h.id,h.environment,m,(payload->>'requestId')::uuid,(payload->>'budgetUsd')::numeric,clock_timestamp()+interval '30 days',sources,
   bindings,coalesce((payload->>'autoRenew')::boolean,true),(payload->>'budgetUsd')::numeric,clock_timestamp()) RETURNING * INTO d;
  IF NOT agentonic.deployment_authorized(d) THEN RAISE insufficient_privilege; END IF;
  IF personal THEN
   UPDATE agentonic.deployments SET status='queued',desired_state='running',requested_by_staff_id=decision.actor_staff_id WHERE id=d.id RETURNING * INTO d;
   IF NOT agentonic.deployment_activation_allowed(d) THEN RAISE insufficient_privilege; END IF;
  END IF;
 ELSIF operation IN ('activate','stop') THEN
  SELECT * INTO d FROM agentonic.deployments WHERE id=(payload->>'deploymentId')::uuid AND workspace_id=w FOR UPDATE;
  IF d.id IS NULL THEN RAISE insufficient_privilege; END IF;
  IF operation='stop' AND agentonic.application_role()='agentonic_customer' THEN
   IF d.authorized_by_member_id IS DISTINCT FROM m OR NOT agentonic.can_agent(d.agent_id,'invoke') THEN RAISE insufficient_privilege; END IF;
  ELSIF agentonic.application_role()<>'agentonic_admin' OR NOT EXISTS(SELECT 1 FROM agentonic.platform_staff WHERE id=staff AND role IN ('administrator','operator')) THEN RAISE insufficient_privilege; END IF;
  IF operation='activate' THEN
   IF d.status IN ('queued','preparing','running') THEN RETURN jsonb_build_object('ok',true,'id',d.id); END IF;
   IF d.status<>'awaiting_activation' OR NOT agentonic.deployment_authorized(d) OR NOT agentonic.version_approval_valid(d.approval_id) THEN RETURN '{"ok":false,"code":"approval_required"}'; END IF;
   UPDATE agentonic.deployments SET status='queued',desired_state='running',requested_by_staff_id=staff WHERE id=d.id;
  ELSE
   UPDATE agentonic.deployments SET desired_state='stopped',status='stopped',revoked_at=coalesce(revoked_at,clock_timestamp()),service_token_sha256=NULL WHERE id=d.id;
   UPDATE agentonic.agent_environments SET current_deployment_id=NULL WHERE current_deployment_id=d.id;
  END IF;
 ELSIF operation IN ('renewal','extend') THEN
  -- Only the customer who authorized the deployment sets or uses its renewal.
  SELECT * INTO d FROM agentonic.deployments WHERE id=(payload->>'deploymentId')::uuid AND workspace_id=w FOR UPDATE;
  IF d.id IS NULL OR agentonic.application_role()<>'agentonic_customer' OR d.authorized_by_member_id IS DISTINCT FROM m OR NOT agentonic.can_agent(d.agent_id,'invoke') THEN RAISE insufficient_privilege; END IF;
  IF operation='renewal' THEN
   IF jsonb_typeof(payload->'autoRenew') IS DISTINCT FROM 'boolean' OR jsonb_typeof(payload->'budgetUsd') IS DISTINCT FROM 'number' OR (payload->>'budgetUsd')::numeric NOT BETWEEN 0.05 AND 20 THEN RAISE insufficient_privilege; END IF;
   -- Raising the period budget applies to the current period too (§80): its
   -- ceiling becomes what earlier periods used plus the new budget. Lowering
   -- it waits for the next renewal, since a running ceiling never shrinks.
   UPDATE agentonic.deployments SET auto_renew=(payload->>'autoRenew')::boolean,period_budget_usd=(payload->>'budgetUsd')::numeric,
    budget_usd=greatest(budget_usd,period_base_microusd::numeric/1000000+(payload->>'budgetUsd')::numeric) WHERE id=d.id;
  ELSE
   IF d.authorized_until>clock_timestamp()+interval '10 days' THEN RETURN '{"ok":false,"code":"too_early"}'; END IF;
   IF d.period_budget_usd IS NULL THEN RETURN '{"ok":false,"code":"budget_required"}'; END IF;
   IF NOT agentonic.deployment_renew(d,'manual',m) THEN RETURN jsonb_build_object('ok',false,'code',coalesce(agentonic.deployment_change(d),'changed')); END IF;
  END IF;
 ELSE RAISE insufficient_privilege;
 END IF;
 INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,action,resource_type,resource_id,outcome,request_id)
 VALUES(w,agentonic.actor_user_id(),CASE WHEN agentonic.application_role()='agentonic_customer' THEN m END,'deployment.'||operation,'deployment',d.id::text,'succeeded',trace_id::text);
 RETURN jsonb_build_object('ok',true,'id',d.id);
END $function$;

CREATE OR REPLACE FUNCTION agentonic.lifecycle_state_v77(target_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();staff uuid:=agentonic.current_staff();aid uuid;items jsonb;deploys jsonb;operator boolean;
BEGIN
 IF w IS NULL OR agentonic.application_role() NOT IN ('agentonic_admin','agentonic_customer') THEN RAISE insufficient_privilege; END IF;
 SELECT a.id INTO aid FROM agentonic.agents a WHERE a.workspace_id=w AND (a.id=target_id OR EXISTS(SELECT 1 FROM agentonic.agent_submissions s WHERE s.id=target_id AND s.agent_id=a.id));
 IF aid IS NULL THEN RETURN NULL; END IF;
 IF agentonic.application_role()='agentonic_admin' THEN
  IF staff IS NULL THEN RAISE insufficient_privilege; END IF;
 ELSE
  IF m IS NULL OR NOT agentonic.can_agent(aid,'read') THEN RAISE insufficient_privilege; END IF;
 END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR SHARE; IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 operator:=agentonic.application_role()='agentonic_admin' AND EXISTS(SELECT 1 FROM agentonic.platform_staff WHERE id=staff AND role IN ('administrator','operator'));
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'number',s.submission_number,'candidateId',s.configuration_release_id,
  'versionNumber',(SELECT count(*)::int FROM agentonic.configuration_releases v WHERE v.agent_id=aid AND (v.created_at,v.id)<=(r.created_at,r.id)),
  'approvalId',d.id,'reason',agentonic.approval_reason(d.id),'expiresAt',d.approval_expires_at,
  'renewalRequested',EXISTS(SELECT 1 FROM agentonic.approval_renewal_requests req WHERE req.submission_id=s.id),
  'renewedSubmissionId',(SELECT id FROM agentonic.agent_submissions n WHERE n.renewed_from_submission_id=s.id),
  'canRequestRenewal',operator AND s.status='approved' AND NOT coalesce(agentonic.version_approval_valid(d.id),false) AND NOT EXISTS(SELECT 1 FROM agentonic.agent_submissions n WHERE n.renewed_from_submission_id=s.id),
  'canRenew',agentonic.application_role()='agentonic_customer' AND s.submitted_by_member_id=m AND agentonic.can_agent(aid,'edit') AND s.status IN ('approved','revoked','changes_requested','rejected','withdrawn') AND NOT coalesce(agentonic.version_approval_valid(d.id),false) AND NOT EXISTS(SELECT 1 FROM agentonic.agent_submissions n WHERE n.renewed_from_submission_id=s.id),
  'googleChoices',CASE WHEN agentonic.application_role()='agentonic_customer' AND agentonic.can_agent(aid,'invoke') THEN agentonic.member_google_choices(r,m) ELSE '[]'::jsonb END,'canAuthorize',agentonic.application_role()='agentonic_customer' AND ((s.submitted_by_member_id=m AND agentonic.can_agent(aid,'edit')) OR (agentonic.has_member_tools(r.requested_access_snapshot->'tools') AND d.actor_staff_id IS NOT NULL)) AND agentonic.can_agent(aid,'invoke') AND coalesce(agentonic.version_approval_valid(d.id),false)
   AND NOT EXISTS(SELECT 1 FROM agentonic.runtime_hosts h WHERE h.revoked_at IS NULL AND agentonic.deployment_in_place(s.id,h.environment))
 ) ORDER BY s.submission_number DESC),'[]') INTO items
 FROM agentonic.agent_submissions s JOIN agentonic.configuration_releases r ON r.id=s.configuration_release_id
 LEFT JOIN LATERAL(SELECT * FROM agentonic.submission_review_decisions dec WHERE dec.submission_id=s.id AND dec.decision='approved' ORDER BY dec.decision_number DESC LIMIT 1) d ON true
 WHERE s.workspace_id=w AND s.agent_id=aid;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',dep.id,'submissionId',dep.submission_id,'environment',dep.environment,'status',dep.status,
  'authorized',agentonic.deployment_authorized(dep),'online',dep.status='running' AND agentonic.deployment_authorized(dep) AND agentonic.deployment_online(dep),
  'expiresAt',dep.authorized_until,'budgetUsd',dep.budget_usd,'committedMicrousd',dep.committed_microusd,'errorCode',dep.error_code,
  'canActivate',operator AND dep.status='awaiting_activation' AND agentonic.deployment_authorized(dep) AND agentonic.version_approval_valid(dep.approval_id),
  'canStop',(operator OR dep.authorized_by_member_id=m) AND dep.status IN ('awaiting_activation','queued','preparing','running'),
  'canChat',agentonic.application_role()='agentonic_customer' AND dep.authorized_by_member_id=m AND dep.status='running' AND agentonic.deployment_authorized(dep) AND agentonic.can_agent(aid,'invoke'),
  'autoRenew',dep.auto_renew,'periodBudgetUsd',dep.period_budget_usd,'periodStartedAt',dep.period_started_at,'periodCommittedMicrousd',dep.committed_microusd-dep.period_base_microusd,
  'renewalBlocked',CASE WHEN dep.status='running' AND dep.revoked_at IS NULL THEN coalesce(dep.renewal_blocked,CASE WHEN dep.authorized_until<=clock_timestamp()+interval '10 days' THEN agentonic.deployment_change(dep) END) END,
  'renewsAt',CASE WHEN dep.auto_renew AND dep.status='running' AND dep.revoked_at IS NULL THEN dep.authorized_until-interval '3 days' END,
  'renewals',(SELECT count(*)::int FROM agentonic.deployment_renewals rn WHERE rn.deployment_id=dep.id),
  'canChangeRenewal',agentonic.application_role()='agentonic_customer' AND dep.authorized_by_member_id=m AND dep.status IN ('awaiting_activation','queued','preparing','running') AND dep.revoked_at IS NULL,
  'canRenewNow',agentonic.application_role()='agentonic_customer' AND dep.authorized_by_member_id=m AND dep.status='running' AND dep.revoked_at IS NULL AND dep.period_budget_usd IS NOT NULL
   AND dep.authorized_until<=clock_timestamp()+interval '10 days' AND agentonic.deployment_authorized(dep)
 ) ORDER BY dep.created_at DESC),'[]') INTO deploys FROM agentonic.deployments dep WHERE dep.workspace_id=w AND dep.agent_id=aid AND (operator OR agentonic.application_role()='agentonic_admin' OR dep.authorized_by_member_id=m OR dep.member_tools IS NULL);
 RETURN jsonb_build_object('agentId',aid,'submissions',items,'deployments',deploys,'hosts',coalesce((SELECT jsonb_agg(jsonb_build_object('environment',environment,'available',revoked_at IS NULL AND verified_at>clock_timestamp()-interval '30 days' AND coalesce(heartbeat_at>clock_timestamp()-interval '90 seconds',false))) FROM agentonic.runtime_hosts),'[]'::jsonb));
END $function$;

CREATE OR REPLACE FUNCTION agentonic.deployment_service(operation text,target_id uuid,secret text,payload jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d agentonic.deployments;slot text;broker text;
BEGIN
 SELECT * INTO d FROM agentonic.deployments WHERE id=target_id;
 IF agentonic.deployment_copy(d,secret) IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=d.workspace_id FOR UPDATE;
 SELECT * INTO d FROM agentonic.deployments WHERE id=target_id FOR UPDATE;
 slot:=agentonic.deployment_copy(d,secret);
 IF slot IS NULL THEN RAISE insufficient_privilege; END IF;
 broker:=CASE slot WHEN 'serving' THEN d.broker_sha256 WHEN 'successor' THEN d.successor_broker_sha256 ELSE d.draining_broker_sha256 END;
 -- Copies report the program they run; a copy started from other bytes is refused.
 IF payload ? 'brokerHash' AND payload->>'brokerHash' IS DISTINCT FROM broker THEN RAISE insufficient_privilege; END IF;
 IF d.desired_state<>'running' OR d.status NOT IN ('preparing','running') OR NOT agentonic.deployment_authorized(d) THEN RETURN '{"ok":false,"code":"unavailable"}'; END IF;
 IF slot='draining' THEN
  -- A replaced copy finishes the turn it leased, then stops. It is never ready again.
  IF operation='heartbeat' THEN RETURN '{"ok":true,"draining":true}'; END IF;
  RAISE insufficient_privilege;
 END IF;
 IF operation='rest' THEN
  -- An idle serving copy stops on purpose; the controller starts it again when a turn waits.
  IF slot<>'serving' OR d.status<>'running' THEN RAISE insufficient_privilege; END IF;
  IF agentonic.deployment_pending(d.id) THEN RETURN '{"ok":false,"code":"pending"}'; END IF;
  UPDATE agentonic.deployments SET resting_since=clock_timestamp() WHERE id=d.id;
  RETURN jsonb_build_object('ok',true);
 END IF;
 IF operation='ready' THEN
  IF payload->>'manifestHash' IS DISTINCT FROM d.manifest_sha256 THEN RAISE insufficient_privilege; END IF;
  IF slot='successor' THEN
   IF d.status<>'running' THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.deployments SET draining_broker_sha256=broker_sha256,draining_token_sha256=service_token_sha256,draining_since=clock_timestamp(),
    broker_sha256=successor_broker_sha256,service_token_sha256=successor_token_sha256,successor_broker_sha256=NULL,successor_token_sha256=NULL,
    generation=generation+1,heartbeat_at=clock_timestamp(),resting_since=NULL WHERE id=d.id;
   INSERT INTO agentonic.audit_events(workspace_id,action,resource_type,resource_id,outcome,request_id)
    VALUES(d.workspace_id,'deployment.broker_moved','deployment',d.id::text,'succeeded',gen_random_uuid()::text);
   RETURN jsonb_build_object('ok',true);
  END IF;
  IF d.activated_at IS NULL AND NOT agentonic.deployment_activation_allowed(d) THEN RETURN '{"ok":false,"code":"approval_required"}'; END IF;
  IF d.status='preparing' THEN

   UPDATE agentonic.deployments SET status='superseded',desired_state='stopped',service_token_sha256=NULL WHERE id<>d.id AND workspace_id=d.workspace_id AND agent_id=d.agent_id AND environment=d.environment AND status='running'
    AND (authorized_by_member_id=d.authorized_by_member_id OR (member_tools IS NULL AND d.member_tools IS NULL));
   UPDATE agentonic.deployments SET status='running',activated_at=coalesce(activated_at,clock_timestamp()),heartbeat_at=clock_timestamp() WHERE id=d.id;
   IF d.member_tools IS NULL THEN
   INSERT INTO agentonic.agent_environments(workspace_id,agent_id,environment,current_deployment_id) VALUES(d.workspace_id,d.agent_id,d.environment,d.id)
    ON CONFLICT(workspace_id,agent_id,environment) DO UPDATE SET current_deployment_id=excluded.current_deployment_id;
   ELSE
    UPDATE agentonic.staging_conversations c SET deployment_id=d.id FROM agentonic.deployments earlier
    WHERE earlier.id=c.deployment_id AND earlier.agent_id=d.agent_id AND earlier.environment=d.environment AND earlier.id<>d.id
     AND c.owner_member_id=d.authorized_by_member_id AND agentonic.staging_conversation_readable(c);
   END IF;
   INSERT INTO agentonic.audit_events(workspace_id,action,resource_type,resource_id,outcome,request_id)
    VALUES(d.workspace_id,'deployment.activated','deployment',d.id::text,'succeeded',gen_random_uuid()::text);
  END IF;
 ELSIF operation<>'heartbeat' THEN RAISE insufficient_privilege;
 -- A starting successor's heartbeat says nothing about the serving copy.
 ELSIF slot='successor' THEN RETURN jsonb_build_object('ok',true);
 END IF;
 UPDATE agentonic.deployments SET heartbeat_at=clock_timestamp(),resting_since=NULL WHERE id=d.id;
 RETURN jsonb_build_object('ok',true);
END $$;

CREATE OR REPLACE FUNCTION agentonic.staging_conversation_authorized(c agentonic.staging_conversations) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE d agentonic.deployments;
BEGIN
 SELECT * INTO d FROM agentonic.deployments WHERE id=c.deployment_id;
 RETURN coalesce(c.id IS NOT NULL AND c.closed_at IS NULL AND c.expires_at>clock_timestamp() AND c.owner_member_id=d.authorized_by_member_id
 AND d.status='running' AND d.desired_state='running' AND agentonic.deployment_authorized(d)
 AND (d.member_tools IS NOT NULL OR EXISTS(SELECT 1 FROM agentonic.agent_environments WHERE current_deployment_id=d.id))
 AND NOT EXISTS(SELECT 1 FROM agentonic.staging_turns t CROSS JOIN LATERAL jsonb_array_elements(t.matches) hit WHERE t.conversation_id=c.id AND NOT EXISTS(
 SELECT 1 FROM agentonic.document_chunks ch JOIN agentonic.document_versions v ON v.id=ch.document_version_id JOIN agentonic.documents doc ON doc.id=v.document_id
 WHERE ch.workspace_id=c.workspace_id AND ch.id=(hit->>'id')::uuid AND ch.content_sha256=hit->>'hash' AND v.status='ready' AND doc.active_version_id=v.id AND doc.deleted_at IS NULL)),false);
END $$;

CREATE OR REPLACE FUNCTION agentonic.agent_listing() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=agentonic.workspace_id(); result jsonb;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR agentonic.actor_user_id() IS NULL OR w IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR SHARE;
 IF NOT FOUND OR agentonic.current_member() IS NULL THEN RAISE insufficient_privilege; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id',a.id,'name',a.name,'slug',a.slug,'description',a.description,'status',a.status,
  'canEdit',agentonic.can_agent(a.id,'edit'),'canInvoke',agentonic.can_agent(a.id,'invoke'),
  'configuration',CASE WHEN agentonic.can_agent(a.id,'edit') THEN jsonb_build_object(
   -- ECMAScript whitespace, matching the shared prompt character counter.
   'promptCharacters',length(translate(coalesce(d.content->>'systemPrompt',''),U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF','')),
   'skillsCount',coalesce(jsonb_array_length(d.content->'skills'),0),
   'collectionsCount',coalesce(jsonb_array_length(d.requested_access->'collectionIds'),0),
   'toolsCount',coalesce(jsonb_array_length(d.requested_access->'tools'),0),
   -- Connections remain unavailable; observed staging deployments are separate from drafts.
   'connectionsCount',0,'liveVersion',(SELECT string_agg(r.version || ' · ' || CASE dep.environment WHEN 'local' THEN 'Pruebas locales' ELSE 'Pruebas VM' END || CASE WHEN agentonic.deployment_online(dep) THEN '' ELSE ' · Sin conexión' END, ', ' ORDER BY dep.environment)
     FROM agentonic.deployments dep JOIN agentonic.configuration_releases r ON r.id=dep.configuration_release_id
     WHERE dep.workspace_id=w AND dep.agent_id=a.id AND (dep.member_tools IS NULL OR dep.authorized_by_member_id=agentonic.current_member()) AND dep.status='running' AND dep.desired_state='running' AND agentonic.deployment_authorized(dep)),
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
  WHERE d.agent_id=aid AND (d.member_tools IS NULL OR agentonic.application_role()<>'agentonic_customer' OR d.authorized_by_member_id=agentonic.current_member()) AND d.status='running';
 IF live='[]'::jsonb THEN
  SELECT jsonb_build_object('environment',d.environment,'status',d.status,'versionNumber',agentonic.release_number(d.configuration_release_id))
   INTO ended FROM agentonic.deployments d WHERE d.agent_id=aid AND (d.member_tools IS NULL OR agentonic.application_role()<>'agentonic_customer' OR d.authorized_by_member_id=agentonic.current_member()) ORDER BY d.created_at DESC,d.id DESC LIMIT 1;
  IF ended IS NOT NULL AND ended->>'status' NOT IN ('stopped','failed') THEN ended:=NULL; END IF;
 END IF;
 SELECT x.id,x.submission_number,x.status,x.configuration_release_id INTO s
  FROM agentonic.agent_submissions x JOIN agentonic.configuration_releases r ON r.id=x.configuration_release_id
  WHERE x.agent_id=aid AND x.status<>'withdrawn' AND (live_at IS NULL OR r.created_at>live_at)
  ORDER BY r.created_at DESC,x.submission_number DESC LIMIT 1;
 IF s.id IS NOT NULL THEN
  SELECT jsonb_build_object('environment',d.environment,'status',CASE WHEN agentonic.deployment_authorized(d) THEN d.status ELSE 'unauthorized' END)
   INTO pending FROM agentonic.deployments d
   WHERE d.agent_id=aid AND (d.member_tools IS NULL OR agentonic.application_role()<>'agentonic_customer' OR d.authorized_by_member_id=agentonic.current_member()) AND d.configuration_release_id=s.configuration_release_id AND d.status IN ('awaiting_activation','queued','preparing')
   ORDER BY d.created_at DESC,d.id DESC LIMIT 1;
  SELECT dec.id,dec.approval_expires_at INTO approval FROM agentonic.submission_review_decisions dec
   WHERE dec.submission_id=s.id AND dec.decision='approved' ORDER BY dec.decision_number DESC LIMIT 1;
  nxt:=jsonb_build_object('submissionId',s.id,'number',s.submission_number,'versionNumber',agentonic.release_number(s.configuration_release_id),
   'status',s.status,'approvalReason',CASE WHEN approval.id IS NULL THEN NULL ELSE agentonic.approval_reason(approval.id) END,
   'approvalExpiresAt',approval.approval_expires_at,'deployment',pending);
 END IF;
 RETURN jsonb_build_object('archived',archived,'live',live,'ended',ended,'next',nxt);
END $$;

CREATE OR REPLACE FUNCTION agentonic.style_guide_state(target_agent uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR w IS NULL OR m IS NULL OR NOT agentonic.can_agent(target_agent,'invoke') THEN RAISE insufficient_privilege; END IF;
 -- The latest guide of each account this person connected to the agent.
 RETURN jsonb_build_object('guides',coalesce((SELECT jsonb_agg(agentonic.style_guide_view(g) ORDER BY g.created_at) FROM (
  SELECT DISTINCT ON (g.connection_id) g.* FROM agentonic.style_guides g JOIN agentonic.gmail_connections c ON c.id=g.connection_id
  WHERE g.workspace_id=w AND g.agent_id=target_agent AND g.member_id=m AND c.owner_member_id=m
  ORDER BY g.connection_id,g.created_at DESC) g),'[]'::jsonb));
END $$;

REVOKE ALL ON FUNCTION agentonic.member_can_invoke(uuid,uuid),agentonic.member_google_choices(agentonic.configuration_releases,uuid),agentonic.bind_member_tools(agentonic.configuration_releases,uuid,jsonb),
 agentonic.bound_release(agentonic.configuration_releases,jsonb),agentonic.member_scope_matches(jsonb,jsonb),agentonic.has_member_tools(jsonb) FROM PUBLIC;
COMMIT;
