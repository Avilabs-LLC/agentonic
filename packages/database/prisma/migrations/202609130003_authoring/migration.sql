-- Customer artifacts and bounded staff review.

BEGIN;

CREATE TABLE agentonic.code_releases (
 id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 version text NOT NULL,
 template_version_id uuid NOT NULL,
 git_commit_sha text NOT NULL,
 artifact_sha256 text NOT NULL,
 registry_sha256 text NOT NULL,
 runtime_contract_version text NOT NULL,
 retired_at timestamptz,
 code_repository_id uuid NOT NULL,
 artifact_bucket text NOT NULL,
 artifact_key text NOT NULL,
 artifact_size_bytes bigint NOT NULL CHECK (artifact_size_bytes > 0),
 published_by_staff_id uuid NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (code_repository_id, version),
 UNIQUE (artifact_bucket, artifact_key)
);

CREATE TABLE agentonic.workspace_code_release_grants (
 id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,
 code_release_id uuid NOT NULL,
 granted_by_staff_id uuid NOT NULL,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (workspace_id, id),
 UNIQUE (workspace_id, code_release_id)
);

CREATE TABLE agentonic.code_tools (
 id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 code_release_id uuid NOT NULL,
 package_key text NOT NULL,
 name text NOT NULL,
 implementation_path text NOT NULL,
 input_schema jsonb NOT NULL,
 read_only boolean NOT NULL,
 requires_confirmation boolean NOT NULL,
 standing_authorization_allowed boolean NOT NULL DEFAULT false,
 expose_over_http boolean NOT NULL,
 policy_contract jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (code_release_id, id),
 UNIQUE (code_release_id, package_key, name),
 CHECK (NOT expose_over_http OR (read_only AND NOT requires_confirmation))
);

CREATE TABLE agentonic.configuration_drafts (
 id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,
 agent_id uuid NOT NULL,
 base_configuration_release_id uuid,
 title text NOT NULL,
 revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
 content jsonb NOT NULL,
 created_by_member_id uuid,
 proposed_by_run_id uuid,
 updated_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'archived')),
 requested_access jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_by_staff_id uuid,
 support_access_grant_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (workspace_id, id),
 UNIQUE (workspace_id, agent_id, id),
 CHECK (num_nonnulls(created_by_member_id, created_by_staff_id, proposed_by_run_id) = 1),
 CHECK (support_access_grant_id IS NULL OR created_by_staff_id IS NOT NULL),
 CHECK (created_by_staff_id IS NULL OR support_access_grant_id IS NOT NULL)
);

CREATE TABLE agentonic.configuration_releases (
 id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,
 agent_id uuid NOT NULL,
 code_release_id uuid NOT NULL,
 source_draft_id uuid NOT NULL,
 source_draft_revision bigint NOT NULL CHECK (source_draft_revision > 0),
 version text NOT NULL,
 content jsonb NOT NULL,
 content_sha256 text NOT NULL,
 composed_prompt_sha256 text NOT NULL,
 asset_manifest_sha256 text NOT NULL,
 retired_at timestamptz,
 frozen_by_member_id uuid,
 frozen_by_staff_id uuid,
 support_access_grant_id uuid,
 requested_access_snapshot jsonb NOT NULL,
 requested_access_sha256 text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (workspace_id, id),
 UNIQUE (workspace_id, agent_id, id),
 UNIQUE (workspace_id, agent_id, code_release_id, id),
 UNIQUE (workspace_id, agent_id, version),
 CHECK (num_nonnulls(frozen_by_member_id, frozen_by_staff_id) = 1),
 CHECK (support_access_grant_id IS NULL OR frozen_by_staff_id IS NOT NULL),
 CHECK (frozen_by_staff_id IS NULL OR support_access_grant_id IS NOT NULL)
);

CREATE TABLE agentonic.configuration_tools (
 id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,
 agent_id uuid NOT NULL,
 code_release_id uuid NOT NULL,
 configuration_release_id uuid NOT NULL,
 code_tool_id uuid NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 effective_policy jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (workspace_id, id),
 UNIQUE (workspace_id, configuration_release_id, code_tool_id),
 CONSTRAINT configuration_tools_candidate_key UNIQUE (workspace_id, agent_id, code_release_id, configuration_release_id, id),
 CONSTRAINT configuration_tools_candidate_tool_key UNIQUE (workspace_id, agent_id, code_release_id, configuration_release_id, code_tool_id, id)
);

CREATE TABLE agentonic.agent_submissions (
 id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,
 agent_id uuid NOT NULL,
 code_release_id uuid NOT NULL,
 configuration_release_id uuid NOT NULL,
 submission_number bigint NOT NULL CHECK (submission_number > 0),
 submitted_by_member_id uuid,
 submitted_by_staff_id uuid,
 support_access_grant_id uuid,
 customer_note text,
 review_consent jsonb NOT NULL,
 status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'in_review', 'changes_requested', 'approved', 'rejected', 'withdrawn', 'revoked')),
 submitted_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (workspace_id, id),
 UNIQUE (workspace_id, agent_id, submission_number),
 CONSTRAINT agent_submissions_candidate_key UNIQUE (workspace_id, agent_id, code_release_id, configuration_release_id, id),
 UNIQUE (workspace_id, agent_id, id),
 CHECK (num_nonnulls(submitted_by_member_id, submitted_by_staff_id) = 1),
 CHECK (support_access_grant_id IS NULL OR submitted_by_staff_id IS NOT NULL),
 CHECK (submitted_by_staff_id IS NULL OR support_access_grant_id IS NOT NULL)
);

CREATE TABLE agentonic.submission_review_decisions (
 id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,
 agent_id uuid NOT NULL,
 submission_id uuid NOT NULL,
 decision_number bigint NOT NULL CHECK (decision_number > 0),
 decision text NOT NULL CHECK (decision IN ('in_review', 'changes_requested', 'approved', 'rejected', 'withdrawn', 'revoked')),
 actor_member_id uuid,
 actor_staff_id uuid,
 support_access_grant_id uuid,
 feedback text,
 approval_expires_at timestamptz,
 approved_access_sha256 text,
 assessment_snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (workspace_id, id),
 UNIQUE (workspace_id, submission_id, decision_number),
 UNIQUE (workspace_id, agent_id, id),
 UNIQUE (workspace_id, agent_id, submission_id, decision, id),
 UNIQUE (workspace_id, agent_id, decision, id),
 CHECK (num_nonnulls(actor_member_id, actor_staff_id) = 1),
 CHECK (actor_member_id IS NULL OR decision = 'withdrawn'),
 CHECK (decision <> 'approved' OR (approval_expires_at IS NOT NULL AND approved_access_sha256 IS NOT NULL)),
 CHECK (approval_expires_at IS NULL OR approval_expires_at > created_at),
 CHECK (support_access_grant_id IS NULL OR actor_staff_id IS NOT NULL),
 CHECK (actor_staff_id IS NULL OR support_access_grant_id IS NOT NULL)
);

CREATE TABLE agentonic.stored_objects (
 id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,
 provider text NOT NULL CHECK (provider IN ('supabase_storage', 'azure_blob')),
 bucket text NOT NULL,
 object_key text NOT NULL,
 content_sha256 text NOT NULL,
 content_type text NOT NULL,
 size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
 classification text NOT NULL DEFAULT 'confidential' CHECK (classification IN ('internal', 'confidential', 'restricted')),
 expires_at timestamptz,
 deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (workspace_id, id),
 UNIQUE (provider, bucket, object_key)
);

CREATE TABLE agentonic.knowledge_sources (
 id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,
 collection_id uuid NOT NULL,
 connection_id uuid,
 kind text NOT NULL,
 locator text NOT NULL,
 configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
 authorized_by_member_id uuid NOT NULL,
 sync_cursor jsonb,
 sync_interval_seconds integer CHECK (sync_interval_seconds > 0),
 last_success_at timestamptz,
 access_mode text NOT NULL DEFAULT 'collection' CHECK (access_mode IN ('collection', 'source_acl')),
 enabled boolean NOT NULL DEFAULT false,
 environment text NOT NULL CHECK (environment IN ('development', 'staging', 'production')),
 definition_revision bigint NOT NULL DEFAULT 1 CHECK (definition_revision > 0),
 definition_sha256 text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (workspace_id, id),
 UNIQUE (workspace_id, collection_id, kind, locator)
);

