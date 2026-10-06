BEGIN;
-- Invite-only accounts (architecture section 54). Supabase Auth calls this
-- "before user created" hook for every new account; it allows one only when the
-- email has a live workspace invitation: not accepted, not revoked, not expired.
-- Everyone else is refused before an account or an email exists. Existing
-- accounts are unaffected. The owner enables the hook in the Supabase dashboard
-- (Authentication > Hooks > Before User Created > this function).
CREATE FUNCTION agentonic.auth_before_user_created(event jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE email text:=lower(btrim(coalesce(event->'user'->>'email','')));
BEGIN
 IF email<>'' AND EXISTS(SELECT 1 FROM agentonic.workspace_invitations i JOIN agentonic.workspaces w ON w.id=i.workspace_id
  WHERE i.email_normalized=email AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>clock_timestamp()
   AND w.status='active' AND w.deleted_at IS NULL) THEN
  RETURN '{}'::jsonb;
 END IF;
 RETURN jsonb_build_object('error',jsonb_build_object('http_code',403,
  'message','Agentonic solo crea cuentas por invitación. Pide a tu equipo que te invite.'));
END $$;
REVOKE ALL ON FUNCTION agentonic.auth_before_user_created(jsonb) FROM PUBLIC,anon,authenticated,service_role;
DO $$ BEGIN
 -- Supabase's Auth server runs hooks as supabase_auth_admin; plain PostgreSQL
 -- (tests) has no such role, so the grant applies only where it exists.
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='supabase_auth_admin') THEN
  GRANT USAGE ON SCHEMA agentonic TO supabase_auth_admin;
  GRANT EXECUTE ON FUNCTION agentonic.auth_before_user_created(jsonb) TO supabase_auth_admin;
 END IF;
END $$;
COMMIT;
