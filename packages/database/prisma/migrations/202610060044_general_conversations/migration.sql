BEGIN;
-- The general conversation model (architecture section 48). Staging chats and
-- private previews were built on their own tables; production chat and every
-- later channel need one model. Conversations, agent runs and messages follow
-- the target schema (schema.dbml), and the existing tables become extensions
-- that share their general row's ID:
--   staging_conversations.id = conversations.id
--   staging_turns.id         = agent_runs.id
--   agent_previews.id        = conversations.id
--   a preview turn's background_jobs.id = agent_runs.id
-- Triggers keep both in step in the same transaction, including erasure: when a
-- chat's text is scrubbed, its messages are redacted; when a preview turn is
-- deleted, its run and messages go with it. Existing command functions are
-- unchanged. Deviations from schema.dbml: agent_runs.deployment_id is null for
-- preview turns (previews run without a deployment), and the max_* limits are
-- null because the broker sets them per turn when the turn runs.

CREATE TABLE agentonic.channel_endpoints (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES agentonic.workspaces(id), agent_id uuid NOT NULL,
 environment text NOT NULL CHECK(environment IN ('development','staging','production')),
 surface text NOT NULL CHECK(surface ~ '^[a-z][a-z0-9_]{1,30}$'), connection_id uuid,
 external_endpoint_key text NOT NULL CHECK(length(external_endpoint_key) BETWEEN 1 AND 200),
 configuration jsonb NOT NULL DEFAULT '{}', enabled boolean NOT NULL DEFAULT false,
 access_mode text NOT NULL DEFAULT 'restricted' CHECK(access_mode IN ('restricted','public')),
 public_capabilities jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,surface,external_endpoint_key), UNIQUE(workspace_id,agent_id,environment,id),
 FOREIGN KEY(workspace_id,agent_id) REFERENCES agentonic.agents(workspace_id,id),
 CHECK(access_mode='restricted' OR jsonb_array_length(public_capabilities)>0)
);
CREATE TABLE agentonic.conversations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, agent_id uuid NOT NULL,
 environment text NOT NULL CHECK(environment IN ('development','staging','production')),
 endpoint_id uuid NOT NULL, external_conversation_key text NOT NULL, owner_contact_id uuid NOT NULL,
 title text, last_active_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz, deleted_at timestamptz,
 audience_mode text NOT NULL DEFAULT 'private' CHECK(audience_mode IN ('private','group')), audience_verified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,endpoint_id,external_conversation_key), UNIQUE(workspace_id,agent_id,environment,id),
 FOREIGN KEY(workspace_id,agent_id,environment,endpoint_id) REFERENCES agentonic.channel_endpoints(workspace_id,agent_id,environment,id),
 FOREIGN KEY(workspace_id,owner_contact_id) REFERENCES agentonic.contacts(workspace_id,id)
);
CREATE INDEX conversations_agent_activity ON agentonic.conversations(workspace_id,agent_id,last_active_at);
CREATE TABLE agentonic.agent_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, agent_id uuid NOT NULL,
 code_release_id uuid NOT NULL, configuration_release_id uuid NOT NULL,
 environment text NOT NULL CHECK(environment IN ('development','staging','production')),
 deployment_id uuid, conversation_id uuid, session_id uuid, acting_contact_id uuid NOT NULL,
 trigger_kind text NOT NULL CHECK(trigger_kind IN ('message','api','schedule','delegation','evaluation','manual')),
 idempotency_key text NOT NULL, trace_id text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','awaiting_approval','succeeded','failed','cancelled','timed_out')),
 effective_prompt_sha256 text NOT NULL CHECK(effective_prompt_sha256 ~ '^[a-f0-9]{64}$'), effective_config jsonb NOT NULL,
 request_object_id uuid, result_object_id uuid, started_at timestamptz, finished_at timestamptz, error_code text, error_summary text,
 max_turns integer CHECK(max_turns>0), max_tool_calls integer CHECK(max_tool_calls>=0), max_duration_seconds integer CHECK(max_duration_seconds>0),
 schedule_fire_id uuid, preview_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,agent_id,idempotency_key), UNIQUE(workspace_id,agent_id,id),
 UNIQUE(workspace_id,code_release_id,id), UNIQUE(workspace_id,conversation_id,id), UNIQUE(workspace_id,agent_id,environment,id),
 UNIQUE(workspace_id,agent_id,code_release_id,configuration_release_id,id),
 FOREIGN KEY(workspace_id,agent_id,code_release_id,configuration_release_id) REFERENCES agentonic.configuration_releases(workspace_id,agent_id,code_release_id,id),
 FOREIGN KEY(workspace_id,agent_id,deployment_id) REFERENCES agentonic.deployments(workspace_id,agent_id,id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES agentonic.conversations(workspace_id,id) ON DELETE SET NULL (conversation_id),
 FOREIGN KEY(workspace_id,acting_contact_id) REFERENCES agentonic.contacts(workspace_id,id),
 FOREIGN KEY(workspace_id,preview_id) REFERENCES agentonic.agent_previews(workspace_id,id),
 CHECK(session_id IS NULL OR conversation_id IS NOT NULL),
 CHECK(finished_at IS NULL OR started_at IS NULL OR finished_at>=started_at),
 CHECK(preview_id IS NULL OR environment='staging'),
 CHECK((deployment_id IS NULL)=(preview_id IS NOT NULL))
);
CREATE INDEX agent_runs_agent_created ON agentonic.agent_runs(workspace_id,agent_id,created_at);
CREATE INDEX agent_runs_status_created ON agentonic.agent_runs(workspace_id,status,created_at);
CREATE TABLE agentonic.messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, conversation_id uuid NOT NULL, run_id uuid,
 author_contact_id uuid, role text NOT NULL CHECK(role IN ('user','assistant','tool','system')),
 sequence_number bigint NOT NULL CHECK(sequence_number>0), external_message_id text, content jsonb NOT NULL,
 redacted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,conversation_id,sequence_number), UNIQUE(workspace_id,conversation_id,external_message_id),
 FOREIGN KEY(workspace_id,conversation_id) REFERENCES agentonic.conversations(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,run_id) REFERENCES agentonic.agent_runs(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,author_contact_id) REFERENCES agentonic.contacts(workspace_id,id),
 CHECK(role NOT IN ('assistant','tool') OR run_id IS NOT NULL),
 CHECK((role='user')=(author_contact_id IS NOT NULL)),
 CHECK(content->>'version'='1')
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['channel_endpoints','conversations','agent_runs','messages'] LOOP
  EXECUTE format('ALTER TABLE agentonic.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON agentonic.%I FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure,agentonic_deployer_local,agentonic_deployer_azure,agentonic_runtime_local,agentonic_runtime_azure',t);
 END LOOP;
