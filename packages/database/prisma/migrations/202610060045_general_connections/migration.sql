BEGIN;
-- The general model, part 2: connections and tool calls (architecture section 49).
-- Gmail was built on its own tables; every later connector needs one model. As
-- with conversations (migration 44), the general row is the identity and the
-- Gmail row its extension with the same ID, kept in step by triggers:
--   gmail_connections.id = connections.id, plus the agent's grant in
--     agent_connection_grants (the connection is bound to one agent)
--   gmail_invocations.id = tool_invocations.id, plus its confirmation in
--     tool_approvals (every Gmail write waits for the owner's confirmation)
-- Sealed credentials and arguments stay in the Gmail rows, never in the general
-- ones: connections.secret_reference only names where the credential is kept.
-- Gmail reads are not recorded as invocations, as before.

CREATE TABLE agentonic.connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES agentonic.workspaces(id),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
 provider text NOT NULL CHECK(provider ~ '^[a-z][a-z0-9_]{1,40}$'),
 kind text NOT NULL CHECK(kind IN ('oauth','api_key','database','mcp','managed_identity')),
 external_account_id text CHECK(length(external_account_id)<=254), owner_member_id uuid NOT NULL,
 configuration jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(configuration)='object'),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('pending','active','expired','revoked','error')),
 credential_expires_at timestamptz, last_verified_at timestamptz, revoked_at timestamptz,
 secret_reference text CHECK(secret_reference ~ '^[a-z_]+:[0-9a-f-]{36}$'),
 environment text NOT NULL CHECK(environment IN ('development','staging','production')), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,environment,id),
 FOREIGN KEY(workspace_id,owner_member_id) REFERENCES agentonic.workspace_members(workspace_id,id),
 CHECK((status='revoked')=(revoked_at IS NOT NULL))
);
CREATE TABLE agentonic.agent_connection_grants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, agent_id uuid NOT NULL, connection_id uuid NOT NULL,
 environment text NOT NULL CHECK(environment IN ('development','staging','production')),
 allowed_operations jsonb NOT NULL CHECK(jsonb_typeof(allowed_operations)='array'),
 granted_by_member_id uuid NOT NULL, expires_at timestamptz, revoked_at timestamptz,
 approved_review_decision_id uuid, activated_by_staff_id uuid,
 approved_decision_kind text NOT NULL DEFAULT 'approved' CHECK(approved_decision_kind='approved'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,agent_id,connection_id,environment),
 FOREIGN KEY(workspace_id,agent_id) REFERENCES agentonic.agents(workspace_id,id),
 FOREIGN KEY(workspace_id,environment,connection_id) REFERENCES agentonic.connections(workspace_id,environment,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,granted_by_member_id) REFERENCES agentonic.workspace_members(workspace_id,id),
 CHECK(environment<>'production' OR (approved_review_decision_id IS NOT NULL AND activated_by_staff_id IS NOT NULL))
);
CREATE TABLE agentonic.tool_invocations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, run_id uuid NOT NULL, code_release_id uuid NOT NULL,
 configuration_tool_id uuid NOT NULL, invocation_key text NOT NULL CHECK(length(invocation_key) BETWEEN 1 AND 200),
 status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','denied','awaiting_approval','running','succeeded','failed','unknown')),
 arguments_sha256 text NOT NULL CHECK(arguments_sha256 ~ '^[a-f0-9]{64}$'), redacted_arguments jsonb, redacted_result jsonb, policy_snapshot jsonb NOT NULL,
 external_idempotency_key text, started_at timestamptz, finished_at timestamptz, error_code text,
 agent_id uuid NOT NULL, configuration_release_id uuid NOT NULL, standing_authorization_id uuid, connection_id uuid,
 environment text NOT NULL CHECK(environment IN ('development','staging','production')),
 authorization_kind text NOT NULL DEFAULT 'none' CHECK(authorization_kind IN ('none','policy','one_off','standing')),
 code_tool_id uuid NOT NULL, arguments_object_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,run_id,invocation_key), UNIQUE(workspace_id,id,arguments_sha256),
 FOREIGN KEY(workspace_id,agent_id,code_release_id,configuration_release_id,run_id) REFERENCES agentonic.agent_runs(workspace_id,agent_id,code_release_id,configuration_release_id,id),
 FOREIGN KEY(workspace_id,agent_id,code_release_id,configuration_release_id,configuration_tool_id) REFERENCES agentonic.configuration_tools(workspace_id,agent_id,code_release_id,configuration_release_id,id),
 FOREIGN KEY(code_release_id,code_tool_id) REFERENCES agentonic.code_tools(code_release_id,id),
 FOREIGN KEY(workspace_id,connection_id) REFERENCES agentonic.connections(workspace_id,id),
 CHECK((authorization_kind='standing')=(standing_authorization_id IS NOT NULL))
);
CREATE INDEX tool_invocations_run ON agentonic.tool_invocations(workspace_id,run_id);
CREATE TABLE agentonic.tool_approvals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, tool_invocation_id uuid NOT NULL, requested_contact_id uuid NOT NULL,
 arguments_sha256 text NOT NULL, decision text NOT NULL DEFAULT 'pending' CHECK(decision IN ('pending','approved','rejected','expired','cancelled')),
 decided_by_contact_id uuid, decided_at timestamptz, expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,tool_invocation_id),
 FOREIGN KEY(workspace_id,tool_invocation_id,arguments_sha256) REFERENCES agentonic.tool_invocations(workspace_id,id,arguments_sha256) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,requested_contact_id) REFERENCES agentonic.contacts(workspace_id,id),
 FOREIGN KEY(workspace_id,decided_by_contact_id) REFERENCES agentonic.contacts(workspace_id,id),
 CHECK(decision NOT IN ('approved','rejected') OR (decided_by_contact_id IS NOT NULL AND decided_at IS NOT NULL)),
 CHECK(consumed_at IS NULL OR decision='approved'),
 CHECK(consumed_at IS NULL OR consumed_at<=expires_at)
);
ALTER TABLE agentonic.channel_endpoints ADD FOREIGN KEY(workspace_id,connection_id) REFERENCES agentonic.connections(workspace_id,id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['connections','agent_connection_grants','tool_invocations','tool_approvals'] LOOP
  EXECUTE format('ALTER TABLE agentonic.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON agentonic.%I FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure,agentonic_deployer_local,agentonic_deployer_azure,agentonic_runtime_local,agentonic_runtime_azure',t);
 END LOOP;
END $$;

-- An invocation's arguments are fixed once requested, and an approval is decided
-- and consumed once: it can neither be reset nor moved to other arguments.
CREATE FUNCTION agentonic.tool_call_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_TABLE_NAME='tool_invocations' THEN
  IF NEW.arguments_sha256<>OLD.arguments_sha256 OR NEW.run_id<>OLD.run_id OR NEW.configuration_tool_id<>OLD.configuration_tool_id THEN RAISE insufficient_privilege; END IF;
 ELSIF NEW.arguments_sha256<>OLD.arguments_sha256 OR NEW.tool_invocation_id<>OLD.tool_invocation_id
  OR (OLD.decision<>'pending' AND NEW.decision IS DISTINCT FROM OLD.decision)
  OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) THEN
  RAISE insufficient_privilege;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tool_invocation_immutable BEFORE UPDATE ON agentonic.tool_invocations FOR EACH ROW EXECUTE FUNCTION agentonic.tool_call_immutable();
