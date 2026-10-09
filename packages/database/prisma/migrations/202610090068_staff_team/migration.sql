BEGIN;
-- Agentonic's team in Admin (architecture §63, owner decisions, 9 October 2026).
-- Staff accounts were created only from the Mac, with the sign-up hook turned
-- off, and the team was a read-only card on Espacios de trabajo. Now the Admin
-- app has an Equipo page. Every active staff member sees who is on the team;
-- administrators also see emails and invitations, invite people by email link
-- as Administración, Operación or Soporte, change roles, and deactivate or
-- reactivate people. Nobody changes or deactivates themselves, so the acting
-- administrator always remains one. "billing" stays allowed by the table but is
-- never offered: nothing uses it.
--
-- Invitations work like workspace invitations (§54): a 256-bit token stored as
-- its hash, valid up to 7 days, accepted only by the invited, verified email,
-- and only while the inviter is still an active administrator. Every change is
-- recorded in staff_events, which never holds an email or a token.

CREATE TABLE agentonic.staff_invitations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 email_normalized text NOT NULL CHECK(email_normalized=lower(btrim(email_normalized)) AND length(email_normalized) BETWEEN 3 AND 320 AND position('@' IN email_normalized)>1),
 role text NOT NULL CHECK(role IN ('administrator','operator','support')),
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 invited_by_staff_id uuid NOT NULL REFERENCES agentonic.platform_staff(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 expires_at timestamptz NOT NULL,
 accepted_at timestamptz,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(expires_at>created_at AND NOT(accepted_at IS NOT NULL AND revoked_at IS NOT NULL))
);
CREATE INDEX staff_invitations_live ON agentonic.staff_invitations(email_normalized) WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE agentonic.staff_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_user_id uuid NOT NULL REFERENCES agentonic.users(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 action text NOT NULL CHECK(action IN ('invite.issue','invite.revoke','invite.accept','staff.role','staff.disable','staff.enable','denied')),
 staff_id uuid REFERENCES agentonic.platform_staff(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 invitation_id uuid REFERENCES agentonic.staff_invitations(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
 details jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(details)='object'),
 request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX staff_events_created ON agentonic.staff_events(created_at);
CREATE FUNCTION agentonic.staff_events_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 RAISE EXCEPTION 'Immutable history';
END $$;
CREATE TRIGGER staff_events_immutable BEFORE UPDATE OR DELETE ON agentonic.staff_events FOR EACH ROW EXECUTE FUNCTION agentonic.staff_events_immutable();

-- Functions only: no application role reads or writes these tables directly.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['staff_invitations','staff_events'] LOOP
  EXECUTE format('ALTER TABLE agentonic.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON agentonic.%I FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure,agentonic_deployer_local,agentonic_deployer_azure,agentonic_runtime_local,agentonic_runtime_azure',t);
 END LOOP;
END $$;

-- The Equipo page's one entry point, for the Admin app only.
--   team.list     any active staff: the team; emails and invitations for administrators
--   invite.issue  administrators: record an invitation (the app emails the link)
--   invite.revoke administrators: withdraw a pending invitation
--   invite.accept the invited, verified email: join the team with the invited role
--   staff.update  administrators: change another person's role, or (de)activate them
CREATE FUNCTION agentonic.staff_command(operation text, payload jsonb, trace_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_column
DECLARE
 actor uuid; me agentonic.platform_staff; target agentonic.platform_staff; invitation agentonic.staff_invitations;
 administrator boolean:=false; verified text:=agentonic.verified_email(); invited_email text; chosen_role text; expiry timestamptz;
 expected_keys text[]; result jsonb; result_id uuid; event_action text; event_staff uuid; event_invitation uuid;
 details jsonb:='{}'::jsonb; withdrawn int;
BEGIN
 IF agentonic.application_role()<>'agentonic_admin' OR agentonic.actor_id() IS NULL OR trace_id IS NULL THEN
  RAISE insufficient_privilege USING MESSAGE='Access denied';
 END IF;
 -- One team change at a time. Authority is read after the lock (READ COMMITTED),
 -- so two administrators can't demote or deactivate each other at the same moment.
 PERFORM pg_advisory_xact_lock(hashtext('agentonic.staff_command'));
 actor:=agentonic.actor_user_id();
 SELECT s.* INTO me FROM agentonic.platform_staff s JOIN agentonic.users u ON u.id=s.user_id
  WHERE s.user_id=actor AND s.disabled_at IS NULL AND s.role IN ('administrator','operator','support') AND u.deleted_at IS NULL;
 administrator:=coalesce(me.role='administrator',false);
 BEGIN
  expected_keys:=CASE operation
   WHEN 'team.list' THEN ARRAY[]::text[]
   WHEN 'invite.issue' THEN ARRAY['email','role','tokenHash','expiresAt']
   WHEN 'invite.revoke' THEN ARRAY['invitationId']
   WHEN 'invite.accept' THEN ARRAY['tokenHash']
   WHEN 'staff.update' THEN ARRAY['staffId','role','active']
   ELSE NULL END;
  IF expected_keys IS NULL OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(payload) k WHERE NOT k=ANY(expected_keys)) THEN
   RAISE insufficient_privilege USING MESSAGE='Access denied';
  END IF;
  IF (operation<>'invite.accept' AND me.id IS NULL) OR (operation IN ('invite.issue','invite.revoke','staff.update') AND NOT administrator) THEN
   RAISE insufficient_privilege USING MESSAGE='Access denied';
  END IF;
  IF operation='team.list' THEN
   RETURN jsonb_build_object('ok',true,'id',me.id,'data',jsonb_build_object(
    'viewer',jsonb_build_object('staffId',me.id,'role',me.role),
    'staff',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'name',u.display_name,'email',CASE WHEN administrator THEN u.email END,'role',s.role,
      'status',CASE WHEN s.disabled_at IS NULL THEN 'active' ELSE 'disabled' END,'since',s.created_at)
     ORDER BY s.disabled_at IS NOT NULL,u.display_name,s.id)
     FROM agentonic.platform_staff s JOIN agentonic.users u ON u.id=s.user_id WHERE u.deleted_at IS NULL),'[]'::jsonb),
    'invitations',CASE WHEN administrator THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id',i.id,'email',i.email_normalized,'role',i.role,
      'expiresAt',i.expires_at,'acceptedAt',i.accepted_at,'revokedAt',i.revoked_at) ORDER BY i.created_at,i.id)
     FROM agentonic.staff_invitations i),'[]'::jsonb) END));
  ELSIF operation='invite.issue' THEN
   invited_email:=lower(btrim(payload->>'email')); chosen_role:=payload->>'role'; expiry:=(payload->>'expiresAt')::timestamptz;
   IF chosen_role IS NULL OR chosen_role NOT IN ('administrator','operator','support') OR expiry IS NULL OR expiry<=clock_timestamp() OR expiry>clock_timestamp()+interval '7 days' OR
    EXISTS(SELECT 1 FROM agentonic.platform_staff s JOIN agentonic.users u ON u.id=s.user_id WHERE u.email=invited_email AND s.disabled_at IS NULL AND u.deleted_at IS NULL) THEN
    RAISE insufficient_privilege USING MESSAGE='Access denied';
   END IF;
   UPDATE agentonic.staff_invitations SET revoked_at=clock_timestamp() WHERE email_normalized=invited_email AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at<=clock_timestamp();
   INSERT INTO agentonic.staff_invitations(email_normalized,role,token_hash,invited_by_staff_id,expires_at)
    VALUES(invited_email,chosen_role,payload->>'tokenHash',me.id,expiry) RETURNING id INTO result_id;
   event_action:=operation; event_invitation:=result_id; details:=jsonb_build_object('role',chosen_role);
  ELSIF operation='invite.revoke' THEN
   UPDATE agentonic.staff_invitations SET revoked_at=clock_timestamp()
    WHERE id=(payload->>'invitationId')::uuid AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id INTO result_id;
   IF result_id IS NULL THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   event_action:=operation; event_invitation:=result_id;
  ELSIF operation='invite.accept' THEN
   IF verified IS NULL OR EXISTS(SELECT 1 FROM agentonic.users WHERE auth_user_id=agentonic.actor_id() AND deleted_at IS NOT NULL) OR
    EXISTS(SELECT 1 FROM agentonic.platform_staff WHERE user_id=actor AND disabled_at IS NULL) THEN
    RAISE insufficient_privilege USING MESSAGE='Access denied';
   END IF;
   SELECT * INTO invitation FROM agentonic.staff_invitations WHERE token_hash=payload->>'tokenHash' FOR UPDATE;
   IF NOT FOUND OR invitation.accepted_at IS NOT NULL OR invitation.revoked_at IS NOT NULL OR invitation.expires_at<=clock_timestamp() OR
    invitation.email_normalized IS DISTINCT FROM verified OR
    NOT EXISTS(SELECT 1 FROM agentonic.platform_staff s JOIN agentonic.users u ON u.id=s.user_id
     WHERE s.id=invitation.invited_by_staff_id AND s.role='administrator' AND s.disabled_at IS NULL AND u.deleted_at IS NULL) THEN
    RAISE insufficient_privilege USING MESSAGE='Access denied';
   END IF;
   -- A first-time person gets the placeholder name; the app sets the chosen one
   -- in the same transaction (set_display_name), or nothing is accepted.
   IF actor IS NULL THEN
    INSERT INTO agentonic.users(auth_user_id,display_name,email) VALUES(agentonic.actor_id(),'Miembro',verified) ON CONFLICT(auth_user_id) DO NOTHING;
    actor:=agentonic.actor_user_id();
    IF actor IS NULL THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   END IF;
   -- Someone deactivated earlier comes back with the invited role.
   INSERT INTO agentonic.platform_staff(user_id,role) VALUES(actor,invitation.role)
    ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,disabled_at=NULL RETURNING id INTO result_id;
   UPDATE agentonic.staff_invitations SET accepted_at=clock_timestamp() WHERE id=invitation.id;
   event_action:=operation; event_staff:=result_id; event_invitation:=invitation.id; details:=jsonb_build_object('role',invitation.role);
  ELSIF operation='staff.update' THEN
   SELECT * INTO target FROM agentonic.platform_staff WHERE id=(payload->>'staffId')::uuid FOR UPDATE;
   IF NOT FOUND OR target.id=me.id OR (payload ? 'role')=(payload ? 'active') THEN RAISE insufficient_privilege USING MESSAGE='Access denied'; END IF;
   IF payload ? 'role' THEN
    chosen_role:=payload->>'role';
    IF chosen_role IS NULL OR chosen_role NOT IN ('administrator','operator','support') OR chosen_role=target.role OR target.disabled_at IS NOT NULL THEN
     RAISE insufficient_privilege USING MESSAGE='Access denied';
    END IF;
    UPDATE agentonic.platform_staff SET role=chosen_role WHERE id=target.id;
    event_action:='staff.role'; details:=jsonb_build_object('role',chosen_role,'previousRole',target.role);
   ELSE
    IF jsonb_typeof(payload->'active') IS DISTINCT FROM 'boolean' OR (payload->>'active')::boolean=(target.disabled_at IS NULL) THEN
     RAISE insufficient_privilege USING MESSAGE='Access denied';
    END IF;
    UPDATE agentonic.platform_staff SET disabled_at=CASE WHEN (payload->>'active')::boolean THEN NULL ELSE clock_timestamp() END WHERE id=target.id;
    event_action:=CASE WHEN (payload->>'active')::boolean THEN 'staff.enable' ELSE 'staff.disable' END;
   END IF;
   -- Someone who is no longer an active administrator can't leave live invitations behind.
   IF event_action='staff.disable' OR (event_action='staff.role' AND target.role='administrator') THEN
    UPDATE agentonic.staff_invitations SET revoked_at=clock_timestamp() WHERE invited_by_staff_id=target.id AND accepted_at IS NULL AND revoked_at IS NULL;
    GET DIAGNOSTICS withdrawn=ROW_COUNT;
    IF withdrawn>0 THEN details:=details||jsonb_build_object('withdrawnInvitations',withdrawn); END IF;
   END IF;
   result_id:=target.id; event_staff:=target.id;
  END IF;
  INSERT INTO agentonic.staff_events(actor_user_id,action,staff_id,invitation_id,details,request_id)
   VALUES(actor,event_action,event_staff,event_invitation,details,trace_id);
  RETURN jsonb_build_object('ok',true,'id',result_id,'data',NULL);
 EXCEPTION WHEN insufficient_privilege THEN
  -- The subtransaction rolls back any partial writes before this safe denial event.
  -- Never persist payloads, emails, tokens or names.
  IF me.id IS NOT NULL THEN
   INSERT INTO agentonic.staff_events(actor_user_id,action,details,request_id)
    VALUES(me.user_id,'denied',jsonb_build_object('operation',CASE WHEN operation IN ('team.list','invite.issue','invite.revoke','invite.accept','staff.update') THEN operation ELSE 'unknown' END),trace_id);
  END IF;
  RETURN jsonb_build_object('ok',false);
 END;
