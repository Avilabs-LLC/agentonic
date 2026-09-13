-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "agentonic";

-- CreateTable
CREATE TABLE "agentonic"."users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "display_name" TEXT NOT NULL,
    "avatar_url" TEXT,
    "deleted_at" TIMESTAMPTZ,
    "auth_user_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agentonic"."platform_staff" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "disabled_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agentonic"."workspaces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "personal_owner_user_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'active',
    "preferred_region" TEXT,
    "deleted_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "timezone" TEXT NOT NULL,
    "retention_policy" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agentonic"."workspace_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "status" TEXT NOT NULL DEFAULT 'active',
    "joined_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_auth_user_id_key" ON "agentonic"."users"("auth_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_staff_user_id_key" ON "agentonic"."platform_staff"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "agentonic"."workspaces"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_personal_owner_user_id_key" ON "agentonic"."workspaces"("personal_owner_user_id");

-- CreateIndex
CREATE INDEX "workspace_members_user_id_idx" ON "agentonic"."workspace_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspace_id_id_key" ON "agentonic"."workspace_members"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspace_id_user_id_key" ON "agentonic"."workspace_members"("workspace_id", "user_id");

-- AddForeignKey
ALTER TABLE "agentonic"."platform_staff" ADD CONSTRAINT "platform_staff_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "agentonic"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "agentonic"."workspaces" ADD CONSTRAINT "workspaces_personal_owner_user_id_fkey" FOREIGN KEY ("personal_owner_user_id") REFERENCES "agentonic"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "agentonic"."workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "agentonic"."workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "agentonic"."workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "agentonic"."users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Supabase owns Auth. Never create or alter auth.users in an application migration.
-- A narrowly scoped bootstrap helper owns this cross-schema DDL; see provision-database.mjs.
SELECT agentonic_bootstrap.link_auth_users();
ALTER TABLE agentonic.users ADD CHECK (auth_user_id IS NOT NULL OR deleted_at IS NOT NULL);
ALTER TABLE agentonic.platform_staff ADD CHECK (role IN ('administrator','operator','support','billing'));
ALTER TABLE agentonic.workspaces ADD CHECK (kind IN ('personal','organization'));
ALTER TABLE agentonic.workspaces ADD CHECK (status IN ('active','suspended','closing','closed'));
ALTER TABLE agentonic.workspaces ADD CHECK ((kind='personal' AND personal_owner_user_id IS NOT NULL) OR (kind='organization' AND personal_owner_user_id IS NULL));
ALTER TABLE agentonic.workspace_members ADD CHECK (role IN ('owner','admin','member','viewer'));
ALTER TABLE agentonic.workspace_members ADD CHECK (status IN ('active','suspended','removed'));

-- No public API roles or worker access. App roles have SELECT only in this slice.
REVOKE ALL ON SCHEMA agentonic FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA agentonic FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA agentonic REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA agentonic REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA agentonic TO agentonic_admin, agentonic_customer;
GRANT SELECT ON agentonic.users, agentonic.platform_staff, agentonic.workspaces, agentonic.workspace_members TO agentonic_admin, agentonic_customer;

CREATE FUNCTION agentonic.actor_id() RETURNS uuid LANGUAGE sql STABLE SET search_path = '' AS $$
 SELECT nullif(pg_catalog.current_setting('agentonic.auth_user_id', true), '')::uuid
$$;
CREATE FUNCTION agentonic.workspace_id() RETURNS uuid LANGUAGE sql STABLE SET search_path = '' AS $$
 SELECT nullif(pg_catalog.current_setting('agentonic.workspace_id', true), '')::uuid
$$;
-- Owner-executed helpers bypass owner-table RLS to avoid policy recursion. Runtime roles
-- cannot replace functions, own tables, inherit owner rights, or set role to the owner.
CREATE FUNCTION agentonic.actor_user_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT id FROM agentonic.users WHERE auth_user_id=agentonic.actor_id() AND deleted_at IS NULL
$$;
CREATE FUNCTION agentonic.authorized_workspace_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT m.workspace_id FROM agentonic.workspace_members m
 JOIN agentonic.workspaces w ON w.id=m.workspace_id
 WHERE m.user_id=agentonic.actor_user_id() AND m.status='active' AND m.removed_at IS NULL
 AND w.status='active' AND w.deleted_at IS NULL
$$;
CREATE FUNCTION agentonic.can_read_workspace(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
 SELECT target=agentonic.workspace_id() AND target IN (SELECT agentonic.authorized_workspace_ids())
$$;
ALTER TABLE agentonic.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentonic.platform_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentonic.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentonic.workspace_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY self ON agentonic.users FOR SELECT TO agentonic_admin, agentonic_customer
 USING (auth_user_id=agentonic.actor_id() AND deleted_at IS NULL);
CREATE POLICY self ON agentonic.platform_staff FOR SELECT TO agentonic_admin, agentonic_customer
 USING (user_id=agentonic.actor_user_id() AND disabled_at IS NULL);
CREATE POLICY member ON agentonic.workspaces FOR SELECT TO agentonic_admin, agentonic_customer
 USING (agentonic.can_read_workspace(id));
CREATE POLICY self_member ON agentonic.workspace_members FOR SELECT TO agentonic_admin, agentonic_customer
 USING (agentonic.can_read_workspace(workspace_id) AND user_id=agentonic.actor_user_id() AND status='active' AND removed_at IS NULL);

CREATE FUNCTION agentonic.validate_workspace() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE key text; value jsonb;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=NEW.timezone) THEN
  RAISE EXCEPTION 'Invalid workspace timezone';
 END IF;
 IF pg_catalog.jsonb_typeof(NEW.retention_policy) <> 'object' OR
    (SELECT count(*) FROM pg_catalog.jsonb_object_keys(NEW.retention_policy)) <> 7 THEN
  RAISE EXCEPTION 'Finite retention policy required';
 END IF;
 FOREACH key IN ARRAY ARRAY['conversationsDays','checkpointsDays','memoryDays','sourcesDays','logsDays','auditDays','backupsDays'] LOOP
  value := NEW.retention_policy->key;
  IF value IS NULL OR pg_catalog.jsonb_typeof(value) <> 'number' OR (value::text)::numeric < 1 OR
    (value::text)::numeric > 3650 OR (value::text)::numeric <> trunc((value::text)::numeric) THEN
   RAISE EXCEPTION 'Invalid retention duration';
  END IF;
 END LOOP;
 IF TG_OP='UPDATE' THEN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind OR
    NEW.personal_owner_user_id IS DISTINCT FROM OLD.personal_owner_user_id THEN
   RAISE EXCEPTION 'Workspace identity is immutable';
  END IF;
  NEW.updated_at := now();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_workspace BEFORE INSERT OR UPDATE ON agentonic.workspaces FOR EACH ROW EXECUTE FUNCTION agentonic.validate_workspace();

CREATE FUNCTION agentonic.lock_membership_workspace() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
  RAISE EXCEPTION 'Membership identity is immutable';
 END IF;
 IF TG_OP='DELETE' THEN
  PERFORM 1 FROM agentonic.workspaces WHERE id=OLD.workspace_id FOR UPDATE;
  RETURN OLD;
 END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=NEW.workspace_id FOR UPDATE;
 RETURN NEW;
END $$;
CREATE TRIGGER lock_membership_workspace BEFORE INSERT OR UPDATE OR DELETE ON agentonic.workspace_members FOR EACH ROW EXECUTE FUNCTION agentonic.lock_membership_workspace();

CREATE FUNCTION agentonic.check_workspace_owner() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE target uuid; w agentonic.workspaces;
BEGIN
 IF TG_TABLE_NAME='workspaces' THEN target := NEW.id;
 ELSIF TG_OP='DELETE' THEN target := OLD.workspace_id;
 ELSE target := NEW.workspace_id; END IF;
 SELECT * INTO w FROM agentonic.workspaces WHERE id=target FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF w.status='active' AND NOT EXISTS (SELECT 1 FROM agentonic.workspace_members m JOIN agentonic.users u ON u.id=m.user_id
  WHERE m.workspace_id=target AND m.role='owner' AND m.status='active' AND m.removed_at IS NULL AND u.deleted_at IS NULL) THEN
  RAISE EXCEPTION 'An active workspace requires an active owner';
 END IF;
 IF w.kind='personal' AND EXISTS (SELECT 1 FROM agentonic.workspace_members WHERE workspace_id=target
   AND (user_id<>w.personal_owner_user_id OR role<>'owner')) THEN
  RAISE EXCEPTION 'Personal workspace membership is restricted to its owner';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER workspace_owner AFTER INSERT OR UPDATE ON agentonic.workspaces DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agentonic.check_workspace_owner();
CREATE CONSTRAINT TRIGGER member_owner AFTER INSERT OR UPDATE OR DELETE ON agentonic.workspace_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agentonic.check_workspace_owner();

-- Erasure/offboarding is not exposed yet; do not permit an administrative identity
-- update to orphan active ownership in the meantime.
CREATE FUNCTION agentonic.protect_user_identity() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR (NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id AND NEW.auth_user_id IS NOT NULL) THEN
  RAISE EXCEPTION 'User identity is immutable';
 END IF;
 IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND EXISTS
  (SELECT 1 FROM agentonic.workspace_members m JOIN agentonic.workspaces w ON w.id=m.workspace_id
   WHERE m.user_id=OLD.id AND m.status='active' AND w.status='active') THEN
  RAISE EXCEPTION 'Offboard active memberships before erasure';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_user_identity BEFORE UPDATE ON agentonic.users FOR EACH ROW EXECUTE FUNCTION agentonic.protect_user_identity();
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA agentonic FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION agentonic.actor_id(), agentonic.workspace_id(), agentonic.actor_user_id(), agentonic.authorized_workspace_ids(), agentonic.can_read_workspace(uuid) TO agentonic_admin, agentonic_customer;
