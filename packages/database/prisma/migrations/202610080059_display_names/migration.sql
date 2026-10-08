-- People choose their own name (outstanding action N7, owner request,
-- 8 October 2026). Until now everyone who joined by invitation was stored as
-- "Miembro". A person sets their name when accepting an invitation and can
-- change it in Mi cuenta; this function changes only the caller's own name.
-- Rules match the shared contract: trimmed, 1 to 120 characters, no control
-- characters. An invalid name changes nothing and returns false.
CREATE FUNCTION agentonic.set_display_name(name text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE clean text:=btrim(name);
BEGIN
 IF agentonic.application_role() NOT IN ('agentonic_admin','agentonic_customer') OR agentonic.actor_id() IS NULL THEN RAISE insufficient_privilege; END IF;
 IF clean IS NULL OR length(clean) NOT BETWEEN 1 AND 120 OR clean ~ '[[:cntrl:]]' THEN RETURN false; END IF;
 UPDATE agentonic.users SET display_name=clean WHERE auth_user_id=agentonic.actor_id() AND deleted_at IS NULL;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION agentonic.set_display_name(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION agentonic.set_display_name(text) TO agentonic_admin,agentonic_customer;