END $$;
REVOKE ALL ON FUNCTION agentonic.staff_command(text,jsonb,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION agentonic.staff_command(text,jsonb,uuid) TO agentonic_admin;

-- The sign-up hook (migration 49) also lets a live staff invitation create an account.
CREATE OR REPLACE FUNCTION agentonic.auth_before_user_created(event jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE email text:=lower(btrim(coalesce(event->'user'->>'email','')));
BEGIN
 IF email<>'' AND (EXISTS(SELECT 1 FROM agentonic.workspace_invitations i JOIN agentonic.workspaces w ON w.id=i.workspace_id
  WHERE i.email_normalized=email AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>clock_timestamp()
   AND w.status='active' AND w.deleted_at IS NULL)
  OR EXISTS(SELECT 1 FROM agentonic.staff_invitations i
  WHERE i.email_normalized=email AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>clock_timestamp())) THEN
  RETURN '{}'::jsonb;
 END IF;
 RETURN jsonb_build_object('error',jsonb_build_object('http_code',403,
  'message','Agentonic solo crea cuentas por invitación. Pide a tu equipo que te invite.'));
END $$;

-- operations_workspaces keeps returning the team: platform 0.36.0 reads it, and
-- it runs until 0.37.0 is installed (and again after a rollback). 0.37.0 ignores
-- it and reads team.list; a later migration may drop it.
COMMIT;
