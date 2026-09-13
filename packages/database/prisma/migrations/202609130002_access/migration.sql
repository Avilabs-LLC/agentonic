-- Step 2: identity and resource authority. Applied only after deterministic verification.

BEGIN;

CREATE TABLE agentonic.workspace_invitations (
 "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 "workspace_id" UUID NOT NULL,
 "email_normalized" TEXT NOT NULL,
 "role" TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
 "token_hash" TEXT NOT NULL UNIQUE,
 "invited_by_member_id" UUID NOT NULL,
 "expires_at" TIMESTAMPTZ NOT NULL,
 "accepted_at" TIMESTAMPTZ,
 "revoked_at" TIMESTAMPTZ,
 "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE (workspace_id, id)
);

CREATE INDEX workspace_invitations_workspace_id_email_normalized_idx ON agentonic.workspace_invitations (workspace_id, email_normalized);

CREATE TABLE agentonic.support_access_grants (
 "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 "workspace_id" UUID NOT NULL,
 "staff_id" UUID NOT NULL,
 "approved_by_member_id" UUID NOT NULL,
 "reason" TEXT NOT NULL,
 "scope" JSONB NOT NULL,
 "expires_at" TIMESTAMPTZ NOT NULL,
 "revoked_at" TIMESTAMPTZ,
 "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE (workspace_id, id),
 UNIQUE (workspace_id, staff_id, id)
);

CREATE TABLE agentonic.contacts (
 "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 "workspace_id" UUID NOT NULL,
 "display_name" TEXT NOT NULL,
 "linked_user_id" UUID,
 "user_link_verified_at" TIMESTAMPTZ,
 "blocked_at" TIMESTAMPTZ,
 "deleted_at" TIMESTAMPTZ,
 "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK ((linked_user_id IS NULL) = (user_link_verified_at IS NULL)),
 UNIQUE (workspace_id, id),
 UNIQUE (workspace_id, linked_user_id)
);

CREATE TABLE agentonic.agent_contact_grants (
 "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 "workspace_id" UUID NOT NULL,
 "agent_id" UUID NOT NULL,
 "contact_id" UUID NOT NULL,
 "allowed_capabilities" JSONB NOT NULL DEFAULT '[]'::jsonb,
 "granted_by_member_id" UUID NOT NULL,
 "expires_at" TIMESTAMPTZ,
 "revoked_at" TIMESTAMPTZ,
 "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE (workspace_id, id),
 UNIQUE (workspace_id, agent_id, contact_id)
);

CREATE TABLE agentonic.code_repositories (
 "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 "name" TEXT NOT NULL,
 "repository_url" TEXT NOT NULL UNIQUE,
 "repository_subdirectory" TEXT NOT NULL DEFAULT '.',
 "default_branch" TEXT NOT NULL DEFAULT 'main',
 "visibility" TEXT NOT NULL CHECK (visibility IN ('platform', 'workspace')),
 "workspace_id" UUID,
 "provisioning_status" TEXT NOT NULL DEFAULT 'planned' CHECK (provisioning_status IN ('planned', 'ready', 'archived')),
 "created_by_staff_id" UUID NOT NULL,
 "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK ((visibility = 'platform' AND workspace_id IS NULL) OR (visibility = 'workspace' AND workspace_id IS NOT NULL))
);

CREATE TABLE agentonic.agent_templates (
 "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 "slug" TEXT NOT NULL UNIQUE,
 "name" TEXT NOT NULL,
 "deprecated_at" TIMESTAMPTZ,
 "code_repository_id" UUID NOT NULL,
 "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agentonic.template_versions (
 "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 "template_id" UUID NOT NULL,
 "version" TEXT NOT NULL,
 "git_commit_sha" TEXT NOT NULL,
 "manifest_sha256" TEXT NOT NULL,
 "structure_manifest" JSONB NOT NULL,
 "runtime_contract_version" TEXT NOT NULL,
 "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE (template_id, version)
);

CREATE TABLE agentonic.agents (
 "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 "workspace_id" UUID NOT NULL,
 "name" TEXT NOT NULL,
 "slug" TEXT NOT NULL,
 "description" TEXT,
 "owner_member_id" UUID NOT NULL,
 "template_version_id" UUID NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
 "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
 "archived_at" TIMESTAMPTZ,
 "created_by_member_id" UUID,
 "created_by_staff_id" UUID,
 "creation_support_access_grant_id" UUID,
 "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK (num_nonnulls(created_by_member_id, created_by_staff_id) = 1),
 CHECK (creation_support_access_grant_id IS NULL OR created_by_staff_id IS NOT NULL),
 CHECK (created_by_staff_id IS NULL OR creation_support_access_grant_id IS NOT NULL),
 UNIQUE (workspace_id, id),
 UNIQUE (workspace_id, slug)
);

CREATE TABLE agentonic.agent_member_grants (
 "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 "workspace_id" UUID NOT NULL,
 "agent_id" UUID NOT NULL,
 "member_id" UUID NOT NULL,
 "role" TEXT NOT NULL CHECK (role IN ('maintainer', 'operator', 'viewer')),
 "granted_by_member_id" UUID NOT NULL,
 "revoked_at" TIMESTAMPTZ,
 "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE (workspace_id, id),
 UNIQUE (workspace_id, agent_id, member_id)
);

CREATE TABLE agentonic.knowledge_collections (
 "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 "workspace_id" UUID NOT NULL,
 "name" TEXT NOT NULL,
 "slug" TEXT NOT NULL,
 "owner_member_id" UUID NOT NULL,
 "description" TEXT,
 "archived_at" TIMESTAMPTZ,
 "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE (workspace_id, id),
 UNIQUE (workspace_id, slug)
);

CREATE TABLE agentonic.collection_member_grants (
 "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 "workspace_id" UUID NOT NULL,
 "collection_id" UUID NOT NULL,
 "member_id" UUID NOT NULL,
 "permission" TEXT NOT NULL CHECK (permission IN ('read', 'curate')),
 "granted_by_member_id" UUID NOT NULL,
 "revoked_at" TIMESTAMPTZ,
 "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE (workspace_id, id),
 UNIQUE (workspace_id, collection_id, member_id)
);

CREATE TABLE agentonic.audit_events (
 "id" UUID NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 "workspace_id" UUID NOT NULL,
 "actor_user_id" UUID,
 "actor_member_id" UUID,
 "actor_agent_id" UUID,
 "support_access_grant_id" UUID,
 "run_id" UUID,
 "action" TEXT NOT NULL,
 "resource_type" TEXT NOT NULL,
 "resource_id" TEXT NOT NULL,
 "outcome" TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'succeeded', 'failed')),
 "request_id" TEXT,
 "redacted_details" JSONB NOT NULL DEFAULT '{}'::jsonb,
 "actor_contact_id" UUID,
 "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE (workspace_id, id)
);