END $$;

-- A member's channel identity: the contact linked to their verified user, as
-- access_command 'contact.ensure' creates it. Never unblocks an offboarded contact.
CREATE FUNCTION agentonic.member_contact(workspace uuid,member uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE contact uuid;
BEGIN
 INSERT INTO agentonic.contacts(workspace_id,display_name,linked_user_id,user_link_verified_at)
 SELECT m.workspace_id,left(u.display_name,120),u.id,clock_timestamp() FROM agentonic.workspace_members m JOIN agentonic.users u ON u.id=m.user_id
 WHERE m.workspace_id=workspace AND m.id=member
 ON CONFLICT(workspace_id,linked_user_id) DO UPDATE SET linked_user_id=excluded.linked_user_id RETURNING id INTO contact;
 IF contact IS NULL THEN RAISE insufficient_privilege; END IF;
 RETURN contact;
END $$;
-- The agent's own panel endpoint per surface: 'web' for chats, 'preview' for previews.
CREATE FUNCTION agentonic.panel_endpoint(workspace uuid,agent uuid,kind text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE endpoint uuid;
BEGIN
 INSERT INTO agentonic.channel_endpoints(workspace_id,agent_id,environment,surface,external_endpoint_key,enabled)
 VALUES(workspace,agent,'staging',kind,'panel:'||agent,true)
 ON CONFLICT(workspace_id,surface,external_endpoint_key) DO UPDATE SET enabled=channel_endpoints.enabled RETURNING id INTO endpoint;
 RETURN endpoint;
END $$;
CREATE FUNCTION agentonic.run_status(status text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT CASE status WHEN 'queued' THEN 'queued' WHEN 'running' THEN 'running' WHEN 'succeeded' THEN 'succeeded' WHEN 'failed' THEN 'failed' ELSE 'cancelled' END
$$;
CREATE FUNCTION agentonic.redacted_content() RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $$ SELECT '{"version":"1","redacted":true}'::jsonb $$;

-- Staging chats -----------------------------------------------------------------
CREATE FUNCTION agentonic.staging_conversation_spine() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO agentonic.conversations(id,workspace_id,agent_id,environment,endpoint_id,external_conversation_key,owner_contact_id,title,last_active_at,expires_at,created_at)
  VALUES(NEW.id,NEW.workspace_id,NEW.agent_id,'staging',agentonic.panel_endpoint(NEW.workspace_id,NEW.agent_id,'web'),NEW.id::text,
   agentonic.member_contact(NEW.workspace_id,NEW.owner_member_id),NEW.title,NEW.created_at,NEW.expires_at,NEW.created_at);
  RETURN NEW;
 ELSIF TG_OP='UPDATE' THEN
  UPDATE agentonic.conversations SET title=NEW.title,expires_at=NEW.expires_at,deleted_at=NEW.closed_at WHERE id=NEW.id;
  RETURN NEW;
 END IF;
 DELETE FROM agentonic.conversations WHERE id=OLD.id;
 RETURN OLD;
END $$;
CREATE TRIGGER general_conversation BEFORE INSERT ON agentonic.staging_conversations FOR EACH ROW EXECUTE FUNCTION agentonic.staging_conversation_spine();
CREATE TRIGGER general_conversation_sync AFTER UPDATE OF title,expires_at,closed_at OR DELETE ON agentonic.staging_conversations FOR EACH ROW EXECUTE FUNCTION agentonic.staging_conversation_spine();

CREATE FUNCTION agentonic.staging_turn_spine() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c agentonic.conversations; d agentonic.deployments; prompt text;
BEGIN
 IF TG_OP='DELETE' THEN DELETE FROM agentonic.agent_runs WHERE id=OLD.id; RETURN OLD; END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO c FROM agentonic.conversations WHERE id=NEW.conversation_id;
  SELECT dep.* INTO d FROM agentonic.staging_conversations sc JOIN agentonic.deployments dep ON dep.id=sc.deployment_id WHERE sc.id=NEW.conversation_id;
  SELECT composed_prompt_sha256 INTO prompt FROM agentonic.configuration_releases WHERE id=d.configuration_release_id;
  INSERT INTO agentonic.agent_runs(id,workspace_id,agent_id,code_release_id,configuration_release_id,environment,deployment_id,conversation_id,acting_contact_id,
   trigger_kind,idempotency_key,trace_id,status,effective_prompt_sha256,effective_config,started_at,created_at)
  VALUES(NEW.id,NEW.workspace_id,d.agent_id,d.code_release_id,d.configuration_release_id,'staging',d.id,c.id,c.owner_contact_id,
   'message','staging:'||NEW.conversation_id||':'||NEW.request_id,NEW.id::text,agentonic.run_status(NEW.status),prompt,
   jsonb_build_object('model',NEW.response_model,'reasoning',NEW.reasoning_effort),NEW.started_at,NEW.created_at);
  INSERT INTO agentonic.messages(workspace_id,conversation_id,run_id,author_contact_id,role,sequence_number,external_message_id,content,created_at)
  VALUES(NEW.workspace_id,c.id,NEW.id,c.owner_contact_id,'user',2*NEW.number-1,'turn:'||NEW.number||':user',jsonb_build_object('version','1','text',NEW.query),NEW.created_at);
  UPDATE agentonic.conversations SET last_active_at=NEW.created_at WHERE id=c.id;
  RETURN NEW;
 END IF;
 UPDATE agentonic.agent_runs SET status=agentonic.run_status(NEW.status),started_at=NEW.started_at,error_code=NEW.error_code,
  finished_at=CASE WHEN NEW.status IN ('succeeded','failed','cancelled') THEN coalesce(finished_at,clock_timestamp()) END WHERE id=NEW.id;
 IF NEW.status='succeeded' AND NEW.scrubbed_at IS NULL AND NOT EXISTS(SELECT 1 FROM agentonic.messages WHERE run_id=NEW.id AND role='assistant') THEN
  INSERT INTO agentonic.messages(workspace_id,conversation_id,run_id,role,sequence_number,external_message_id,content)
  VALUES(NEW.workspace_id,NEW.conversation_id,NEW.id,'assistant',2*NEW.number,'turn:'||NEW.number||':assistant',
   jsonb_build_object('version','1','text',NEW.answer,'citations',NEW.citations,'insufficientEvidence',NEW.insufficient_evidence));
  UPDATE agentonic.conversations SET last_active_at=clock_timestamp() WHERE id=NEW.conversation_id;
 END IF;
 -- Scrubbing the turn's text redacts every message it produced.
 IF NEW.scrubbed_at IS NOT NULL THEN
  UPDATE agentonic.messages SET content=agentonic.redacted_content(),redacted_at=coalesce(redacted_at,NEW.scrubbed_at) WHERE run_id=NEW.id AND redacted_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER general_run BEFORE INSERT ON agentonic.staging_turns FOR EACH ROW EXECUTE FUNCTION agentonic.staging_turn_spine();
CREATE TRIGGER general_run_sync AFTER UPDATE OF status,started_at,error_code,answer,scrubbed_at OR DELETE ON agentonic.staging_turns FOR EACH ROW EXECUTE FUNCTION agentonic.staging_turn_spine();

-- Private previews -------------------------------------------------------------
CREATE FUNCTION agentonic.preview_spine() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO agentonic.conversations(id,workspace_id,agent_id,environment,endpoint_id,external_conversation_key,owner_contact_id,last_active_at,expires_at,created_at)
  VALUES(NEW.id,NEW.workspace_id,NEW.agent_id,'staging',agentonic.panel_endpoint(NEW.workspace_id,NEW.agent_id,'preview'),NEW.id::text,
   agentonic.member_contact(NEW.workspace_id,NEW.requested_by_member_id),NEW.created_at,NEW.expires_at,NEW.created_at);
  RETURN NEW;
 ELSIF TG_OP='UPDATE' THEN
  UPDATE agentonic.conversations SET expires_at=NEW.expires_at,deleted_at=CASE WHEN NEW.status='running' THEN NULL ELSE coalesce(deleted_at,clock_timestamp()) END WHERE id=NEW.id;
  RETURN NEW;
 END IF;
 DELETE FROM agentonic.conversations WHERE id=OLD.id;
 RETURN OLD;
END $$;
CREATE TRIGGER general_conversation BEFORE INSERT ON agentonic.agent_previews FOR EACH ROW EXECUTE FUNCTION agentonic.preview_spine();
CREATE TRIGGER general_conversation_sync AFTER UPDATE OF status,expires_at OR DELETE ON agentonic.agent_previews FOR EACH ROW EXECUTE FUNCTION agentonic.preview_spine();

CREATE FUNCTION agentonic.preview_turn_spine() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p agentonic.agent_previews; c agentonic.conversations; prompt text;
BEGIN
 IF TG_OP='DELETE' THEN DELETE FROM agentonic.agent_runs WHERE id=OLD.id; RETURN OLD; END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO p FROM agentonic.agent_previews WHERE id=NEW.preview_id;
  SELECT * INTO c FROM agentonic.conversations WHERE id=p.id;
  SELECT composed_prompt_sha256 INTO prompt FROM agentonic.configuration_releases WHERE id=p.configuration_release_id;
  INSERT INTO agentonic.agent_runs(id,workspace_id,agent_id,code_release_id,configuration_release_id,environment,conversation_id,acting_contact_id,
   trigger_kind,idempotency_key,trace_id,status,effective_prompt_sha256,effective_config,preview_id,created_at)
  VALUES(NEW.id,NEW.workspace_id,p.agent_id,p.code_release_id,p.configuration_release_id,'staging',c.id,c.owner_contact_id,
   'message','preview:'||p.id||':'||NEW.request_key,NEW.id::text,agentonic.run_status(NEW.status),prompt,
   jsonb_build_object('model',NEW.response_model,'reasoning',NEW.reasoning_effort),p.id,NEW.created_at);
  INSERT INTO agentonic.messages(workspace_id,conversation_id,run_id,author_contact_id,role,sequence_number,external_message_id,content,created_at)
  VALUES(NEW.workspace_id,c.id,NEW.id,c.owner_contact_id,'user',2*NEW.turn_number-1,'turn:'||NEW.turn_number||':user',
   jsonb_build_object('version','1','text',NEW.payload->>'query'),NEW.created_at);
  UPDATE agentonic.conversations SET last_active_at=NEW.created_at WHERE id=c.id;
  RETURN NEW;
 END IF;
 UPDATE agentonic.agent_runs SET status=agentonic.run_status(NEW.status),error_code=NEW.error_code,
  started_at=CASE WHEN NEW.status<>'queued' THEN coalesce(started_at,NEW.updated_at) END,
  finished_at=CASE WHEN NEW.status IN ('succeeded','failed','cancelled') THEN coalesce(finished_at,clock_timestamp()) END WHERE id=NEW.id;
 IF NEW.status='succeeded' AND NEW.result ? 'answer' AND NOT EXISTS(SELECT 1 FROM agentonic.messages WHERE run_id=NEW.id AND role='assistant') THEN
  INSERT INTO agentonic.messages(workspace_id,conversation_id,run_id,role,sequence_number,external_message_id,content)
  VALUES(NEW.workspace_id,NEW.preview_id,NEW.id,'assistant',2*NEW.turn_number,'turn:'||NEW.turn_number||':assistant',
   jsonb_build_object('version','1','text',NEW.result->'answer'->>'text','citations',coalesce(NEW.result->'answer'->'citations','[]'),'insufficientEvidence',NEW.result->'answer'->'insufficientEvidence'));
  UPDATE agentonic.conversations SET last_active_at=clock_timestamp() WHERE id=NEW.preview_id;
 END IF;
 -- A cancelled preview turn keeps no text (background_jobs clears its payload too).
 IF NEW.status='cancelled' THEN
  UPDATE agentonic.messages SET content=agentonic.redacted_content(),redacted_at=coalesce(redacted_at,clock_timestamp()) WHERE run_id=NEW.id AND redacted_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER general_preview_run AFTER INSERT ON agentonic.background_jobs FOR EACH ROW WHEN (NEW.preview_id IS NOT NULL) EXECUTE FUNCTION agentonic.preview_turn_spine();
CREATE TRIGGER general_preview_run_sync AFTER UPDATE OF status,error_code,result ON agentonic.background_jobs FOR EACH ROW WHEN (NEW.preview_id IS NOT NULL) EXECUTE FUNCTION agentonic.preview_turn_spine();
CREATE TRIGGER general_preview_run_drop AFTER DELETE ON agentonic.background_jobs FOR EACH ROW WHEN (OLD.preview_id IS NOT NULL) EXECUTE FUNCTION agentonic.preview_turn_spine();

-- Existing rows, then the extensions' references to their general rows.
INSERT INTO agentonic.conversations(id,workspace_id,agent_id,environment,endpoint_id,external_conversation_key,owner_contact_id,title,last_active_at,expires_at,deleted_at,created_at)
SELECT sc.id,sc.workspace_id,sc.agent_id,'staging',agentonic.panel_endpoint(sc.workspace_id,sc.agent_id,'web'),sc.id::text,agentonic.member_contact(sc.workspace_id,sc.owner_member_id),
 sc.title,sc.created_at,sc.expires_at,sc.closed_at,sc.created_at FROM agentonic.staging_conversations sc;
INSERT INTO agentonic.conversations(id,workspace_id,agent_id,environment,endpoint_id,external_conversation_key,owner_contact_id,last_active_at,expires_at,deleted_at,created_at)
SELECT p.id,p.workspace_id,p.agent_id,'staging',agentonic.panel_endpoint(p.workspace_id,p.agent_id,'preview'),p.id::text,agentonic.member_contact(p.workspace_id,p.requested_by_member_id),
 p.created_at,p.expires_at,CASE WHEN p.status<>'running' THEN p.expires_at END,p.created_at FROM agentonic.agent_previews p;
INSERT INTO agentonic.agent_runs(id,workspace_id,agent_id,code_release_id,configuration_release_id,environment,deployment_id,conversation_id,acting_contact_id,
 trigger_kind,idempotency_key,trace_id,status,effective_prompt_sha256,effective_config,started_at,created_at)
SELECT t.id,t.workspace_id,d.agent_id,d.code_release_id,d.configuration_release_id,'staging',d.id,c.id,c.owner_contact_id,'message','staging:'||t.conversation_id||':'||t.request_id,t.id::text,
 agentonic.run_status(t.status),r.composed_prompt_sha256,jsonb_build_object('model',t.response_model,'reasoning',t.reasoning_effort),t.started_at,t.created_at
FROM agentonic.staging_turns t JOIN agentonic.conversations c ON c.id=t.conversation_id JOIN agentonic.staging_conversations sc ON sc.id=t.conversation_id
 JOIN agentonic.deployments d ON d.id=sc.deployment_id JOIN agentonic.configuration_releases r ON r.id=d.configuration_release_id;
INSERT INTO agentonic.messages(workspace_id,conversation_id,run_id,author_contact_id,role,sequence_number,external_message_id,content,redacted_at,created_at)
SELECT t.workspace_id,t.conversation_id,t.id,c.owner_contact_id,'user',2*t.number-1,'turn:'||t.number||':user',
 CASE WHEN t.scrubbed_at IS NULL THEN jsonb_build_object('version','1','text',t.query) ELSE agentonic.redacted_content() END,t.scrubbed_at,t.created_at
FROM agentonic.staging_turns t JOIN agentonic.conversations c ON c.id=t.conversation_id;
INSERT INTO agentonic.messages(workspace_id,conversation_id,run_id,role,sequence_number,external_message_id,content,redacted_at,created_at)
SELECT t.workspace_id,t.conversation_id,t.id,'assistant',2*t.number,'turn:'||t.number||':assistant',
 CASE WHEN t.scrubbed_at IS NULL THEN jsonb_build_object('version','1','text',t.answer,'citations',t.citations,'insufficientEvidence',t.insufficient_evidence) ELSE agentonic.redacted_content() END,t.scrubbed_at,t.created_at
FROM agentonic.staging_turns t WHERE t.status='succeeded';
INSERT INTO agentonic.agent_runs(id,workspace_id,agent_id,code_release_id,configuration_release_id,environment,conversation_id,acting_contact_id,
 trigger_kind,idempotency_key,trace_id,status,effective_prompt_sha256,effective_config,preview_id,created_at)
SELECT j.id,j.workspace_id,p.agent_id,p.code_release_id,p.configuration_release_id,'staging',c.id,c.owner_contact_id,'message','preview:'||p.id||':'||j.request_key,j.id::text,
 agentonic.run_status(j.status),r.composed_prompt_sha256,jsonb_build_object('model',j.response_model,'reasoning',j.reasoning_effort),p.id,j.created_at
FROM agentonic.background_jobs j JOIN agentonic.agent_previews p ON p.id=j.preview_id JOIN agentonic.conversations c ON c.id=p.id JOIN agentonic.configuration_releases r ON r.id=p.configuration_release_id;
INSERT INTO agentonic.messages(workspace_id,conversation_id,run_id,author_contact_id,role,sequence_number,external_message_id,content,redacted_at,created_at)
SELECT j.workspace_id,j.preview_id,j.id,c.owner_contact_id,'user',2*j.turn_number-1,'turn:'||j.turn_number||':user',
 CASE WHEN j.status<>'cancelled' THEN jsonb_build_object('version','1','text',j.payload->>'query') ELSE agentonic.redacted_content() END,
 CASE WHEN j.status='cancelled' THEN j.updated_at END,j.created_at
FROM agentonic.background_jobs j JOIN agentonic.conversations c ON c.id=j.preview_id;
INSERT INTO agentonic.messages(workspace_id,conversation_id,run_id,role,sequence_number,external_message_id,content,created_at)
SELECT j.workspace_id,j.preview_id,j.id,'assistant',2*j.turn_number,'turn:'||j.turn_number||':assistant',
 jsonb_build_object('version','1','text',j.result->'answer'->>'text','citations',coalesce(j.result->'answer'->'citations','[]'),'insufficientEvidence',j.result->'answer'->'insufficientEvidence'),j.updated_at
FROM agentonic.background_jobs j WHERE j.preview_id IS NOT NULL AND j.status='succeeded' AND j.result ? 'answer';
ALTER TABLE agentonic.staging_conversations ADD CONSTRAINT staging_conversations_general FOREIGN KEY(workspace_id,id) REFERENCES agentonic.conversations(workspace_id,id);
ALTER TABLE agentonic.staging_turns ADD CONSTRAINT staging_turns_general FOREIGN KEY(workspace_id,id) REFERENCES agentonic.agent_runs(workspace_id,id);
ALTER TABLE agentonic.agent_previews ADD CONSTRAINT agent_previews_general FOREIGN KEY(workspace_id,id) REFERENCES agentonic.conversations(workspace_id,id);

REVOKE ALL ON FUNCTION agentonic.member_contact(uuid,uuid),agentonic.panel_endpoint(uuid,uuid,text),agentonic.run_status(text),agentonic.redacted_content(),
 agentonic.staging_conversation_spine(),agentonic.staging_turn_spine(),agentonic.preview_spine(),agentonic.preview_turn_spine()
 FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
COMMIT;