CREATE TABLE agentonic.documents (
 id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,
 source_id uuid NOT NULL,
 external_document_id text NOT NULL,
 title text NOT NULL,
 source_url text,
 active_version_id uuid,
 acl_valid_until timestamptz,
 source_modified_at timestamptz,
 deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (workspace_id, id),
 UNIQUE (workspace_id, source_id, external_document_id)
);

CREATE TABLE agentonic.document_versions (
 id uuid NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,
 document_id uuid NOT NULL,
 version_key text NOT NULL,
 content_sha256 text NOT NULL,
 object_id uuid,
 parser_version text NOT NULL,
 chunker_version text NOT NULL,
 language text NOT NULL DEFAULT 'und',
 status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (workspace_id, id),
 UNIQUE (workspace_id, document_id, version_key),
 UNIQUE (workspace_id, document_id, id)
);

ALTER TABLE agentonic.stored_objects ADD CONSTRAINT stored_objects_workspace_id_step3_fk FOREIGN KEY (workspace_id) REFERENCES agentonic.workspaces (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.knowledge_sources ADD CONSTRAINT knowledge_sources_workspace_id_step3_fk FOREIGN KEY (workspace_id) REFERENCES agentonic.workspaces (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.knowledge_sources ADD CONSTRAINT knowledge_sources_workspace_id_collection_id_step3_fk FOREIGN KEY (workspace_id, collection_id) REFERENCES agentonic.knowledge_collections (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.knowledge_sources ADD CONSTRAINT knowledge_sources_workspace_id_authorized_by_member__7529269f FOREIGN KEY (workspace_id, authorized_by_member_id) REFERENCES agentonic.workspace_members (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.documents ADD CONSTRAINT documents_workspace_id_step3_fk FOREIGN KEY (workspace_id) REFERENCES agentonic.workspaces (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.documents ADD CONSTRAINT documents_workspace_id_source_id_step3_fk FOREIGN KEY (workspace_id, source_id) REFERENCES agentonic.knowledge_sources (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.documents ADD CONSTRAINT documents_workspace_id_id_active_version_id_step3_fk FOREIGN KEY (workspace_id, id, active_version_id) REFERENCES agentonic.document_versions (workspace_id, document_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.document_versions ADD CONSTRAINT document_versions_workspace_id_step3_fk FOREIGN KEY (workspace_id) REFERENCES agentonic.workspaces (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.document_versions ADD CONSTRAINT document_versions_workspace_id_document_id_step3_fk FOREIGN KEY (workspace_id, document_id) REFERENCES agentonic.documents (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.document_versions ADD CONSTRAINT document_versions_workspace_id_object_id_step3_fk FOREIGN KEY (workspace_id, object_id) REFERENCES agentonic.stored_objects (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.configuration_drafts ADD CONSTRAINT configuration_drafts_workspace_id_step3_fk FOREIGN KEY (workspace_id) REFERENCES agentonic.workspaces (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.configuration_drafts ADD CONSTRAINT configuration_drafts_workspace_id_agent_id_step3_fk FOREIGN KEY (workspace_id, agent_id) REFERENCES agentonic.agents (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.configuration_drafts ADD CONSTRAINT configuration_drafts_workspace_id_created_by_member__7ce4692d FOREIGN KEY (workspace_id, created_by_member_id) REFERENCES agentonic.workspace_members (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.configuration_releases ADD CONSTRAINT configuration_releases_workspace_id_step3_fk FOREIGN KEY (workspace_id) REFERENCES agentonic.workspaces (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.configuration_releases ADD CONSTRAINT configuration_releases_workspace_id_code_release_id_step3_fk FOREIGN KEY (workspace_id, code_release_id) REFERENCES agentonic.workspace_code_release_grants (workspace_id, code_release_id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.configuration_releases ADD CONSTRAINT configuration_releases_workspace_id_agent_id_source__6866e502 FOREIGN KEY (workspace_id, agent_id, source_draft_id) REFERENCES agentonic.configuration_drafts (workspace_id, agent_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.configuration_drafts ADD CONSTRAINT configuration_drafts_workspace_id_agent_id_base_conf_16f9ef1f FOREIGN KEY (workspace_id, agent_id, base_configuration_release_id) REFERENCES agentonic.configuration_releases (workspace_id, agent_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.configuration_tools ADD CONSTRAINT configuration_tools_workspace_id_step3_fk FOREIGN KEY (workspace_id) REFERENCES agentonic.workspaces (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.configuration_tools ADD CONSTRAINT configuration_tools_workspace_id_agent_id_code_relea_be30e344 FOREIGN KEY (workspace_id, agent_id, code_release_id, configuration_release_id) REFERENCES agentonic.configuration_releases (workspace_id, agent_id, code_release_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.configuration_tools ADD CONSTRAINT configuration_tools_code_release_id_code_tool_id_step3_fk FOREIGN KEY (code_release_id, code_tool_id) REFERENCES agentonic.code_tools (code_release_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.code_releases ADD CONSTRAINT code_releases_code_repository_id_step3_fk FOREIGN KEY (code_repository_id) REFERENCES agentonic.code_repositories (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.code_releases ADD CONSTRAINT code_releases_template_version_id_step3_fk FOREIGN KEY (template_version_id) REFERENCES agentonic.template_versions (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.code_releases ADD CONSTRAINT code_releases_published_by_staff_id_step3_fk FOREIGN KEY (published_by_staff_id) REFERENCES agentonic.platform_staff (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.code_tools ADD CONSTRAINT code_tools_code_release_id_step3_fk FOREIGN KEY (code_release_id) REFERENCES agentonic.code_releases (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.workspace_code_release_grants ADD CONSTRAINT workspace_code_release_grants_workspace_id_step3_fk FOREIGN KEY (workspace_id) REFERENCES agentonic.workspaces (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.workspace_code_release_grants ADD CONSTRAINT workspace_code_release_grants_code_release_id_step3_fk FOREIGN KEY (code_release_id) REFERENCES agentonic.code_releases (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.workspace_code_release_grants ADD CONSTRAINT workspace_code_release_grants_granted_by_staff_id_step3_fk FOREIGN KEY (granted_by_staff_id) REFERENCES agentonic.platform_staff (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.configuration_drafts ADD CONSTRAINT configuration_drafts_created_by_staff_id_step3_fk FOREIGN KEY (created_by_staff_id) REFERENCES agentonic.platform_staff (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.configuration_drafts ADD CONSTRAINT configuration_drafts_workspace_id_created_by_staff_i_cadd8fb4 FOREIGN KEY (workspace_id, created_by_staff_id, support_access_grant_id) REFERENCES agentonic.support_access_grants (workspace_id, staff_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.configuration_releases ADD CONSTRAINT configuration_releases_workspace_id_frozen_by_member_9d625951 FOREIGN KEY (workspace_id, frozen_by_member_id) REFERENCES agentonic.workspace_members (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.configuration_releases ADD CONSTRAINT configuration_releases_frozen_by_staff_id_step3_fk FOREIGN KEY (frozen_by_staff_id) REFERENCES agentonic.platform_staff (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.configuration_releases ADD CONSTRAINT configuration_releases_workspace_id_frozen_by_staff__718ad3be FOREIGN KEY (workspace_id, frozen_by_staff_id, support_access_grant_id) REFERENCES agentonic.support_access_grants (workspace_id, staff_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.agent_submissions ADD CONSTRAINT agent_submissions_workspace_id_step3_fk FOREIGN KEY (workspace_id) REFERENCES agentonic.workspaces (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.agent_submissions ADD CONSTRAINT agent_submissions_workspace_id_agent_id_code_release_cfab25eb FOREIGN KEY (workspace_id, agent_id, code_release_id, configuration_release_id) REFERENCES agentonic.configuration_releases (workspace_id, agent_id, code_release_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.agent_submissions ADD CONSTRAINT agent_submissions_workspace_id_submitted_by_member_id_step3_fk FOREIGN KEY (workspace_id, submitted_by_member_id) REFERENCES agentonic.workspace_members (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.agent_submissions ADD CONSTRAINT agent_submissions_submitted_by_staff_id_step3_fk FOREIGN KEY (submitted_by_staff_id) REFERENCES agentonic.platform_staff (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.agent_submissions ADD CONSTRAINT agent_submissions_workspace_id_submitted_by_staff_id_5a15597d FOREIGN KEY (workspace_id, submitted_by_staff_id, support_access_grant_id) REFERENCES agentonic.support_access_grants (workspace_id, staff_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.submission_review_decisions ADD CONSTRAINT submission_review_decisions_workspace_id_step3_fk FOREIGN KEY (workspace_id) REFERENCES agentonic.workspaces (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.submission_review_decisions ADD CONSTRAINT submission_review_decisions_workspace_id_agent_id_su_0408b1d8 FOREIGN KEY (workspace_id, agent_id, submission_id) REFERENCES agentonic.agent_submissions (workspace_id, agent_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.submission_review_decisions ADD CONSTRAINT submission_review_decisions_workspace_id_actor_membe_45b36ba1 FOREIGN KEY (workspace_id, actor_member_id) REFERENCES agentonic.workspace_members (workspace_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.submission_review_decisions ADD CONSTRAINT submission_review_decisions_actor_staff_id_step3_fk FOREIGN KEY (actor_staff_id) REFERENCES agentonic.platform_staff (id) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE agentonic.submission_review_decisions ADD CONSTRAINT submission_review_decisions_workspace_id_actor_staff_22bfe57e FOREIGN KEY (workspace_id, actor_staff_id, support_access_grant_id) REFERENCES agentonic.support_access_grants (workspace_id, staff_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Close all future runtime/connector actors and operations before exposing authoring.
ALTER TABLE agentonic.configuration_drafts ADD CHECK (created_by_member_id IS NOT NULL AND proposed_by_run_id IS NULL AND created_by_staff_id IS NULL AND support_access_grant_id IS NULL);
ALTER TABLE agentonic.configuration_releases ADD CHECK (frozen_by_member_id IS NOT NULL AND frozen_by_staff_id IS NULL AND support_access_grant_id IS NULL);
ALTER TABLE agentonic.agent_submissions ADD CHECK (submitted_by_member_id IS NOT NULL AND submitted_by_staff_id IS NULL AND support_access_grant_id IS NULL);
ALTER TABLE agentonic.knowledge_sources ADD CHECK (connection_id IS NULL AND kind='upload' AND environment='staging' AND access_mode='collection' AND NOT enabled AND sync_cursor IS NULL AND sync_interval_seconds IS NULL);
ALTER TABLE agentonic.documents ADD CHECK (active_version_id IS NULL AND source_url IS NULL AND acl_valid_until IS NULL);
ALTER TABLE agentonic.document_versions ADD CHECK (status IN ('processing','failed') AND parser_version='pending' AND chunker_version='pending');
ALTER TABLE agentonic.submission_review_decisions ADD CHECK (decision IN ('in_review','changes_requested','rejected','withdrawn') AND approval_expires_at IS NULL AND approved_access_sha256 IS NULL);
CREATE UNIQUE INDEX configuration_drafts_active ON agentonic.configuration_drafts(workspace_id,agent_id) WHERE status='draft';
CREATE UNIQUE INDEX configuration_releases_revision ON agentonic.configuration_releases(workspace_id,source_draft_id,source_draft_revision,code_release_id);
CREATE UNIQUE INDEX agent_submissions_candidate ON agentonic.agent_submissions(workspace_id,configuration_release_id);
ALTER TABLE agentonic.stored_objects ADD CHECK (provider='supabase_storage' AND bucket='agentonic-documents' AND size_bytes BETWEEN 1 AND 10485760 AND content_sha256 ~ '^[a-f0-9]{64}$' AND content_type IN ('application/pdf','text/plain','text/markdown') AND object_key=workspace_id::text||'/'||id::text);
ALTER TABLE agentonic.code_releases ADD CHECK (git_commit_sha ~ '^[a-f0-9]{40}$' AND artifact_sha256 ~ '^[a-f0-9]{64}$' AND registry_sha256 ~ '^[a-f0-9]{64}$');

CREATE FUNCTION agentonic.content_hash(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$ SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex') $$;
CREATE FUNCTION agentonic.member_can_author(m uuid,a uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM agentonic.agents a1 JOIN agentonic.workspace_members own ON own.id=a1.owner_member_id
 JOIN agentonic.users ou ON ou.id=own.user_id JOIN agentonic.workspace_members m1 ON m1.id=m AND m1.workspace_id=a1.workspace_id
 JOIN agentonic.users u ON u.id=m1.user_id JOIN agentonic.workspaces w ON w.id=a1.workspace_id
 WHERE a1.id=a AND a1.archived_at IS NULL AND own.status='active' AND own.removed_at IS NULL AND ou.deleted_at IS NULL
 AND m1.status='active' AND m1.removed_at IS NULL AND u.deleted_at IS NULL AND w.status='active' AND w.deleted_at IS NULL
 AND (a1.owner_member_id=m OR EXISTS(SELECT 1 FROM agentonic.agent_member_grants g WHERE g.agent_id=a AND g.member_id=m AND g.role='maintainer' AND g.revoked_at IS NULL AND g.granted_by_member_id=a1.owner_member_id)))
$$;
CREATE FUNCTION agentonic.member_can_collection(m uuid,c uuid,op text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM agentonic.knowledge_collections c1 JOIN agentonic.workspace_members own ON own.id=c1.owner_member_id
 JOIN agentonic.users ou ON ou.id=own.user_id JOIN agentonic.workspace_members m1 ON m1.id=m AND m1.workspace_id=c1.workspace_id
 JOIN agentonic.users u ON u.id=m1.user_id JOIN agentonic.workspaces w ON w.id=c1.workspace_id
 WHERE c1.id=c AND c1.archived_at IS NULL AND own.status='active' AND own.removed_at IS NULL AND ou.deleted_at IS NULL
 AND m1.status='active' AND m1.removed_at IS NULL AND u.deleted_at IS NULL AND w.status='active' AND w.deleted_at IS NULL AND op IN ('read','curate')
 AND (c1.owner_member_id=m OR EXISTS(SELECT 1 FROM agentonic.collection_member_grants g WHERE g.collection_id=c AND g.member_id=m AND g.revoked_at IS NULL AND g.granted_by_member_id=c1.owner_member_id AND (op='read' OR g.permission='curate'))))
$$;
CREATE FUNCTION agentonic.can_use_code(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT agentonic.current_member() IS NOT NULL AND EXISTS(SELECT 1 FROM agentonic.code_releases c
 JOIN agentonic.code_repositories r ON r.id=c.code_repository_id JOIN agentonic.template_versions v ON v.id=c.template_version_id JOIN agentonic.agent_templates t ON t.id=v.template_id
 JOIN agentonic.workspace_code_release_grants g ON g.code_release_id=c.id AND g.workspace_id=agentonic.workspace_id()
 WHERE c.id=target AND c.retired_at IS NULL AND c.revoked_at IS NULL AND r.provisioning_status='ready' AND t.deprecated_at IS NULL
 AND g.revoked_at IS NULL AND (r.visibility='platform' OR r.workspace_id=g.workspace_id) AND t.code_repository_id=r.id)
$$;
CREATE OR REPLACE FUNCTION agentonic.can_select_template(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE template_version_id=target AND agentonic.can_use_code(id))
$$;
CREATE FUNCTION agentonic.valid_draft(content jsonb,requested jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE item jsonb;
BEGIN
 IF jsonb_typeof(content) IS DISTINCT FROM 'object' OR (content-ARRAY['version','systemPrompt','skills'])<>'{}'::jsonb OR content->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(content->'systemPrompt') IS DISTINCT FROM 'string' OR length(content->>'systemPrompt')>32000 OR jsonb_typeof(content->'skills') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(content->'skills')>20 THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(content->'skills') LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR (item-ARRAY['name','instructions'])<>'{}'::jsonb OR jsonb_typeof(item->'name') IS DISTINCT FROM 'string' OR (item->>'name') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(item->>'name')>80 OR jsonb_typeof(item->'instructions') IS DISTINCT FROM 'string' OR length(btrim(item->>'instructions')) NOT BETWEEN 1 AND 16000 THEN RETURN false; END IF;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_array_elements(content->'skills'))<>(SELECT count(DISTINCT x->>'name') FROM jsonb_array_elements(content->'skills') x) THEN RETURN false; END IF;
 IF jsonb_typeof(requested) IS DISTINCT FROM 'object' OR (requested-ARRAY['version','collectionIds','tools'])<>'{}'::jsonb OR requested->'version' IS DISTINCT FROM '1'::jsonb OR requested->'tools' IS DISTINCT FROM '[]'::jsonb OR jsonb_typeof(requested->'collectionIds') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(requested->'collectionIds')>20 THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(requested->'collectionIds') LOOP
  IF jsonb_typeof(item)<>'string' OR (item#>>'{}') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF;
 END LOOP;
 RETURN (SELECT count(*)=count(DISTINCT value) FROM jsonb_array_elements(requested->'collectionIds'));
END $$;
ALTER TABLE agentonic.configuration_drafts ADD CHECK (agentonic.valid_draft(content,requested_access));
CREATE FUNCTION agentonic.authoring_rows() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE oldj jsonb; newj jsonb;
BEGIN
 newj:=to_jsonb(NEW);
 IF TG_OP='UPDATE' THEN
  oldj:=to_jsonb(OLD);newj:=to_jsonb(NEW);
  IF newj->'id' IS DISTINCT FROM oldj->'id' OR newj->'workspace_id' IS DISTINCT FROM oldj->'workspace_id' OR newj->'created_at' IS DISTINCT FROM oldj->'created_at' THEN RAISE EXCEPTION 'Immutable identity'; END IF;
  IF TG_TABLE_NAME IN ('configuration_tools','code_tools','submission_review_decisions') THEN RAISE EXCEPTION 'Immutable record'; END IF;
  IF TG_TABLE_NAME='code_releases' AND newj-ARRAY['retired_at','revoked_at'] IS DISTINCT FROM oldj-ARRAY['retired_at','revoked_at'] THEN RAISE EXCEPTION 'Immutable code release'; END IF;
  IF TG_TABLE_NAME='configuration_releases' AND newj-'retired_at' IS DISTINCT FROM oldj-'retired_at' THEN RAISE EXCEPTION 'Immutable configuration'; END IF;
  IF TG_TABLE_NAME='agent_submissions' AND newj-'status' IS DISTINCT FROM oldj-'status' THEN RAISE EXCEPTION 'Immutable submission'; END IF;
  IF TG_TABLE_NAME='stored_objects' AND newj-'deleted_at' IS DISTINCT FROM oldj-'deleted_at' THEN RAISE EXCEPTION 'Immutable object'; END IF;
  IF TG_TABLE_NAME='configuration_drafts' AND ((newj->>'revision')::bigint<>(oldj->>'revision')::bigint+1 OR newj-ARRAY['revision','title','content','requested_access','updated_at','status'] IS DISTINCT FROM oldj-ARRAY['revision','title','content','requested_access','updated_at','status']) THEN RAISE EXCEPTION 'Invalid draft revision'; END IF;
 END IF;
 IF TG_TABLE_NAME='code_releases' AND NOT EXISTS(SELECT 1 FROM agentonic.template_versions v JOIN agentonic.agent_templates t ON t.id=v.template_id WHERE v.id=(newj->>'template_version_id')::uuid AND t.code_repository_id=(newj->>'code_repository_id')::uuid AND v.git_commit_sha=newj->>'git_commit_sha' AND v.runtime_contract_version=newj->>'runtime_contract_version') THEN RAISE EXCEPTION 'Incompatible code'; END IF;
 IF TG_TABLE_NAME='workspace_code_release_grants' AND NOT EXISTS(SELECT 1 FROM agentonic.code_releases c JOIN agentonic.code_repositories r ON r.id=c.code_repository_id WHERE c.id=(newj->>'code_release_id')::uuid AND (r.visibility='platform' OR r.workspace_id=(newj->>'workspace_id')::uuid)) THEN RAISE EXCEPTION 'Private repository'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION agentonic.revoke_authoring_access() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF (NEW.status<>'active' OR NEW.removed_at IS NOT NULL) AND OLD.status='active' AND OLD.removed_at IS NULL THEN
  UPDATE agentonic.knowledge_sources SET configuration=configuration||'{"revoked":true}'::jsonb WHERE workspace_id=NEW.workspace_id AND authorized_by_member_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER authoring_offboarding AFTER UPDATE ON agentonic.workspace_members FOR EACH ROW EXECUTE FUNCTION agentonic.revoke_authoring_access();

CREATE OR REPLACE FUNCTION agentonic.validate_access_rows() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
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
 ELSIF TG_TABLE_NAME='support_access_grants' AND TG_OP='INSERT' AND to_jsonb(NEW)->'scope'->'version'='2'::jsonb THEN
  IF (NEW.scope-ARRAY['version','submissionId','operations'])<>'{}'::jsonb OR NEW.scope->'operations' IS DISTINCT FROM '["review"]'::jsonb OR NOT EXISTS(
   SELECT 1 FROM agentonic.agent_submissions s WHERE s.id=(NEW.scope->>'submissionId')::uuid AND s.workspace_id=NEW.workspace_id AND s.submitted_by_member_id=NEW.approved_by_member_id
   AND s.status IN ('submitted','in_review') AND agentonic.member_can_author(s.submitted_by_member_id,s.agent_id)
   AND s.review_consent->'configuration'='true'::jsonb AND s.review_consent->'knowledgeMetadata'='true'::jsonb
   AND (s.review_consent->>'expiresAt')::timestamptz>=NEW.expires_at AND NEW.expires_at<=clock_timestamp()+interval '7 days'
  ) THEN RAISE EXCEPTION 'Invalid review consent'; END IF;
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

CREATE FUNCTION agentonic.can_review(sid uuid,gid uuid) RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM agentonic.agent_submissions s JOIN agentonic.support_access_grants g ON g.workspace_id=s.workspace_id
 JOIN agentonic.code_releases c ON c.id=s.code_release_id JOIN agentonic.code_repositories r ON r.id=c.code_repository_id
 JOIN agentonic.workspace_code_release_grants cg ON cg.workspace_id=s.workspace_id AND cg.code_release_id=c.id
 WHERE s.id=sid AND s.workspace_id=agentonic.workspace_id() AND g.id=gid AND g.staff_id=agentonic.current_staff()
 AND g.scope=jsonb_build_object('version',2,'submissionId',s.id::text,'operations',jsonb_build_array('review'))
 AND g.approved_by_member_id=s.submitted_by_member_id AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
 AND s.status IN ('submitted','in_review') AND (s.review_consent->>'expiresAt')::timestamptz>clock_timestamp()
 AND agentonic.member_can_author(s.submitted_by_member_id,s.agent_id) AND c.revoked_at IS NULL AND cg.revoked_at IS NULL AND r.provisioning_status='ready'
 AND (r.visibility='platform' OR r.workspace_id=s.workspace_id))
$$;

CREATE FUNCTION agentonic.authoring_command(operation text,payload jsonb,trace_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_column
DECLARE
 w uuid:=agentonic.workspace_id(); actor uuid:=agentonic.actor_user_id(); m uuid; staff uuid; aid uuid; target uuid; rid uuid; gid uuid;
 result jsonb; allowed text[]; item jsonb; snapshot jsonb; consent jsonb; content jsonb; requested jsonb; expiry timestamptz;
 draft agentonic.configuration_drafts; release agentonic.configuration_releases; submission agentonic.agent_submissions;
 code agentonic.code_releases; obj agentonic.stored_objects; src uuid; doc uuid; revision bigint; collection uuid; platform_policy text; assets jsonb;
BEGIN
 IF agentonic.application_role() NOT IN ('agentonic_admin','agentonic_customer') OR actor IS NULL OR w IS NULL OR trace_id IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 m:=agentonic.current_member(); staff:=agentonic.current_staff();
 IF m IS NULL AND staff IS NULL THEN RAISE insufficient_privilege; END IF;
 BEGIN
 allowed:=CASE operation
 WHEN 'list' THEN ARRAY[]::text[] WHEN 'detail' THEN ARRAY['agentId'] WHEN 'draft.save' THEN ARRAY['agentId','revision','content','requestedAccess']
 WHEN 'candidate.freeze' THEN ARRAY['agentId','revision','codeReleaseId'] WHEN 'submission.send' THEN ARRAY['candidateId','note','consent']
 WHEN 'submission.withdraw' THEN ARRAY['submissionId'] WHEN 'upload.reserve' THEN ARRAY['collectionId','title','sha256','size','contentType']
 WHEN 'upload.complete' THEN ARRAY['objectId'] WHEN 'upload.fail' THEN ARRAY['objectId'] WHEN 'document.remove' THEN ARRAY['objectId'] WHEN 'document.download' THEN ARRAY['objectId']
 WHEN 'review.queue' THEN ARRAY[]::text[] WHEN 'review.open' THEN ARRAY['submissionId'] WHEN 'review.read' THEN ARRAY['submissionId','grantId'] WHEN 'review.decide' THEN ARRAY['submissionId','grantId','decision','feedback'] ELSE NULL END;
 IF allowed IS NULL OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR payload-allowed<>'{}'::jsonb THEN RAISE insufficient_privilege; END IF;
 aid:=(payload->>'agentId')::uuid;
 IF operation IN ('detail','draft.save','candidate.freeze') AND NOT agentonic.can_agent(aid,'edit') THEN RAISE insufficient_privilege; END IF;
 IF operation='list' THEN
  IF m IS NULL THEN RAISE insufficient_privilege; END IF;
  result:=jsonb_build_object(
   'canCreate',agentonic.workspace_manager(),
   'agents',coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'slug',a.slug,'description',a.description,'canEdit',agentonic.can_agent(a.id,'edit'),'status',a.status) ORDER BY a.created_at DESC) FROM agentonic.agents a WHERE a.workspace_id=w AND agentonic.can_agent(a.id,'read')),'[]'::jsonb),
   'collections',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'canCurate',agentonic.can_collection(c.id,'curate')) ORDER BY c.created_at DESC) FROM agentonic.knowledge_collections c WHERE c.workspace_id=w AND agentonic.can_collection(c.id,'read')),'[]'::jsonb),
   'templates',coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'name',t.name,'version',v.version,'codeReleaseId',c.id,'codeVersion',c.version)) FROM agentonic.code_releases c JOIN agentonic.template_versions v ON v.id=c.template_version_id JOIN agentonic.agent_templates t ON t.id=v.template_id WHERE agentonic.can_use_code(c.id)),'[]'::jsonb),
   'documents',coalesce((SELECT jsonb_agg(jsonb_build_object('id',o.id,'title',d.title,'collectionId',s.collection_id,'size',o.size_bytes,'contentType',o.content_type,'uploadStatus',v.metadata->>'uploadStatus','status',v.status,'canRemove',agentonic.can_collection(s.collection_id,'curate')) ORDER BY o.created_at DESC) FROM agentonic.stored_objects o JOIN agentonic.document_versions v ON v.object_id=o.id AND v.workspace_id=w JOIN agentonic.documents d ON d.id=v.document_id JOIN agentonic.knowledge_sources s ON s.id=d.source_id WHERE o.workspace_id=w AND o.deleted_at IS NULL AND d.deleted_at IS NULL AND s.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb AND agentonic.can_collection(s.collection_id,'read')),'[]'::jsonb));
 ELSIF operation='detail' THEN
  SELECT * INTO draft FROM agentonic.configuration_drafts WHERE workspace_id=w AND agent_id=aid AND status='draft';
  result:=jsonb_build_object('agent',(SELECT jsonb_build_object('id',id,'name',name,'description',description,'templateVersionId',template_version_id) FROM agentonic.agents WHERE id=aid AND workspace_id=w),
   'draft',CASE WHEN draft.id IS NOT NULL THEN jsonb_build_object('revision',draft.revision,'content',draft.content,'requestedAccess',draft.requested_access) ELSE jsonb_build_object('revision',0,'content',jsonb_build_object('version',1,'systemPrompt','','skills','[]'::jsonb),'requestedAccess',jsonb_build_object('version',1,'collectionIds','[]'::jsonb,'tools','[]'::jsonb)) END,
   'candidates',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'version',version,'revision',source_draft_revision,'hash',content_sha256) ORDER BY created_at DESC) FROM agentonic.configuration_releases WHERE workspace_id=w AND agent_id=aid),'[]'::jsonb),
   'submissions',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'number',s.submission_number,'candidateId',s.configuration_release_id,'status',s.status,'note',s.customer_note,'decisions',coalesce((SELECT jsonb_agg(jsonb_build_object('decision',decision,'feedback',feedback,'number',decision_number) ORDER BY decision_number) FROM agentonic.submission_review_decisions WHERE submission_id=s.id AND workspace_id=w),'[]'::jsonb)) ORDER BY s.submission_number DESC) FROM agentonic.agent_submissions s WHERE workspace_id=w AND agent_id=aid),'[]'::jsonb));
 ELSIF operation='draft.save' THEN
  revision:=(payload->>'revision')::bigint;content:=payload->'content';requested:=payload->'requestedAccess';
  IF NOT agentonic.valid_draft(content,requested) OR revision IS NULL OR revision<0 THEN RAISE insufficient_privilege; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(requested->'collectionIds') LOOP
   IF NOT agentonic.can_collection((item#>>'{}')::uuid,'read') THEN RAISE insufficient_privilege; END IF;
  END LOOP;
  SELECT * INTO draft FROM agentonic.configuration_drafts WHERE workspace_id=w AND agent_id=aid AND status='draft' FOR UPDATE;
  IF coalesce(draft.revision,0)<>revision THEN RETURN jsonb_build_object('ok',false,'code','conflict'); END IF;
  IF draft.id IS NULL THEN
   INSERT INTO agentonic.configuration_drafts(workspace_id,agent_id,title,content,requested_access,created_by_member_id) VALUES(w,aid,'Configuración',content,requested,m) RETURNING id,configuration_drafts.revision INTO rid,revision;
  ELSE
   UPDATE agentonic.configuration_drafts SET content=payload->'content',requested_access=requested,revision=configuration_drafts.revision+1,updated_at=clock_timestamp() WHERE id=draft.id RETURNING id,configuration_drafts.revision INTO rid,revision;
  END IF;
  result:=jsonb_build_object('revision',revision);
 ELSIF operation='candidate.freeze' THEN
  SELECT * INTO draft FROM agentonic.configuration_drafts WHERE workspace_id=w AND agent_id=aid AND status='draft' FOR UPDATE;
  IF draft.id IS NULL OR draft.revision IS DISTINCT FROM (payload->>'revision')::bigint THEN RETURN jsonb_build_object('ok',false,'code','conflict'); END IF;
  IF length(btrim(draft.content->>'systemPrompt'))=0 THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO code FROM agentonic.code_releases WHERE id=(payload->>'codeReleaseId')::uuid AND agentonic.can_use_code(id);
  IF code.id IS NULL OR NOT EXISTS(SELECT 1 FROM agentonic.agents WHERE id=aid AND workspace_id=w AND template_version_id=code.template_version_id) THEN RAISE insufficient_privilege; END IF;
  SELECT structure_manifest->>'platformPolicyText' INTO platform_policy FROM agentonic.template_versions WHERE id=code.template_version_id;
  IF platform_policy IS NULL OR length(platform_policy)=0 THEN RAISE insufficient_privilege; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('path','skills/'||(x->>'name')||'.md','sha256',encode(sha256(convert_to(x->>'instructions','UTF8')),'hex')) ORDER BY x->>'name'),'[]'::jsonb) INTO assets FROM jsonb_array_elements(draft.content->'skills') x;
  assets:=jsonb_build_array(jsonb_build_object('path','prompts/system.md','sha256',encode(sha256(convert_to(draft.content->>'systemPrompt','UTF8')),'hex')))||assets;
  FOR item IN SELECT value FROM jsonb_array_elements(draft.requested_access->'collectionIds') LOOP
   IF NOT agentonic.can_collection((item#>>'{}')::uuid,'read') THEN RAISE insufficient_privilege; END IF;
  END LOOP;
  snapshot:=draft.requested_access||jsonb_build_object('collections',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'sources',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'revision',s.definition_revision,'hash',s.definition_sha256) ORDER BY s.id) FROM agentonic.knowledge_sources s WHERE s.collection_id=c.id AND s.workspace_id=w AND s.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb),'[]'::jsonb)) ORDER BY c.id) FROM agentonic.knowledge_collections c WHERE c.workspace_id=w AND draft.requested_access->'collectionIds' @> to_jsonb(c.id::text)),'[]'::jsonb));
  INSERT INTO agentonic.configuration_releases(workspace_id,agent_id,code_release_id,source_draft_id,source_draft_revision,version,content,content_sha256,composed_prompt_sha256,asset_manifest_sha256,frozen_by_member_id,requested_access_snapshot,requested_access_sha256)
   VALUES(w,aid,code.id,draft.id,draft.revision,'r'||draft.revision||'-'||left(code.id::text,8),draft.content,agentonic.content_hash(draft.content),encode(sha256(convert_to(platform_policy||E'\n\n'||(draft.content->>'systemPrompt'),'UTF8')),'hex'),agentonic.content_hash(assets),m,snapshot,agentonic.content_hash(snapshot))
   ON CONFLICT(workspace_id,source_draft_id,source_draft_revision,code_release_id) DO NOTHING RETURNING id INTO rid;
  IF rid IS NULL THEN SELECT id INTO rid FROM agentonic.configuration_releases WHERE workspace_id=w AND source_draft_id=draft.id AND source_draft_revision=draft.revision AND code_release_id=code.id; END IF;
 ELSIF operation='submission.send' THEN
  SELECT * INTO release FROM agentonic.configuration_releases WHERE id=(payload->>'candidateId')::uuid AND workspace_id=w AND retired_at IS NULL;
  IF release.id IS NULL OR NOT agentonic.can_agent(release.agent_id,'edit') OR NOT agentonic.can_use_code(release.code_release_id) THEN RAISE insufficient_privilege; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(release.requested_access_snapshot->'collectionIds') LOOP IF NOT agentonic.can_collection((item#>>'{}')::uuid,'read') THEN RAISE insufficient_privilege; END IF; END LOOP;
  IF payload->'consent' IS DISTINCT FROM 'true'::jsonb OR length(coalesce(payload->>'note',''))>2000 THEN RAISE insufficient_privilege; END IF;
  expiry:=clock_timestamp()+interval '7 days';consent:=jsonb_build_object('version',1,'configuration',true,'knowledgeMetadata',true,'expiresAt',expiry);
  INSERT INTO agentonic.agent_submissions(workspace_id,agent_id,code_release_id,configuration_release_id,submission_number,submitted_by_member_id,customer_note,review_consent)
   SELECT w,release.agent_id,release.code_release_id,release.id,coalesce(max(submission_number),0)+1,m,payload->>'note',consent FROM agentonic.agent_submissions WHERE workspace_id=w AND agent_id=release.agent_id RETURNING id INTO rid;
 ELSIF operation='submission.withdraw' THEN
  SELECT * INTO submission FROM agentonic.agent_submissions WHERE workspace_id=w AND id=(payload->>'submissionId')::uuid FOR UPDATE;
  IF submission.id IS NULL OR NOT agentonic.can_agent(submission.agent_id,'edit') OR submission.status NOT IN ('submitted','in_review') THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.submission_review_decisions(workspace_id,agent_id,submission_id,decision_number,decision,actor_member_id,assessment_snapshot)
   SELECT w,submission.agent_id,submission.id,coalesce(max(decision_number),0)+1,'withdrawn',m,'{"version":1}'::jsonb FROM agentonic.submission_review_decisions WHERE submission_id=submission.id;
  UPDATE agentonic.agent_submissions SET status='withdrawn' WHERE id=submission.id;
  UPDATE agentonic.support_access_grants SET revoked_at=clock_timestamp() WHERE workspace_id=w AND scope->>'submissionId'=submission.id::text AND revoked_at IS NULL;rid:=submission.id;
 ELSIF operation='upload.reserve' THEN
  collection:=(payload->>'collectionId')::uuid;
  IF NOT agentonic.can_collection(collection,'curate') OR length(btrim(payload->>'title')) NOT BETWEEN 1 AND 200 OR payload->>'title' IS NULL THEN RAISE insufficient_privilege; END IF;
  IF (SELECT coalesce(sum(size_bytes),0) FROM agentonic.stored_objects WHERE workspace_id=w)+(payload->>'size')::bigint>524288000 THEN RAISE insufficient_privilege; END IF;
  rid:=gen_random_uuid();src:=gen_random_uuid();doc:=gen_random_uuid();
  INSERT INTO agentonic.knowledge_sources(id,workspace_id,collection_id,kind,locator,authorized_by_member_id,environment,definition_sha256) VALUES(src,w,collection,'upload',rid::text,m,'staging',agentonic.content_hash(jsonb_build_object('objectId',rid,'collectionId',collection)));
  INSERT INTO agentonic.stored_objects(id,workspace_id,provider,bucket,object_key,content_sha256,content_type,size_bytes) VALUES(rid,w,'supabase_storage','agentonic-documents',w::text||'/'||rid::text,payload->>'sha256',payload->>'contentType',(payload->>'size')::bigint);
  INSERT INTO agentonic.documents(id,workspace_id,source_id,external_document_id,title) VALUES(doc,w,src,rid::text,payload->>'title');
  INSERT INTO agentonic.document_versions(workspace_id,document_id,version_key,content_sha256,object_id,parser_version,chunker_version,metadata) VALUES(w,doc,'1',payload->>'sha256',rid,'pending','pending','{"uploadStatus":"pending"}'::jsonb);
  result:=jsonb_build_object('objectKey',w::text||'/'||rid::text);
 ELSIF operation IN ('upload.complete','upload.fail','document.remove','document.download') THEN
  SELECT * INTO obj FROM agentonic.stored_objects WHERE id=(payload->>'objectId')::uuid AND workspace_id=w AND deleted_at IS NULL;
  SELECT s.collection_id,s.id,d.id INTO collection,src,doc FROM agentonic.document_versions v JOIN agentonic.documents d ON d.id=v.document_id JOIN agentonic.knowledge_sources s ON s.id=d.source_id WHERE v.object_id=obj.id AND v.workspace_id=w AND d.deleted_at IS NULL AND s.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb;
  IF obj.id IS NULL OR collection IS NULL OR NOT agentonic.can_collection(collection,CASE WHEN operation='document.download' THEN 'read' ELSE 'curate' END) THEN RAISE insufficient_privilege; END IF;
  IF operation='upload.complete' THEN
   IF NOT EXISTS(SELECT 1 FROM agentonic.document_versions WHERE object_id=obj.id AND metadata->>'uploadStatus'='pending') THEN RAISE insufficient_privilege; END IF;
   IF (agentonic_bootstrap.storage_object_info(obj.object_key)->>'size')::bigint IS DISTINCT FROM obj.size_bytes THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.document_versions SET metadata='{"uploadStatus":"uploaded"}'::jsonb WHERE object_id=obj.id;
  ELSIF operation IN ('upload.fail','document.remove') THEN
   UPDATE agentonic.stored_objects SET deleted_at=clock_timestamp() WHERE id=obj.id;
   UPDATE agentonic.documents SET deleted_at=clock_timestamp() WHERE id=doc;
   UPDATE agentonic.document_versions SET status='failed',metadata='{"uploadStatus":"removed"}'::jsonb WHERE object_id=obj.id;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM agentonic.document_versions WHERE object_id=obj.id AND metadata->>'uploadStatus'='uploaded') THEN RAISE insufficient_privilege; END IF;
   result:=jsonb_build_object('objectKey',obj.object_key,'contentType',obj.content_type,'title',(SELECT title FROM agentonic.documents WHERE id=doc));
  END IF;rid:=obj.id;
 ELSIF operation='review.queue' THEN
  IF staff IS NULL THEN RAISE insufficient_privilege; END IF;
  result:=coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'agentName',a.name,'number',s.submission_number,'status',s.status) ORDER BY s.submitted_at) FROM agentonic.agent_submissions s JOIN agentonic.agents a ON a.id=s.agent_id WHERE s.workspace_id=w AND s.status IN ('submitted','in_review') AND (s.review_consent->>'expiresAt')::timestamptz>clock_timestamp() AND agentonic.member_can_author(s.submitted_by_member_id,s.agent_id)),'[]'::jsonb);
 ELSIF operation IN ('review.open','review.read','review.decide') THEN
  IF staff IS NULL THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO submission FROM agentonic.agent_submissions WHERE id=(payload->>'submissionId')::uuid AND workspace_id=w FOR UPDATE;
  IF submission.id IS NULL OR submission.status NOT IN ('submitted','in_review') OR NOT agentonic.member_can_author(submission.submitted_by_member_id,submission.agent_id) OR (submission.review_consent->>'expiresAt')::timestamptz<=clock_timestamp() THEN RAISE insufficient_privilege; END IF;
  IF operation='review.open' THEN
   SELECT id INTO gid FROM agentonic.support_access_grants WHERE workspace_id=w AND staff_id=staff AND scope=jsonb_build_object('version',2,'submissionId',submission.id::text,'operations',jsonb_build_array('review')) AND revoked_at IS NULL AND expires_at>clock_timestamp() LIMIT 1;
   IF gid IS NULL THEN
    INSERT INTO agentonic.support_access_grants(workspace_id,staff_id,approved_by_member_id,reason,scope,expires_at) VALUES(w,staff,submission.submitted_by_member_id,'Revisión solicitada por el cliente',jsonb_build_object('version',2,'submissionId',submission.id::text,'operations',jsonb_build_array('review')),(submission.review_consent->>'expiresAt')::timestamptz) RETURNING id INTO gid;
   END IF;
  ELSE gid:=(payload->>'grantId')::uuid; END IF;
  IF NOT agentonic.can_review(submission.id,gid) THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO release FROM agentonic.configuration_releases WHERE id=submission.configuration_release_id;
  FOR item IN SELECT value FROM jsonb_array_elements(release.requested_access_snapshot->'collectionIds') LOOP IF NOT agentonic.member_can_collection(submission.submitted_by_member_id,(item#>>'{}')::uuid,'read') THEN RAISE insufficient_privilege; END IF; END LOOP;
  IF operation IN ('review.open','review.read') THEN
   result:=jsonb_build_object('id',submission.id,'grantId',gid,'number',submission.submission_number,'agentName',(SELECT name FROM agentonic.agents WHERE id=submission.agent_id),'note',submission.customer_note,'content',release.content,'requestedAccess',release.requested_access_snapshot,'hash',release.content_sha256,'status',submission.status);
  ELSE
   IF payload->>'decision' NOT IN ('in_review','changes_requested','rejected') OR payload->>'decision' IS NULL OR payload->>'feedback' IS NULL OR length(btrim(payload->>'feedback')) NOT BETWEEN 1 AND 2000 THEN RAISE insufficient_privilege; END IF;
   INSERT INTO agentonic.submission_review_decisions(workspace_id,agent_id,submission_id,decision_number,decision,actor_staff_id,support_access_grant_id,feedback,assessment_snapshot)
    SELECT w,submission.agent_id,submission.id,coalesce(max(decision_number),0)+1,payload->>'decision',staff,gid,payload->>'feedback',jsonb_build_object('version',1,'configurationHash',release.content_sha256,'requestedAccessHash',release.requested_access_sha256,'evaluated',false) FROM agentonic.submission_review_decisions WHERE submission_id=submission.id;
   UPDATE agentonic.agent_submissions SET status=payload->>'decision' WHERE id=submission.id;
  END IF;rid:=submission.id;
 END IF;
 INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,support_access_grant_id,action,resource_type,resource_id,outcome,request_id)
 VALUES(w,actor,CASE WHEN operation LIKE 'review.%' THEN NULL ELSE m END,gid,operation,'authoring',coalesce(rid::text,aid::text,'workspace'),'succeeded',trace_id::text);
 RETURN jsonb_build_object('ok',true,'id',rid,'data',result);
 EXCEPTION WHEN insufficient_privilege THEN
 INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,action,resource_type,resource_id,outcome,request_id) VALUES(w,actor,m,'authoring.denied','authoring','request','denied',trace_id::text);
 RETURN jsonb_build_object('ok',false);
 END;
END $$;

CREATE FUNCTION agentonic.can_read_object(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM agentonic.stored_objects o JOIN agentonic.document_versions v ON v.object_id=o.id AND v.workspace_id=o.workspace_id
 JOIN agentonic.documents d ON d.id=v.document_id JOIN agentonic.knowledge_sources s ON s.id=d.source_id
 WHERE o.id=target AND o.workspace_id=agentonic.workspace_id() AND o.deleted_at IS NULL AND d.deleted_at IS NULL
 AND s.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb AND agentonic.can_collection(s.collection_id,'read'))
$$;
CREATE SCHEMA agentonic_storage;
REVOKE ALL ON SCHEMA agentonic_storage FROM PUBLIC,anon,service_role;
GRANT USAGE ON SCHEMA agentonic_storage TO authenticated;
CREATE FUNCTION agentonic_storage.allowed(object_name text,operation text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE auth_id uuid; m uuid; o agentonic.stored_objects; c uuid; uploader uuid; state text;
BEGIN
 IF agentonic.application_role()<>'authenticated' OR operation NOT IN ('read','upload') THEN RETURN false; END IF;
 auth_id:=coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid;
 SELECT * INTO o FROM agentonic.stored_objects WHERE object_key=object_name AND deleted_at IS NULL;
 IF o.id IS NULL OR auth_id IS NULL THEN RETURN false; END IF;
 SELECT wm.id INTO m FROM agentonic.workspace_members wm JOIN agentonic.users u ON u.id=wm.user_id WHERE wm.workspace_id=o.workspace_id AND u.auth_user_id=auth_id AND u.deleted_at IS NULL AND wm.status='active' AND wm.removed_at IS NULL;
 SELECT s.collection_id,s.authorized_by_member_id,v.metadata->>'uploadStatus' INTO c,uploader,state FROM agentonic.document_versions v JOIN agentonic.documents d ON d.id=v.document_id JOIN agentonic.knowledge_sources s ON s.id=d.source_id
 WHERE v.object_id=o.id AND v.workspace_id=o.workspace_id AND d.deleted_at IS NULL AND s.configuration->'revoked' IS DISTINCT FROM 'true'::jsonb;
 IF m IS NULL OR c IS NULL THEN RETURN false; END IF;
 IF operation='upload' THEN RETURN m=uploader AND state='pending' AND agentonic.member_can_collection(m,c,'curate'); END IF;
 RETURN agentonic.member_can_collection(m,c,'read') AND (state='uploaded' OR (state='pending' AND m=uploader));
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION agentonic_storage.allowed(text,text) FROM PUBLIC,anon,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic_storage.allowed(text,text) TO authenticated;
SELECT agentonic_bootstrap.install_storage_boundary();

ALTER TABLE agentonic.code_releases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.code_releases FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT SELECT ON agentonic.code_releases TO agentonic_admin,agentonic_customer;
CREATE POLICY authoring_read ON agentonic.code_releases FOR SELECT TO agentonic_admin,agentonic_customer USING(agentonic.current_staff() IS NOT NULL OR agentonic.can_use_code(id));
CREATE TRIGGER authoring_guard BEFORE INSERT OR UPDATE ON agentonic.code_releases FOR EACH ROW EXECUTE FUNCTION agentonic.authoring_rows();

ALTER TABLE agentonic.workspace_code_release_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.workspace_code_release_grants FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT SELECT ON agentonic.workspace_code_release_grants TO agentonic_admin,agentonic_customer;
CREATE POLICY authoring_read ON agentonic.workspace_code_release_grants FOR SELECT TO agentonic_admin,agentonic_customer USING(agentonic.current_staff() IS NOT NULL OR (workspace_id=agentonic.workspace_id() AND agentonic.current_member() IS NOT NULL));
CREATE TRIGGER authoring_guard BEFORE INSERT OR UPDATE ON agentonic.workspace_code_release_grants FOR EACH ROW EXECUTE FUNCTION agentonic.authoring_rows();

ALTER TABLE agentonic.code_tools ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.code_tools FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT SELECT ON agentonic.code_tools TO agentonic_admin,agentonic_customer;
CREATE POLICY authoring_read ON agentonic.code_tools FOR SELECT TO agentonic_admin,agentonic_customer USING(agentonic.current_staff() IS NOT NULL OR agentonic.can_use_code(code_release_id));
CREATE TRIGGER authoring_guard BEFORE INSERT OR UPDATE ON agentonic.code_tools FOR EACH ROW EXECUTE FUNCTION agentonic.authoring_rows();

ALTER TABLE agentonic.configuration_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.configuration_drafts FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT SELECT ON agentonic.configuration_drafts TO agentonic_admin,agentonic_customer;
CREATE POLICY authoring_read ON agentonic.configuration_drafts FOR SELECT TO agentonic_admin,agentonic_customer USING(workspace_id=agentonic.workspace_id() AND agentonic.can_agent(agent_id,'edit'));
CREATE TRIGGER authoring_guard BEFORE INSERT OR UPDATE ON agentonic.configuration_drafts FOR EACH ROW EXECUTE FUNCTION agentonic.authoring_rows();

ALTER TABLE agentonic.configuration_releases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.configuration_releases FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT SELECT ON agentonic.configuration_releases TO agentonic_admin,agentonic_customer;
CREATE POLICY authoring_read ON agentonic.configuration_releases FOR SELECT TO agentonic_admin,agentonic_customer USING(workspace_id=agentonic.workspace_id() AND agentonic.can_agent(agent_id,'edit'));
CREATE TRIGGER authoring_guard BEFORE INSERT OR UPDATE ON agentonic.configuration_releases FOR EACH ROW EXECUTE FUNCTION agentonic.authoring_rows();

ALTER TABLE agentonic.configuration_tools ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.configuration_tools FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT SELECT ON agentonic.configuration_tools TO agentonic_admin,agentonic_customer;
CREATE POLICY authoring_read ON agentonic.configuration_tools FOR SELECT TO agentonic_admin,agentonic_customer USING(workspace_id=agentonic.workspace_id() AND agentonic.can_agent(agent_id,'edit'));
CREATE TRIGGER authoring_guard BEFORE INSERT OR UPDATE ON agentonic.configuration_tools FOR EACH ROW EXECUTE FUNCTION agentonic.authoring_rows();

ALTER TABLE agentonic.agent_submissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.agent_submissions FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT SELECT ON agentonic.agent_submissions TO agentonic_admin,agentonic_customer;
CREATE POLICY authoring_read ON agentonic.agent_submissions FOR SELECT TO agentonic_admin,agentonic_customer USING(workspace_id=agentonic.workspace_id() AND agentonic.can_agent(agent_id,'edit'));
CREATE TRIGGER authoring_guard BEFORE INSERT OR UPDATE ON agentonic.agent_submissions FOR EACH ROW EXECUTE FUNCTION agentonic.authoring_rows();

ALTER TABLE agentonic.submission_review_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.submission_review_decisions FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT SELECT ON agentonic.submission_review_decisions TO agentonic_admin,agentonic_customer;
CREATE POLICY authoring_read ON agentonic.submission_review_decisions FOR SELECT TO agentonic_admin,agentonic_customer USING(workspace_id=agentonic.workspace_id() AND agentonic.can_agent(agent_id,'edit'));
CREATE TRIGGER authoring_guard BEFORE INSERT OR UPDATE ON agentonic.submission_review_decisions FOR EACH ROW EXECUTE FUNCTION agentonic.authoring_rows();

ALTER TABLE agentonic.stored_objects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.stored_objects FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT SELECT ON agentonic.stored_objects TO agentonic_admin,agentonic_customer;
CREATE POLICY authoring_read ON agentonic.stored_objects FOR SELECT TO agentonic_admin,agentonic_customer USING(agentonic.can_read_object(id));
CREATE TRIGGER authoring_guard BEFORE INSERT OR UPDATE ON agentonic.stored_objects FOR EACH ROW EXECUTE FUNCTION agentonic.authoring_rows();

ALTER TABLE agentonic.knowledge_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.knowledge_sources FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT SELECT ON agentonic.knowledge_sources TO agentonic_admin,agentonic_customer;
CREATE POLICY authoring_read ON agentonic.knowledge_sources FOR SELECT TO agentonic_admin,agentonic_customer USING(workspace_id=agentonic.workspace_id() AND configuration->'revoked' IS DISTINCT FROM 'true'::jsonb AND agentonic.can_collection(collection_id,'read'));
CREATE TRIGGER authoring_guard BEFORE INSERT OR UPDATE ON agentonic.knowledge_sources FOR EACH ROW EXECUTE FUNCTION agentonic.authoring_rows();

ALTER TABLE agentonic.documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.documents FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT SELECT ON agentonic.documents TO agentonic_admin,agentonic_customer;
CREATE POLICY authoring_read ON agentonic.documents FOR SELECT TO agentonic_admin,agentonic_customer USING(workspace_id=agentonic.workspace_id() AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM agentonic.knowledge_sources WHERE id=source_id));
CREATE TRIGGER authoring_guard BEFORE INSERT OR UPDATE ON agentonic.documents FOR EACH ROW EXECUTE FUNCTION agentonic.authoring_rows();

ALTER TABLE agentonic.document_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agentonic.document_versions FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT SELECT ON agentonic.document_versions TO agentonic_admin,agentonic_customer;
CREATE POLICY authoring_read ON agentonic.document_versions FOR SELECT TO agentonic_admin,agentonic_customer USING(workspace_id=agentonic.workspace_id() AND agentonic.can_read_object(object_id));
CREATE TRIGGER authoring_guard BEFORE INSERT OR UPDATE ON agentonic.document_versions FOR EACH ROW EXECUTE FUNCTION agentonic.authoring_rows();

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA agentonic FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION agentonic.member_can_author(uuid,uuid),agentonic.member_can_collection(uuid,uuid,text),agentonic.valid_draft(jsonb,jsonb),agentonic.authoring_rows(),agentonic.revoke_authoring_access(),agentonic.content_hash(jsonb),agentonic.can_review(uuid,uuid) FROM agentonic_admin,agentonic_customer,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic.authoring_command(text,jsonb,uuid),agentonic.can_use_code(uuid),agentonic.can_read_object(uuid) TO agentonic_admin,agentonic_customer;
CREATE FUNCTION agentonic.review_workspaces() RETURNS TABLE(id uuid,name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT DISTINCT w.id,w.name FROM agentonic.workspaces w JOIN agentonic.agent_submissions s ON s.workspace_id=w.id
 WHERE agentonic.current_staff() IS NOT NULL AND w.status='active' AND w.deleted_at IS NULL AND s.status IN ('submitted','in_review')
 AND (s.review_consent->>'expiresAt')::timestamptz>clock_timestamp() AND agentonic.member_can_author(s.submitted_by_member_id,s.agent_id)
$$;
REVOKE ALL ON FUNCTION agentonic.review_workspaces() FROM PUBLIC,anon,authenticated,service_role,agentonic_customer,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic.review_workspaces() TO agentonic_admin;
COMMIT;