CREATE INDEX audit_events_workspace_id_created_at_idx ON agentonic.audit_events (workspace_id, created_at);

CREATE INDEX audit_events_workspace_id_resource_type_resource_id_idx ON agentonic.audit_events (workspace_id, resource_type, resource_id);

ALTER TABLE agentonic.workspace_invitations ADD CONSTRAINT workspace_invitations_relation_4_fk FOREIGN KEY (workspace_id) REFERENCES agentonic.workspaces (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.workspace_invitations ADD CONSTRAINT workspace_invitations_relation_5_fk FOREIGN KEY (workspace_id, invited_by_member_id) REFERENCES agentonic.workspace_members (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.support_access_grants ADD CONSTRAINT support_access_grants_relation_6_fk FOREIGN KEY (workspace_id) REFERENCES agentonic.workspaces (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.support_access_grants ADD CONSTRAINT support_access_grants_relation_7_fk FOREIGN KEY (staff_id) REFERENCES agentonic.platform_staff (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.support_access_grants ADD CONSTRAINT support_access_grants_relation_8_fk FOREIGN KEY (workspace_id, approved_by_member_id) REFERENCES agentonic.workspace_members (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.template_versions ADD CONSTRAINT template_versions_relation_9_fk FOREIGN KEY (template_id) REFERENCES agentonic.agent_templates (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.agents ADD CONSTRAINT agents_relation_10_fk FOREIGN KEY (workspace_id) REFERENCES agentonic.workspaces (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.agents ADD CONSTRAINT agents_relation_11_fk FOREIGN KEY (workspace_id, owner_member_id) REFERENCES agentonic.workspace_members (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.agents ADD CONSTRAINT agents_relation_12_fk FOREIGN KEY (template_version_id) REFERENCES agentonic.template_versions (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.agent_member_grants ADD CONSTRAINT agent_member_grants_relation_13_fk FOREIGN KEY (workspace_id) REFERENCES agentonic.workspaces (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.agent_member_grants ADD CONSTRAINT agent_member_grants_relation_14_fk FOREIGN KEY (workspace_id, agent_id) REFERENCES agentonic.agents (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.agent_member_grants ADD CONSTRAINT agent_member_grants_relation_15_fk FOREIGN KEY (workspace_id, member_id) REFERENCES agentonic.workspace_members (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.agent_member_grants ADD CONSTRAINT agent_member_grants_relation_16_fk FOREIGN KEY (workspace_id, granted_by_member_id) REFERENCES agentonic.workspace_members (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.knowledge_collections ADD CONSTRAINT knowledge_collections_relation_17_fk FOREIGN KEY (workspace_id) REFERENCES agentonic.workspaces (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.knowledge_collections ADD CONSTRAINT knowledge_collections_relation_18_fk FOREIGN KEY (workspace_id, owner_member_id) REFERENCES agentonic.workspace_members (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.collection_member_grants ADD CONSTRAINT collection_member_grants_relation_19_fk FOREIGN KEY (workspace_id) REFERENCES agentonic.workspaces (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.collection_member_grants ADD CONSTRAINT collection_member_grants_relation_20_fk FOREIGN KEY (workspace_id, collection_id) REFERENCES agentonic.knowledge_collections (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.collection_member_grants ADD CONSTRAINT collection_member_grants_relation_21_fk FOREIGN KEY (workspace_id, member_id) REFERENCES agentonic.workspace_members (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.collection_member_grants ADD CONSTRAINT collection_member_grants_relation_22_fk FOREIGN KEY (workspace_id, granted_by_member_id) REFERENCES agentonic.workspace_members (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.audit_events ADD CONSTRAINT audit_events_relation_23_fk FOREIGN KEY (workspace_id) REFERENCES agentonic.workspaces (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.audit_events ADD CONSTRAINT audit_events_relation_24_fk FOREIGN KEY (actor_user_id) REFERENCES agentonic.users (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.audit_events ADD CONSTRAINT audit_events_relation_25_fk FOREIGN KEY (workspace_id, actor_member_id) REFERENCES agentonic.workspace_members (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.audit_events ADD CONSTRAINT audit_events_relation_26_fk FOREIGN KEY (workspace_id, actor_agent_id) REFERENCES agentonic.agents (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.audit_events ADD CONSTRAINT audit_events_relation_27_fk FOREIGN KEY (workspace_id, support_access_grant_id) REFERENCES agentonic.support_access_grants (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.contacts ADD CONSTRAINT contacts_relation_28_fk FOREIGN KEY (workspace_id) REFERENCES agentonic.workspaces (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.contacts ADD CONSTRAINT contacts_relation_29_fk FOREIGN KEY (linked_user_id) REFERENCES agentonic.users (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.agent_contact_grants ADD CONSTRAINT agent_contact_grants_relation_30_fk FOREIGN KEY (workspace_id) REFERENCES agentonic.workspaces (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.agent_contact_grants ADD CONSTRAINT agent_contact_grants_relation_31_fk FOREIGN KEY (workspace_id, agent_id) REFERENCES agentonic.agents (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.agent_contact_grants ADD CONSTRAINT agent_contact_grants_relation_32_fk FOREIGN KEY (workspace_id, contact_id) REFERENCES agentonic.contacts (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.agent_contact_grants ADD CONSTRAINT agent_contact_grants_relation_33_fk FOREIGN KEY (workspace_id, granted_by_member_id) REFERENCES agentonic.workspace_members (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.audit_events ADD CONSTRAINT audit_events_relation_34_fk FOREIGN KEY (workspace_id, actor_contact_id) REFERENCES agentonic.contacts (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.code_repositories ADD CONSTRAINT code_repositories_relation_35_fk FOREIGN KEY (workspace_id) REFERENCES agentonic.workspaces (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.code_repositories ADD CONSTRAINT code_repositories_relation_36_fk FOREIGN KEY (created_by_staff_id) REFERENCES agentonic.platform_staff (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.agent_templates ADD CONSTRAINT agent_templates_relation_37_fk FOREIGN KEY (code_repository_id) REFERENCES agentonic.code_repositories (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.agents ADD CONSTRAINT agents_relation_38_fk FOREIGN KEY (workspace_id, created_by_member_id) REFERENCES agentonic.workspace_members (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.agents ADD CONSTRAINT agents_relation_39_fk FOREIGN KEY (created_by_staff_id) REFERENCES agentonic.platform_staff (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.agents ADD CONSTRAINT agents_relation_40_fk FOREIGN KEY (workspace_id, created_by_staff_id, creation_support_access_grant_id) REFERENCES agentonic.support_access_grants (workspace_id, staff_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Not-yet-implemented run actors cannot be smuggled into audit provenance.
ALTER TABLE agentonic.audit_events ADD CHECK (actor_agent_id IS NULL AND run_id IS NULL AND actor_contact_id IS NULL);
CREATE UNIQUE INDEX workspace_invitations_live_email ON agentonic.workspace_invitations(workspace_id,email_normalized)
 WHERE accepted_at IS NULL AND revoked_at IS NULL;
ALTER TABLE agentonic.workspace_invitations ADD CHECK (email_normalized=lower(btrim(email_normalized)) AND length(email_normalized) BETWEEN 3 AND 320);
ALTER TABLE agentonic.workspace_invitations ADD CHECK (token_hash ~ '^[a-f0-9]{64}$' AND expires_at>created_at AND NOT(accepted_at IS NOT NULL AND revoked_at IS NOT NULL));
ALTER TABLE agentonic.support_access_grants ADD CHECK (expires_at>created_at AND length(btrim(reason)) BETWEEN 1 AND 500);
ALTER TABLE agentonic.agents ADD CHECK (length(btrim(name)) BETWEEN 1 AND 120 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug)<=100);
ALTER TABLE agentonic.knowledge_collections ADD CHECK (length(btrim(name)) BETWEEN 1 AND 120 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug)<=100);
ALTER TABLE agentonic.contacts ADD CHECK (length(btrim(display_name)) BETWEEN 1 AND 120);
ALTER TABLE agentonic.template_versions ADD CHECK (git_commit_sha ~ '^[a-f0-9]{40}$' AND manifest_sha256 ~ '^[a-f0-9]{64}$' AND jsonb_typeof(structure_manifest)='object');

-- Inside SECURITY DEFINER, current_user is the function owner; session_user and
-- the real SET ROLE setting preserve the authenticated application-role boundary.
CREATE FUNCTION agentonic.application_role() RETURNS text LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT coalesce(nullif(current_setting('role',true),'none'),session_user::text)
$$;
CREATE FUNCTION agentonic.current_member() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT m.id FROM agentonic.workspace_members m JOIN agentonic.workspaces w ON w.id=m.workspace_id
 JOIN agentonic.users u ON u.id=m.user_id
 WHERE m.workspace_id=agentonic.workspace_id() AND u.id=agentonic.actor_user_id()
 AND m.status='active' AND m.removed_at IS NULL AND u.deleted_at IS NULL AND w.status='active' AND w.deleted_at IS NULL
$$;
CREATE FUNCTION agentonic.member_active(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM agentonic.workspace_members m JOIN agentonic.users u ON u.id=m.user_id
 JOIN agentonic.workspaces w ON w.id=m.workspace_id WHERE m.id=target AND m.workspace_id=agentonic.workspace_id()
 AND m.status='active' AND m.removed_at IS NULL AND u.deleted_at IS NULL AND w.status='active' AND w.deleted_at IS NULL)
$$;
CREATE FUNCTION agentonic.workspace_manager() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM agentonic.workspace_members WHERE id=agentonic.current_member() AND role IN ('owner','admin'))
$$;
CREATE FUNCTION agentonic.current_staff() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT id FROM agentonic.platform_staff WHERE user_id=agentonic.actor_user_id() AND disabled_at IS NULL
 AND role IN ('administrator','operator','support') AND agentonic.application_role()='agentonic_admin'
$$;
CREATE FUNCTION agentonic.can_agent(target uuid, operation text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(EXISTS(SELECT 1 FROM agentonic.agents a WHERE a.id=target AND a.workspace_id=agentonic.workspace_id()
 AND a.archived_at IS NULL AND a.status<>'archived' AND agentonic.member_active(a.owner_member_id)
 AND agentonic.current_member() IS NOT NULL AND operation IN ('read','edit','invoke','share')
 AND (a.owner_member_id=agentonic.current_member() OR EXISTS(
  SELECT 1 FROM agentonic.agent_member_grants g WHERE g.workspace_id=a.workspace_id AND g.agent_id=a.id
  AND g.member_id=agentonic.current_member() AND g.revoked_at IS NULL AND g.granted_by_member_id=a.owner_member_id
  AND agentonic.member_active(g.granted_by_member_id) AND (operation='read' OR (operation='edit' AND g.role='maintainer') OR (operation='invoke' AND g.role IN ('maintainer','operator')))))),false)
$$;
CREATE FUNCTION agentonic.can_collection(target uuid, operation text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM agentonic.knowledge_collections c WHERE c.id=target AND c.workspace_id=agentonic.workspace_id()
 AND c.archived_at IS NULL AND agentonic.member_active(c.owner_member_id) AND agentonic.current_member() IS NOT NULL
 AND operation IN ('read','curate','share') AND (c.owner_member_id=agentonic.current_member() OR EXISTS(
 SELECT 1 FROM agentonic.collection_member_grants g WHERE g.workspace_id=c.workspace_id AND g.collection_id=c.id
 AND g.member_id=agentonic.current_member() AND g.revoked_at IS NULL AND g.granted_by_member_id=c.owner_member_id
 AND agentonic.member_active(g.granted_by_member_id) AND (operation='read' OR (operation='curate' AND g.permission='curate')))))
$$;
CREATE FUNCTION agentonic.can_contact_invoke(target_agent uuid,target_contact uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM agentonic.contacts c JOIN agentonic.agents a ON a.workspace_id=c.workspace_id AND a.id=target_agent
 WHERE c.id=target_contact AND c.workspace_id=agentonic.workspace_id() AND c.blocked_at IS NULL AND c.deleted_at IS NULL
 AND a.archived_at IS NULL AND a.status<>'archived' AND agentonic.member_active(a.owner_member_id)
 AND (c.linked_user_id IS NULL OR (c.linked_user_id=agentonic.actor_user_id() AND agentonic.can_agent(a.id,'invoke')))
 AND EXISTS(SELECT 1 FROM agentonic.agent_contact_grants g WHERE g.workspace_id=c.workspace_id AND g.agent_id=a.id AND g.contact_id=c.id
  AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())
  AND g.granted_by_member_id=a.owner_member_id AND agentonic.member_active(g.granted_by_member_id)
  AND g.allowed_capabilities @> '["invoke"]'::jsonb))
$$;
-- Unlinked contact checks are for the future trusted provider boundary; no runtime
-- role receives EXECUTE here. Customer services may check only their verified self.
CREATE FUNCTION agentonic.can_select_template(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT agentonic.current_member() IS NOT NULL AND EXISTS(SELECT 1 FROM agentonic.template_versions v
 JOIN agentonic.agent_templates t ON t.id=v.template_id JOIN agentonic.code_repositories r ON r.id=t.code_repository_id
 WHERE v.id=target AND t.deprecated_at IS NULL AND r.provisioning_status='ready'
 AND (r.visibility='platform' OR r.workspace_id=agentonic.workspace_id()))
$$;
CREATE FUNCTION agentonic.can_support(grant_id uuid, resource_kind text, target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM agentonic.support_access_grants g WHERE g.id=grant_id AND g.workspace_id=agentonic.workspace_id()
 AND g.staff_id=agentonic.current_staff() AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
 AND agentonic.member_active(g.approved_by_member_id) AND g.scope @> jsonb_build_object('version',1,'resources',jsonb_build_array(jsonb_build_object('type',resource_kind,'id',target::text,'operations',jsonb_build_array('read'))))
 AND (CASE resource_kind WHEN 'agent' THEN EXISTS(SELECT 1 FROM agentonic.agents a WHERE a.id=target AND a.workspace_id=g.workspace_id AND a.owner_member_id=g.approved_by_member_id AND a.archived_at IS NULL)
 WHEN 'collection' THEN EXISTS(SELECT 1 FROM agentonic.knowledge_collections c WHERE c.id=target AND c.workspace_id=g.workspace_id AND c.owner_member_id=g.approved_by_member_id AND c.archived_at IS NULL) ELSE false END))
$$;

CREATE FUNCTION agentonic.validate_access_rows() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE entry jsonb; old_json jsonb; new_json jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN
  old_json:=to_jsonb(OLD); new_json:=to_jsonb(NEW);
  IF new_json->'id' IS DISTINCT FROM old_json->'id' OR new_json->'workspace_id' IS DISTINCT FROM old_json->'workspace_id' OR new_json->'created_at' IS DISTINCT FROM old_json->'created_at' THEN
   RAISE EXCEPTION 'Resource identity is immutable';
  END IF;
  IF TG_TABLE_NAME IN ('audit_events','template_versions') THEN RAISE EXCEPTION 'Immutable history'; END IF;
  IF TG_TABLE_NAME='support_access_grants' AND (new_json-'revoked_at') IS DISTINCT FROM (old_json-'revoked_at') THEN RAISE EXCEPTION 'Support scope is immutable'; END IF;
  IF TG_TABLE_NAME='code_repositories' AND (new_json->'visibility' IS DISTINCT FROM old_json->'visibility' OR new_json->'repository_url' IS DISTINCT FROM old_json->'repository_url' OR new_json->'repository_subdirectory' IS DISTINCT FROM old_json->'repository_subdirectory') THEN RAISE EXCEPTION 'Repository identity is immutable'; END IF;
  IF TG_TABLE_NAME='agents' AND (new_json-ARRAY['name','description','status','updated_at','archived_at','owner_member_id']) IS DISTINCT FROM (old_json-ARRAY['name','description','status','updated_at','archived_at','owner_member_id']) THEN RAISE EXCEPTION 'Agent provenance is immutable'; END IF;
 END IF;
 IF TG_TABLE_NAME='audit_events' THEN
  IF NEW.actor_member_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agentonic.workspace_members WHERE id=NEW.actor_member_id AND workspace_id=NEW.workspace_id AND user_id=NEW.actor_user_id) THEN RAISE EXCEPTION 'Audit actor mismatch'; END IF;
  IF NEW.support_access_grant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agentonic.support_access_grants g JOIN agentonic.platform_staff s ON s.id=g.staff_id WHERE g.id=NEW.support_access_grant_id AND g.workspace_id=NEW.workspace_id AND s.user_id=NEW.actor_user_id) THEN RAISE EXCEPTION 'Audit support actor mismatch'; END IF;
 ELSIF TG_TABLE_NAME='agent_contact_grants' THEN
  IF jsonb_typeof(NEW.allowed_capabilities)<>'array' OR NOT NEW.allowed_capabilities <@ '["invoke"]'::jsonb THEN RAISE EXCEPTION 'Invalid contact capabilities'; END IF;
 ELSIF TG_TABLE_NAME='support_access_grants' AND TG_OP='INSERT' THEN
  IF jsonb_typeof(NEW.scope)<>'object' OR NEW.scope->>'version'<>'1' OR NOT NEW.scope ? 'version' OR
   (SELECT count(*) FROM jsonb_object_keys(NEW.scope))<>2 OR jsonb_typeof(NEW.scope->'resources') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid support scope'; END IF;
  IF jsonb_array_length(NEW.scope->'resources') NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid support scope'; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(NEW.scope->'resources') LOOP
   IF jsonb_typeof(entry)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(entry))<>3 OR entry->>'type' NOT IN ('agent','collection') OR
    entry->>'type' IS NULL OR entry->>'id' IS NULL OR entry->'operations' IS DISTINCT FROM '["read"]'::jsonb THEN RAISE EXCEPTION 'Invalid support resource'; END IF;
   IF NOT (CASE entry->>'type' WHEN 'agent' THEN EXISTS(SELECT 1 FROM agentonic.agents WHERE id=(entry->>'id')::uuid AND workspace_id=NEW.workspace_id AND owner_member_id=NEW.approved_by_member_id)
    WHEN 'collection' THEN EXISTS(SELECT 1 FROM agentonic.knowledge_collections WHERE id=(entry->>'id')::uuid AND workspace_id=NEW.workspace_id AND owner_member_id=NEW.approved_by_member_id) ELSE false END) THEN RAISE EXCEPTION 'Invalid support resource'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION agentonic.check_resource_owners() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE target uuid;
BEGIN
 target:=NEW.workspace_id;
 PERFORM 1 FROM agentonic.workspaces WHERE id=target FOR UPDATE;
 IF EXISTS(SELECT 1 FROM agentonic.agents a JOIN agentonic.workspace_members m ON m.id=a.owner_member_id
  JOIN agentonic.users u ON u.id=m.user_id WHERE a.workspace_id=target AND a.archived_at IS NULL AND a.status<>'archived'
  AND (m.status<>'active' OR m.removed_at IS NOT NULL OR u.deleted_at IS NOT NULL OR m.role='viewer')) OR
 EXISTS(SELECT 1 FROM agentonic.knowledge_collections c JOIN agentonic.workspace_members m ON m.id=c.owner_member_id
  JOIN agentonic.users u ON u.id=m.user_id WHERE c.workspace_id=target AND c.archived_at IS NULL
  AND (m.status<>'active' OR m.removed_at IS NOT NULL OR u.deleted_at IS NOT NULL OR m.role='viewer')) THEN
 RAISE EXCEPTION 'Transfer active resource ownership before offboarding or demotion'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER member_resource_owner AFTER INSERT OR UPDATE ON agentonic.workspace_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agentonic.check_resource_owners();
CREATE CONSTRAINT TRIGGER agent_resource_owner AFTER INSERT OR UPDATE ON agentonic.agents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agentonic.check_resource_owners();
CREATE CONSTRAINT TRIGGER collection_resource_owner AFTER INSERT OR UPDATE ON agentonic.knowledge_collections DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agentonic.check_resource_owners();

CREATE FUNCTION agentonic.revoke_member_access() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF (NEW.status<>'active' OR NEW.removed_at IS NOT NULL) AND OLD.status='active' AND OLD.removed_at IS NULL THEN
  UPDATE agentonic.agent_member_grants SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE workspace_id=NEW.workspace_id AND (member_id=NEW.id OR granted_by_member_id=NEW.id);
  UPDATE agentonic.collection_member_grants SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE workspace_id=NEW.workspace_id AND (member_id=NEW.id OR granted_by_member_id=NEW.id);
  UPDATE agentonic.support_access_grants SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE workspace_id=NEW.workspace_id AND approved_by_member_id=NEW.id;
  UPDATE agentonic.agent_contact_grants SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE workspace_id=NEW.workspace_id AND (granted_by_member_id=NEW.id OR contact_id IN (SELECT id FROM agentonic.contacts WHERE workspace_id=NEW.workspace_id AND linked_user_id=NEW.user_id));
  UPDATE agentonic.contacts SET blocked_at=coalesce(blocked_at,clock_timestamp()) WHERE workspace_id=NEW.workspace_id AND linked_user_id=NEW.user_id;
  UPDATE agentonic.workspace_invitations SET revoked_at=clock_timestamp() WHERE workspace_id=NEW.workspace_id AND invited_by_member_id=NEW.id AND accepted_at IS NULL AND revoked_at IS NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER revoke_member_access AFTER UPDATE ON agentonic.workspace_members FOR EACH ROW EXECUTE FUNCTION agentonic.revoke_member_access();

-- RLS is the read boundary. Writes are only through the small validated command
-- dispatcher below, which locks the workspace, derives actors and records audit.
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['workspace_invitations','support_access_grants','contacts','agent_contact_grants','code_repositories','agent_templates','template_versions','agents','agent_member_grants','knowledge_collections','collection_member_grants','audit_events'] LOOP
  EXECUTE format('ALTER TABLE agentonic.%I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('GRANT SELECT ON agentonic.%I TO agentonic_admin, agentonic_customer',table_name);
  EXECUTE format('CREATE TRIGGER validate_access_rows BEFORE INSERT OR UPDATE ON agentonic.%I FOR EACH ROW EXECUTE FUNCTION agentonic.validate_access_rows()',table_name);
 END LOOP;
END $$;
CREATE POLICY access ON agentonic.agents FOR SELECT TO agentonic_admin,agentonic_customer USING (agentonic.can_agent(id,'read'));
CREATE POLICY access ON agentonic.knowledge_collections FOR SELECT TO agentonic_admin,agentonic_customer USING (agentonic.can_collection(id,'read'));
CREATE POLICY access ON agentonic.agent_member_grants FOR SELECT TO agentonic_admin,agentonic_customer USING (workspace_id=agentonic.workspace_id() AND (agentonic.can_agent(agent_id,'share') OR (member_id=agentonic.current_member() AND agentonic.can_agent(agent_id,'read'))));
CREATE POLICY access ON agentonic.collection_member_grants FOR SELECT TO agentonic_admin,agentonic_customer USING (workspace_id=agentonic.workspace_id() AND (agentonic.can_collection(collection_id,'share') OR (member_id=agentonic.current_member() AND agentonic.can_collection(collection_id,'read'))));
CREATE POLICY access ON agentonic.contacts FOR SELECT TO agentonic_admin,agentonic_customer USING (workspace_id=agentonic.workspace_id() AND agentonic.current_member() IS NOT NULL AND (agentonic.workspace_manager() OR linked_user_id=agentonic.actor_user_id()));
CREATE POLICY access ON agentonic.agent_contact_grants FOR SELECT TO agentonic_admin,agentonic_customer USING (workspace_id=agentonic.workspace_id() AND agentonic.can_agent(agent_id,'share'));
CREATE POLICY access ON agentonic.support_access_grants FOR SELECT TO agentonic_admin,agentonic_customer USING (workspace_id=agentonic.workspace_id() AND approved_by_member_id=agentonic.current_member());
-- Invite hashes are credential material; never expose rows through ordinary SELECT.
CREATE POLICY deny ON agentonic.workspace_invitations FOR SELECT TO agentonic_admin,agentonic_customer USING (false);
CREATE POLICY access ON agentonic.code_repositories FOR SELECT TO agentonic_admin,agentonic_customer USING (agentonic.current_staff() IS NOT NULL OR (agentonic.current_member() IS NOT NULL AND provisioning_status='ready' AND (visibility='platform' OR workspace_id=agentonic.workspace_id())));
CREATE POLICY access ON agentonic.template_versions FOR SELECT TO agentonic_admin,agentonic_customer USING (agentonic.current_staff() IS NOT NULL OR agentonic.can_select_template(id));
CREATE POLICY access ON agentonic.agent_templates FOR SELECT TO agentonic_admin,agentonic_customer USING (agentonic.current_staff() IS NOT NULL OR EXISTS(SELECT 1 FROM agentonic.template_versions WHERE template_id=agent_templates.id AND agentonic.can_select_template(id)));
CREATE POLICY access ON agentonic.audit_events FOR SELECT TO agentonic_admin,agentonic_customer USING (workspace_id=agentonic.workspace_id() AND agentonic.current_member() IS NOT NULL AND (agentonic.workspace_manager() OR actor_user_id=agentonic.actor_user_id()));

CREATE FUNCTION agentonic.access_command(operation text, payload jsonb, trace_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_column
DECLARE
 w uuid:=agentonic.workspace_id(); actor uuid:=agentonic.actor_user_id(); member_id uuid; staff_id uuid;
 target uuid; related uuid; result_id uuid; grant_id uuid; approver uuid; chosen_role text; own_role text;
 result jsonb; details jsonb:='{}'::jsonb; expected_keys text[]; item jsonb; expiry timestamptz;
 target_member agentonic.workspace_members; successor agentonic.workspace_members; invitation agentonic.workspace_invitations;
 resource_kind text:='access'; resource_label text:='request';
BEGIN
 IF agentonic.application_role() NOT IN ('agentonic_admin','agentonic_customer') OR (actor IS NULL AND operation<>'invite.accept') OR agentonic.actor_id() IS NULL OR w IS NULL OR trace_id IS NULL THEN
  RAISE insufficient_privilege USING MESSAGE='Access denied';
 END IF;
 -- Serializes grants, offboarding, ownership and commands in a workspace. Live
 -- authorization is resolved AFTER the lock at READ COMMITTED isolation.
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
 member_id:=agentonic.current_member(); staff_id:=agentonic.current_staff();
 IF member_id IS NULL AND staff_id IS NULL AND operation<>'invite.accept' THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
 SELECT role INTO own_role FROM agentonic.workspace_members WHERE id=member_id;
 BEGIN
  expected_keys:=CASE operation
   WHEN 'member.list' THEN ARRAY[]::text[]
   WHEN 'invite.list' THEN ARRAY[]::text[]
   WHEN 'agent.create' THEN ARRAY['name','slug','description','ownerMemberId','templateVersionId']
   WHEN 'collection.create' THEN ARRAY['name','slug','description']
   WHEN 'agent.share' THEN ARRAY['agentId','memberId','role']
   WHEN 'collection.share' THEN ARRAY['collectionId','memberId','permission']
   WHEN 'agent.revoke' THEN ARRAY['agentId','memberId']
   WHEN 'collection.revoke' THEN ARRAY['collectionId','memberId']
   WHEN 'contact.ensure' THEN ARRAY[]::text[]
   WHEN 'contact.create' THEN ARRAY['displayName']
   WHEN 'contact.block' THEN ARRAY['contactId','blocked']
   WHEN 'contact.grant' THEN ARRAY['agentId','contactId','capabilities','expiresAt']
   WHEN 'contact.revoke' THEN ARRAY['agentId','contactId']
   WHEN 'support.approve' THEN ARRAY['staffId','reason','scope','expiresAt']
   WHEN 'support.revoke' THEN ARRAY['grantId']
   WHEN 'support.read' THEN ARRAY['grantId','resourceType','resourceId']
   WHEN 'member.update' THEN ARRAY['memberId','role','status','successorMemberId']
   WHEN 'invite.issue' THEN ARRAY['email','role','tokenHash','expiresAt']
   WHEN 'invite.accept' THEN ARRAY['tokenHash']
   WHEN 'invite.revoke' THEN ARRAY['invitationId']
   ELSE NULL END;
  IF expected_keys IS NULL OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(payload) k WHERE NOT k=ANY(expected_keys)) THEN
   RAISE insufficient_privilege USING MESSAGE='Access denied';
  END IF;
  IF operation IN ('member.list','invite.list') THEN
   IF NOT agentonic.workspace_manager() THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   IF operation='member.list' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'displayName',u.display_name,'role',m.role,'status',m.status) ORDER BY m.created_at,m.id),'[]'::jsonb) INTO result
    FROM agentonic.workspace_members m JOIN agentonic.users u ON u.id=m.user_id WHERE m.workspace_id=w;
   ELSE
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'email',email_normalized,'role',role,'expiresAt',expires_at,'acceptedAt',accepted_at,'revokedAt',revoked_at) ORDER BY created_at,id),'[]'::jsonb) INTO result
    FROM agentonic.workspace_invitations WHERE workspace_id=w;
   END IF;
   result_id:=w; resource_kind:='workspace';
  ELSIF operation='agent.create' THEN
   IF NOT agentonic.workspace_manager() THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   related:=(payload->>'templateVersionId')::uuid; target:=coalesce((payload->>'ownerMemberId')::uuid,member_id);
   IF NOT agentonic.can_select_template(related) OR NOT agentonic.member_active(target) OR EXISTS(SELECT 1 FROM agentonic.workspace_members WHERE id=target AND role='viewer') THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   INSERT INTO agentonic.agents(workspace_id,name,slug,description,owner_member_id,template_version_id,created_by_member_id)
    VALUES(w,payload->>'name',payload->>'slug',payload->>'description',target,related,member_id) RETURNING id INTO result_id;
   resource_kind:='agent';
  ELSIF operation='collection.create' THEN
   IF member_id IS NULL OR own_role='viewer' THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   INSERT INTO agentonic.knowledge_collections(workspace_id,name,slug,description,owner_member_id)
    VALUES(w,payload->>'name',payload->>'slug',payload->>'description',member_id) RETURNING id INTO result_id;
   resource_kind:='collection';
  ELSIF operation IN ('agent.share','agent.revoke','collection.share','collection.revoke') THEN
   target:=coalesce(payload->>'agentId',payload->>'collectionId')::uuid; related:=(payload->>'memberId')::uuid;
   IF operation LIKE 'agent.%' THEN
    IF NOT agentonic.can_agent(target,'share') THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
    resource_kind:='agent';
   ELSE
    IF NOT agentonic.can_collection(target,'share') THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
    resource_kind:='collection';
   END IF;
   IF NOT agentonic.member_active(related) THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   IF operation='agent.share' THEN
    INSERT INTO agentonic.agent_member_grants(workspace_id,agent_id,member_id,role,granted_by_member_id)
    VALUES(w,target,related,payload->>'role',member_id) ON CONFLICT(workspace_id,agent_id,member_id) DO UPDATE SET role=excluded.role,granted_by_member_id=excluded.granted_by_member_id,revoked_at=NULL;
   ELSIF operation='collection.share' THEN
    INSERT INTO agentonic.collection_member_grants(workspace_id,collection_id,member_id,permission,granted_by_member_id)
    VALUES(w,target,related,payload->>'permission',member_id) ON CONFLICT(workspace_id,collection_id,member_id) DO UPDATE SET permission=excluded.permission,granted_by_member_id=excluded.granted_by_member_id,revoked_at=NULL;
   ELSIF operation='agent.revoke' THEN
    UPDATE agentonic.agent_member_grants SET revoked_at=clock_timestamp() WHERE workspace_id=w AND agent_id=target AND agent_member_grants.member_id=related;
   ELSE
    UPDATE agentonic.collection_member_grants SET revoked_at=clock_timestamp() WHERE workspace_id=w AND collection_id=target AND collection_member_grants.member_id=related;
   END IF;
   details:=jsonb_strip_nulls(jsonb_build_object('memberId',related,'role',payload->>'role','permission',payload->>'permission'));
   result_id:=target;
  ELSIF operation='contact.ensure' THEN
   IF member_id IS NULL THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   INSERT INTO agentonic.contacts(workspace_id,display_name,linked_user_id,user_link_verified_at)
   SELECT w,left(display_name,120),actor,clock_timestamp() FROM agentonic.users WHERE id=actor
   ON CONFLICT(workspace_id,linked_user_id) DO UPDATE SET linked_user_id=excluded.linked_user_id RETURNING id INTO result_id;
   -- Never unblock a previously offboarded contact through re-linking.
   resource_kind:='contact';
  ELSIF operation='contact.create' THEN
   IF NOT agentonic.workspace_manager() THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   INSERT INTO agentonic.contacts(workspace_id,display_name) VALUES(w,payload->>'displayName') RETURNING id INTO result_id;
   resource_kind:='contact';
  ELSIF operation='contact.block' THEN
   IF NOT agentonic.workspace_manager() OR jsonb_typeof(payload->'blocked') IS DISTINCT FROM 'boolean' THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   UPDATE agentonic.contacts SET blocked_at=CASE WHEN (payload->>'blocked')::boolean THEN clock_timestamp() ELSE NULL END WHERE workspace_id=w AND id=(payload->>'contactId')::uuid RETURNING id INTO result_id;
   IF result_id IS NULL THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   UPDATE agentonic.agent_contact_grants SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE workspace_id=w AND contact_id=result_id AND (payload->>'blocked')::boolean;
   resource_kind:='contact';
  ELSIF operation IN ('contact.grant','contact.revoke') THEN
   target:=(payload->>'agentId')::uuid; related:=(payload->>'contactId')::uuid;
   IF NOT agentonic.can_agent(target,'share') OR NOT EXISTS(SELECT 1 FROM agentonic.contacts WHERE workspace_id=w AND id=related AND deleted_at IS NULL AND blocked_at IS NULL) THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   IF operation='contact.grant' THEN
    expiry:=(payload->>'expiresAt')::timestamptz;
    IF expiry IS NOT NULL AND expiry<=clock_timestamp() THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
    INSERT INTO agentonic.agent_contact_grants(workspace_id,agent_id,contact_id,allowed_capabilities,granted_by_member_id,expires_at)
    VALUES(w,target,related,payload->'capabilities',member_id,expiry) ON CONFLICT(workspace_id,agent_id,contact_id) DO UPDATE SET allowed_capabilities=excluded.allowed_capabilities,granted_by_member_id=excluded.granted_by_member_id,expires_at=excluded.expires_at,revoked_at=NULL;
   ELSE UPDATE agentonic.agent_contact_grants SET revoked_at=clock_timestamp() WHERE workspace_id=w AND agent_id=target AND contact_id=related; END IF;
   details:=jsonb_strip_nulls(jsonb_build_object('contactId',related,'capabilities',payload->'capabilities'));
   result_id:=target; resource_kind:='agent';
  ELSIF operation='support.approve' THEN
   IF member_id IS NULL THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   expiry:=(payload->>'expiresAt')::timestamptz;
   IF expiry IS NULL OR expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '7 days' OR NOT EXISTS(SELECT 1 FROM agentonic.platform_staff s JOIN agentonic.users u ON u.id=s.user_id WHERE s.id=(payload->>'staffId')::uuid AND s.disabled_at IS NULL AND s.role IN ('administrator','operator','support') AND u.deleted_at IS NULL) THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   INSERT INTO agentonic.support_access_grants(workspace_id,staff_id,approved_by_member_id,reason,scope,expires_at)
   VALUES(w,(payload->>'staffId')::uuid,member_id,payload->>'reason',payload->'scope',expiry) RETURNING id INTO result_id;
   resource_kind:='support_grant';
  ELSIF operation='support.revoke' THEN
   UPDATE agentonic.support_access_grants SET revoked_at=coalesce(revoked_at,clock_timestamp())
   WHERE workspace_id=w AND id=(payload->>'grantId')::uuid AND (approved_by_member_id=member_id OR agentonic.workspace_manager()) RETURNING id INTO result_id;
   IF result_id IS NULL THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   resource_kind:='support_grant';
  ELSIF operation='support.read' THEN
   grant_id:=(payload->>'grantId')::uuid; target:=(payload->>'resourceId')::uuid; resource_kind:=payload->>'resourceType';
   IF NOT agentonic.can_support(grant_id,resource_kind,target) THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   IF resource_kind='agent' THEN SELECT jsonb_build_object('id',id,'name',name,'description',description,'status',status) INTO result FROM agentonic.agents WHERE id=target AND workspace_id=w;
   ELSE SELECT jsonb_build_object('id',id,'name',name,'description',description) INTO result FROM agentonic.knowledge_collections WHERE id=target AND workspace_id=w; END IF;
   result_id:=target;
  ELSIF operation='member.update' THEN
   IF NOT agentonic.workspace_manager() THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   SELECT * INTO target_member FROM agentonic.workspace_members WHERE workspace_id=w AND id=(payload->>'memberId')::uuid;
   chosen_role:=payload->>'role';
   IF NOT FOUND OR target_member.status='removed' OR chosen_role IS NULL OR payload->>'status' IS NULL OR (own_role='admin' AND (target_member.role IN ('owner','admin') OR chosen_role IN ('owner','admin'))) THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   IF payload->>'successorMemberId' IS NOT NULL THEN
    IF own_role<>'owner' OR (payload->>'status'='active' AND chosen_role<>'viewer') THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
    SELECT * INTO successor FROM agentonic.workspace_members WHERE workspace_id=w AND id=(payload->>'successorMemberId')::uuid;
    IF NOT FOUND OR successor.id=target_member.id OR NOT agentonic.member_active(successor.id) OR successor.role='viewer' THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
    -- Transferring an owner never revives the previous owner's grants.
    UPDATE agentonic.agent_member_grants SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE workspace_id=w AND agent_id IN (SELECT id FROM agentonic.agents WHERE workspace_id=w AND owner_member_id=target_member.id);
    UPDATE agentonic.agent_contact_grants SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE workspace_id=w AND agent_id IN (SELECT id FROM agentonic.agents WHERE workspace_id=w AND owner_member_id=target_member.id);
    UPDATE agentonic.collection_member_grants SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE workspace_id=w AND collection_id IN (SELECT id FROM agentonic.knowledge_collections WHERE workspace_id=w AND owner_member_id=target_member.id);
    UPDATE agentonic.support_access_grants SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE workspace_id=w AND approved_by_member_id=target_member.id;
    UPDATE agentonic.agents SET owner_member_id=successor.id,updated_at=clock_timestamp() WHERE workspace_id=w AND owner_member_id=target_member.id;
    UPDATE agentonic.knowledge_collections SET owner_member_id=successor.id WHERE workspace_id=w AND owner_member_id=target_member.id;
   END IF;
   UPDATE agentonic.workspace_members SET role=chosen_role,status=payload->>'status',removed_at=CASE WHEN payload->>'status'='removed' THEN clock_timestamp() ELSE NULL END WHERE id=target_member.id;
   -- Evaluate deferred invariants inside this atomic command, before returning success.
   PERFORM agentonic.assert_owners(w);
   details:=jsonb_strip_nulls(jsonb_build_object('previousRole',target_member.role,'previousStatus',target_member.status,'role',chosen_role,'status',payload->>'status','successorMemberId',payload->>'successorMemberId'));
   result_id:=target_member.id; resource_kind:='member';
  ELSIF operation='invite.issue' THEN
   chosen_role:=payload->>'role'; expiry:=(payload->>'expiresAt')::timestamptz;
   IF NOT agentonic.workspace_manager() OR (chosen_role='admin' AND own_role<>'owner') OR expiry IS NULL OR expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '7 days' OR EXISTS(SELECT 1 FROM agentonic.workspaces WHERE id=w AND kind='personal') THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   UPDATE agentonic.workspace_invitations SET revoked_at=clock_timestamp() WHERE workspace_id=w AND email_normalized=lower(btrim(payload->>'email')) AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at<=clock_timestamp();
   INSERT INTO agentonic.workspace_invitations(workspace_id,email_normalized,role,token_hash,invited_by_member_id,expires_at)
   VALUES(w,lower(btrim(payload->>'email')),chosen_role,payload->>'tokenHash',member_id,expiry) RETURNING id INTO result_id;
   resource_kind:='invitation';
  ELSIF operation='invite.accept' THEN
   IF agentonic.application_role()<>'agentonic_customer' THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   IF EXISTS(SELECT 1 FROM agentonic.users WHERE auth_user_id=agentonic.actor_id() AND deleted_at IS NOT NULL) THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   SELECT * INTO invitation FROM agentonic.workspace_invitations WHERE workspace_id=w AND token_hash=payload->>'tokenHash' FOR UPDATE;
   IF NOT FOUND OR invitation.accepted_at IS NOT NULL OR invitation.revoked_at IS NOT NULL OR invitation.expires_at<=clock_timestamp() OR
    invitation.email_normalized IS DISTINCT FROM nullif(lower(btrim(current_setting('agentonic.verified_email',true))),'') OR
    NOT agentonic.member_active(invitation.invited_by_member_id) OR NOT EXISTS(SELECT 1 FROM agentonic.workspace_members WHERE id=invitation.invited_by_member_id AND role IN ('owner','admin') AND (invitation.role<>'admin' OR role='owner')) OR
    EXISTS(SELECT 1 FROM agentonic.workspace_members WHERE workspace_id=w AND user_id=actor AND status='active') THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   IF actor IS NULL THEN
    INSERT INTO agentonic.users(auth_user_id,display_name) VALUES(agentonic.actor_id(),'Miembro')
    ON CONFLICT(auth_user_id) DO NOTHING;
    actor:=agentonic.actor_user_id();
    IF actor IS NULL THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   END IF;
   INSERT INTO agentonic.workspace_members(workspace_id,user_id,role) VALUES(w,actor,invitation.role)
    ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role,status='active',removed_at=NULL,joined_at=clock_timestamp() RETURNING id INTO member_id;
   UPDATE agentonic.workspace_invitations SET accepted_at=clock_timestamp() WHERE id=invitation.id;
   result_id:=invitation.id; resource_kind:='invitation';
  ELSIF operation='invite.revoke' THEN
   IF NOT agentonic.workspace_manager() THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   UPDATE agentonic.workspace_invitations SET revoked_at=clock_timestamp() WHERE workspace_id=w AND id=(payload->>'invitationId')::uuid AND accepted_at IS NULL AND revoked_at IS NULL AND (role<>'admin' OR own_role='owner') RETURNING id INTO result_id;
   IF result_id IS NULL THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   resource_kind:='invitation';
  END IF;
  resource_label:=coalesce(result_id::text,'request');
  INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,support_access_grant_id,action,resource_type,resource_id,outcome,request_id,redacted_details)
   VALUES(w,actor,member_id,CASE WHEN operation='support.read' THEN grant_id ELSE NULL END,operation,resource_kind,resource_label,'succeeded',trace_id::text,details);
  RETURN jsonb_build_object('ok',true,'id',result_id,'data',result);
 EXCEPTION WHEN insufficient_privilege THEN
  -- The subtransaction rolls back any partial writes before this safe denial event.
  -- Never persist arbitrary payloads, emails, tokens, names or private content.
  IF member_id IS NOT NULL OR staff_id IS NOT NULL THEN
   INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,action,resource_type,resource_id,outcome,request_id)
    VALUES(w,actor,member_id,'access.denied','access','request','denied',trace_id::text);
  END IF;
  RETURN jsonb_build_object('ok',false);
 END;
END $$;

-- Shared invariant invoked explicitly before a member command returns and backed
-- by deferred triggers for all migrations/maintenance paths.
CREATE FUNCTION agentonic.assert_owners(target uuid) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM agentonic.workspace_members m JOIN agentonic.users u ON u.id=m.user_id WHERE m.workspace_id=target AND m.role='owner' AND m.status='active' AND m.removed_at IS NULL AND u.deleted_at IS NULL) OR
 EXISTS(SELECT 1 FROM agentonic.agents a JOIN agentonic.workspace_members m ON m.id=a.owner_member_id WHERE a.workspace_id=target AND a.archived_at IS NULL AND (m.status<>'active' OR m.removed_at IS NOT NULL OR m.role='viewer')) OR
 EXISTS(SELECT 1 FROM agentonic.knowledge_collections c JOIN agentonic.workspace_members m ON m.id=c.owner_member_id WHERE c.workspace_id=target AND c.archived_at IS NULL AND (m.status<>'active' OR m.removed_at IS NOT NULL OR m.role='viewer')) THEN
 RAISE insufficient_privilege USING MESSAGE='Ownership transfer required'; END IF;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA agentonic FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION agentonic.application_role(),agentonic.current_member(),agentonic.member_active(uuid),agentonic.workspace_manager(),agentonic.current_staff(),agentonic.can_agent(uuid,text),agentonic.can_collection(uuid,text),agentonic.can_select_template(uuid) TO agentonic_admin,agentonic_customer;
GRANT EXECUTE ON FUNCTION agentonic.access_command(text,jsonb,uuid) TO agentonic_admin,agentonic_customer;
-- No direct INSERT, UPDATE, DELETE, TRUNCATE, owner-function or worker privileges.
COMMIT;
