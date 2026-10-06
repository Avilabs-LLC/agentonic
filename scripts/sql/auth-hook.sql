-- Supabase's dashboard lists hook functions from the public schema only, which
-- the migration role cannot write to. This wrapper, installed once by
-- `pnpm setup:auth-hook` with the bootstrap role, only calls the reviewed hook
-- in migration 49 (architecture §54). Only Supabase Auth may run it; it is
-- refused to the API roles even though public is exposed through the Data API.
CREATE OR REPLACE FUNCTION public.agentonic_before_user_created(event jsonb)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT agentonic.auth_before_user_created(event)
$$;
REVOKE ALL ON FUNCTION public.agentonic_before_user_created(jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agentonic_before_user_created(jsonb) TO supabase_auth_admin;
