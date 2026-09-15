-- Supabase owns Auth. Only the migration authority can call this narrow bridge;
-- application roles receive no Auth-table access or arbitrary identity lookup.
CREATE OR REPLACE FUNCTION agentonic_bootstrap.review_user_email(target_auth_user uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT email FROM auth.users
 WHERE id=target_auth_user AND deleted_at IS NULL AND email_confirmed_at IS NOT NULL
$$;
REVOKE ALL ON FUNCTION agentonic_bootstrap.review_user_email(uuid) FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker;
GRANT EXECUTE ON FUNCTION agentonic_bootstrap.review_user_email(uuid) TO agentonic_migrator;