CREATE TRIGGER tool_approval_immutable BEFORE UPDATE ON agentonic.tool_approvals FOR EACH ROW EXECUTE FUNCTION agentonic.tool_call_immutable();

-- Gmail connections ----------------------------------------------------------------
CREATE FUNCTION agentonic.connection_status(status text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE status WHEN 'connected' THEN 'active' WHEN 'reconnect' THEN 'expired' ELSE 'revoked' END
$$;
CREATE FUNCTION agentonic.gmail_connection_spine() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO agentonic.connections(id,workspace_id,name,provider,kind,external_account_id,owner_member_id,status,last_verified_at,revoked_at,secret_reference,environment,created_at)
  VALUES(NEW.id,NEW.workspace_id,'Gmail','google_gmail','oauth',NEW.account,NEW.owner_member_id,agentonic.connection_status(NEW.status),NEW.created_at,
   CASE WHEN NEW.status='disconnected' THEN clock_timestamp() END,'gmail_connections:'||NEW.id,'staging',NEW.created_at);
  INSERT INTO agentonic.agent_connection_grants(workspace_id,agent_id,connection_id,environment,allowed_operations,granted_by_member_id,revoked_at,created_at)
  VALUES(NEW.workspace_id,NEW.agent_id,NEW.id,'staging',NEW.operations,NEW.owner_member_id,CASE WHEN NEW.status='disconnected' THEN clock_timestamp() END,NEW.created_at);
  RETURN NEW;
 ELSIF TG_OP='UPDATE' THEN
  UPDATE agentonic.connections SET status=agentonic.connection_status(NEW.status),external_account_id=NEW.account,
   revoked_at=CASE WHEN NEW.status='disconnected' THEN coalesce(revoked_at,clock_timestamp()) END WHERE id=NEW.id;
  UPDATE agentonic.agent_connection_grants SET allowed_operations=NEW.operations,
   revoked_at=CASE WHEN NEW.status='disconnected' THEN coalesce(revoked_at,clock_timestamp()) END WHERE connection_id=NEW.id;
  RETURN NEW;
 END IF;
 DELETE FROM agentonic.connections WHERE id=OLD.id;
 RETURN OLD;
END $$;
CREATE TRIGGER general_connection BEFORE INSERT ON agentonic.gmail_connections FOR EACH ROW EXECUTE FUNCTION agentonic.gmail_connection_spine();
CREATE TRIGGER general_connection_sync AFTER UPDATE OF status,operations,account OR DELETE ON agentonic.gmail_connections FOR EACH ROW EXECUTE FUNCTION agentonic.gmail_connection_spine();

-- Gmail writes -----------------------------------------------------------------------
CREATE FUNCTION agentonic.tool_status(status text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE status WHEN 'pending' THEN 'awaiting_approval' WHEN 'executing' THEN 'running' WHEN 'succeeded' THEN 'succeeded'
  WHEN 'failed' THEN 'failed' WHEN 'uncertain' THEN 'unknown' ELSE 'denied' END
$$;
CREATE FUNCTION agentonic.approval_decision(status text,approved_at timestamptz) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN approved_at IS NOT NULL THEN 'approved' WHEN status='expired' THEN 'expired' WHEN status='cancelled' THEN 'cancelled' ELSE 'pending' END
$$;
-- Only an outcome code crosses into the general record, never message content or IDs.
CREATE FUNCTION agentonic.gmail_outcome(result jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE WHEN result ? 'code' AND result->>'code' ~ '^[a-z_]{1,40}$' THEN jsonb_build_object('code',result->>'code') END
$$;
CREATE FUNCTION agentonic.gmail_invocation_spine() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r agentonic.agent_runs; tool agentonic.configuration_tools; contact uuid;
BEGIN
 IF TG_OP='INSERT' THEN
  SELECT * INTO r FROM agentonic.agent_runs WHERE id=NEW.turn_id AND workspace_id=NEW.workspace_id;
  SELECT t.* INTO tool FROM agentonic.configuration_tools t JOIN agentonic.code_tools k ON k.id=t.code_tool_id
   WHERE t.workspace_id=NEW.workspace_id AND t.configuration_release_id=r.configuration_release_id AND k.package_key='gmail-v1' AND k.name=NEW.operation;
  IF r.id IS NULL OR tool.id IS NULL THEN RAISE insufficient_privilege; END IF;
  contact:=agentonic.member_contact(NEW.workspace_id,NEW.owner_member_id);
  INSERT INTO agentonic.tool_invocations(id,workspace_id,run_id,code_release_id,configuration_tool_id,invocation_key,status,arguments_sha256,policy_snapshot,
   agent_id,configuration_release_id,connection_id,environment,authorization_kind,code_tool_id,created_at)
  VALUES(NEW.id,NEW.workspace_id,r.id,r.code_release_id,tool.id,NEW.id::text,agentonic.tool_status(NEW.status),NEW.arguments_sha256,
   tool.effective_policy||jsonb_build_object('operation',NEW.operation,'executionContext',NEW.execution_context),
   r.agent_id,r.configuration_release_id,NEW.connection_id,'staging','one_off',tool.code_tool_id,NEW.created_at);
  INSERT INTO agentonic.tool_approvals(workspace_id,tool_invocation_id,requested_contact_id,arguments_sha256,expires_at,created_at)
  VALUES(NEW.workspace_id,NEW.id,contact,NEW.arguments_sha256,NEW.expires_at,NEW.created_at);
  RETURN NEW;
 ELSIF TG_OP='UPDATE' THEN
  UPDATE agentonic.tool_invocations SET status=agentonic.tool_status(NEW.status),started_at=NEW.approved_at,finished_at=NEW.finished_at,
   redacted_result=agentonic.gmail_outcome(NEW.result),error_code=CASE WHEN NEW.status IN ('cancelled','expired') THEN NEW.status END WHERE id=NEW.id;
  UPDATE agentonic.tool_approvals a SET decision=agentonic.approval_decision(NEW.status,NEW.approved_at),
   decided_by_contact_id=CASE WHEN NEW.approved_at IS NOT NULL THEN a.requested_contact_id END,decided_at=NEW.approved_at,consumed_at=NEW.approved_at
  WHERE tool_invocation_id=NEW.id AND decision='pending' AND agentonic.approval_decision(NEW.status,NEW.approved_at)<>'pending';
  RETURN NEW;
 END IF;
 DELETE FROM agentonic.tool_invocations WHERE id=OLD.id;
 RETURN OLD;
END $$;
CREATE TRIGGER general_tool_call BEFORE INSERT ON agentonic.gmail_invocations FOR EACH ROW EXECUTE FUNCTION agentonic.gmail_invocation_spine();
CREATE TRIGGER general_tool_call_sync AFTER UPDATE OF status,approved_at,finished_at,result OR DELETE ON agentonic.gmail_invocations FOR EACH ROW EXECUTE FUNCTION agentonic.gmail_invocation_spine();

-- Existing rows, then the extensions' references to their general rows.
INSERT INTO agentonic.connections(id,workspace_id,name,provider,kind,external_account_id,owner_member_id,status,last_verified_at,revoked_at,secret_reference,environment,created_at)
SELECT id,workspace_id,'Gmail','google_gmail','oauth',account,owner_member_id,agentonic.connection_status(status),created_at,
 CASE WHEN status='disconnected' THEN created_at END,'gmail_connections:'||id,'staging',created_at FROM agentonic.gmail_connections;
INSERT INTO agentonic.agent_connection_grants(workspace_id,agent_id,connection_id,environment,allowed_operations,granted_by_member_id,revoked_at,created_at)
SELECT workspace_id,agent_id,id,'staging',operations,owner_member_id,CASE WHEN status='disconnected' THEN created_at END,created_at FROM agentonic.gmail_connections;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM agentonic.gmail_invocations i WHERE NOT EXISTS(SELECT 1 FROM agentonic.agent_runs r WHERE r.id=i.turn_id)) THEN
  RAISE EXCEPTION 'A Gmail invocation has no run; reconcile it before this migration';
 END IF;
END $$;
INSERT INTO agentonic.tool_invocations(id,workspace_id,run_id,code_release_id,configuration_tool_id,invocation_key,status,arguments_sha256,redacted_result,policy_snapshot,
 started_at,finished_at,error_code,agent_id,configuration_release_id,connection_id,environment,authorization_kind,code_tool_id,created_at)
SELECT i.id,i.workspace_id,r.id,r.code_release_id,t.id,i.id::text,agentonic.tool_status(i.status),i.arguments_sha256,agentonic.gmail_outcome(i.result),
 t.effective_policy||jsonb_build_object('operation',i.operation,'executionContext',i.execution_context),i.approved_at,i.finished_at,
 CASE WHEN i.status IN ('cancelled','expired') THEN i.status END,r.agent_id,r.configuration_release_id,i.connection_id,'staging','one_off',t.code_tool_id,i.created_at
FROM agentonic.gmail_invocations i JOIN agentonic.agent_runs r ON r.id=i.turn_id
 JOIN agentonic.configuration_tools t ON t.configuration_release_id=r.configuration_release_id JOIN agentonic.code_tools k ON k.id=t.code_tool_id AND k.package_key='gmail-v1' AND k.name=i.operation;
INSERT INTO agentonic.tool_approvals(workspace_id,tool_invocation_id,requested_contact_id,arguments_sha256,decision,decided_by_contact_id,decided_at,expires_at,consumed_at,created_at)
SELECT i.workspace_id,i.id,c.id,i.arguments_sha256,agentonic.approval_decision(i.status,i.approved_at),CASE WHEN i.approved_at IS NOT NULL THEN c.id END,
 i.approved_at,i.expires_at,i.approved_at,i.created_at
FROM agentonic.gmail_invocations i CROSS JOIN LATERAL (SELECT agentonic.member_contact(i.workspace_id,i.owner_member_id) id) c;
ALTER TABLE agentonic.gmail_connections ADD CONSTRAINT gmail_connections_general FOREIGN KEY(workspace_id,id) REFERENCES agentonic.connections(workspace_id,id);
ALTER TABLE agentonic.gmail_invocations ADD CONSTRAINT gmail_invocations_general FOREIGN KEY(workspace_id,id) REFERENCES agentonic.tool_invocations(workspace_id,id);

REVOKE ALL ON FUNCTION agentonic.tool_call_immutable(),agentonic.connection_status(text),agentonic.gmail_connection_spine(),agentonic.tool_status(text),
 agentonic.approval_decision(text,timestamptz),agentonic.gmail_outcome(jsonb),agentonic.gmail_invocation_spine()
 FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
COMMIT;
