-- Scheduled jobs (architecture §58, owner request and direction, 8 October 2026).
-- A member schedules an instruction for an agent whose deployment they
-- authorized. At each due time the knowledge worker's tick queues an ordinary
-- turn in the schedule's own conversation on that running deployment, which
-- wakes a resting agent as a chat message would. Missed times collapse into one
-- run. Agents still only propose Gmail writes, and a proposal still ends its
-- turn. Owner direction: until a channel such as Slack can reach the person for
-- a confirmation, a schedule may pre-authorize write operations when it is
-- saved; the platform then executes the one write a run proposes, if the
-- schedule authorized that operation, outside the model, through the same
-- pending, executing and finished states, never retried. Every other proposal
-- waits for the person as before, and the person may cancel a pre-authorized
-- one until it starts.

CREATE TABLE agentonic.agent_schedules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES agentonic.workspaces(id),
 agent_id uuid NOT NULL,
 member_id uuid NOT NULL,
 request_id uuid NOT NULL,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 60),
 instruction text NOT NULL CHECK(length(btrim(instruction)) BETWEEN 1 AND 600),
 cadence text NOT NULL CHECK(cadence IN ('daily','weekdays','weekly','hours')),
 time_of_day time NOT NULL,
 weekday smallint CHECK(weekday BETWEEN 1 AND 7),
 every_hours smallint CHECK(every_hours BETWEEN 1 AND 24),
 timezone text NOT NULL,
 model text NOT NULL,
 reasoning text,
 autonomy jsonb NOT NULL DEFAULT '[]',
 consent jsonb,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','deleted')),
 next_run_at timestamptz,
 last_run_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,id),
 UNIQUE(member_id,request_id),
 FOREIGN KEY(workspace_id,agent_id) REFERENCES agentonic.agents(workspace_id,id),
 FOREIGN KEY(workspace_id,member_id) REFERENCES agentonic.workspace_members(workspace_id,id),
 CHECK((cadence='weekly')=(weekday IS NOT NULL)),
 CHECK((cadence='hours')=(every_hours IS NOT NULL)),
 CHECK(agentonic.valid_model_configuration(model,reasoning) AND model<>'gpt-4.1-mini-2025-04-14'),
 CHECK(jsonb_typeof(autonomy)='array' AND autonomy <@ '["gmail.drafts.create","gmail.drafts.update","gmail.drafts.delete","gmail.send"]'::jsonb),
 -- Pre-authorizing writes needs the person's recorded consent for exactly those writes.
 CHECK(autonomy='[]' OR (jsonb_typeof(consent)='object' AND consent->'operations'=autonomy)),
 CHECK((status='active')=(next_run_at IS NOT NULL))
);
CREATE INDEX agent_schedules_due ON agentonic.agent_schedules(next_run_at) WHERE status='active';
CREATE TABLE agentonic.agent_schedule_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL,
 schedule_id uuid NOT NULL,
 scheduled_for timestamptz NOT NULL,
 manual boolean NOT NULL DEFAULT false,
 status text NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled','skipped')),
 reason text CHECK(reason IS NULL OR reason IN ('no_deployment','offline','busy','turn_limit','member_inactive','agent_unavailable')),
 deployment_id uuid,
 conversation_id uuid,
 turn_id uuid UNIQUE,
 actions_approved integer NOT NULL DEFAULT 0 CHECK(actions_approved BETWEEN 0 AND 1),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,schedule_id) REFERENCES agentonic.agent_schedules(workspace_id,id),
 CHECK((status='skipped')=(turn_id IS NULL)),
 CHECK((status='skipped')=(reason IS NOT NULL))
);
CREATE INDEX agent_schedule_runs_schedule ON agentonic.agent_schedule_runs(schedule_id,created_at DESC);
ALTER TABLE agentonic.staging_conversations ADD COLUMN schedule_id uuid;
ALTER TABLE agentonic.staging_conversations ADD CONSTRAINT staging_conversations_schedule FOREIGN KEY(workspace_id,schedule_id) REFERENCES agentonic.agent_schedules(workspace_id,id);
ALTER TABLE agentonic.gmail_invocations ADD COLUMN approved_by_schedule_id uuid REFERENCES agentonic.agent_schedules(id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['agent_schedules','agent_schedule_runs'] LOOP
  EXECUTE format('ALTER TABLE agentonic.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON agentonic.%I FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure,agentonic_deployer_local,agentonic_deployer_azure,agentonic_runtime_local,agentonic_runtime_azure',t);
 END LOOP;
END $$;

-- The next due time after `after`, in the schedule's own timezone. "hours" runs
-- at time_of_day and every N hours after it within each day.
CREATE FUNCTION agentonic.schedule_next(cadence text,at_time time,weekday smallint,every_hours smallint,tz text,after timestamptz) RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path='' AS $$
DECLARE here timestamp:=after AT TIME ZONE tz; today date:=(after AT TIME ZONE tz)::date; candidate timestamp; i integer;
BEGIN
 IF cadence='hours' THEN
  FOR i IN 0..24 LOOP
   candidate:=today+at_time+make_interval(hours=>i*every_hours);
   EXIT WHEN candidate>=today+1;
   IF candidate>here THEN RETURN candidate AT TIME ZONE tz; END IF;
  END LOOP;
  RETURN ((today+1)+at_time) AT TIME ZONE tz;
 END IF;
 FOR i IN 0..8 LOOP
  candidate:=(today+i)+at_time;
  IF candidate>here AND (cadence='daily' OR (cadence='weekdays' AND extract(isodow FROM today+i) BETWEEN 1 AND 5) OR (cadence='weekly' AND extract(isodow FROM today+i)=weekday)) THEN
   RETURN candidate AT TIME ZONE tz;
  END IF;
 END LOOP;
 RAISE insufficient_privilege;
END $$;

CREATE FUNCTION agentonic.schedule_message(s agentonic.agent_schedules) RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT 'Programación «'||btrim(s.name)||'»: '||btrim(s.instruction)||E'\n\nSe ejecuta sin una persona presente: hazlo con lo disponible y no hagas preguntas.'||
 CASE WHEN s.autonomy='[]' THEN ' Los cambios en el correo quedarán pendientes de confirmación.'
 ELSE ' Esta programación autorizó ejecutar sin otra confirmación una acción por vez: '||
  (SELECT string_agg(CASE op WHEN 'gmail.send' THEN 'enviar un correo' WHEN 'gmail.drafts.create' THEN 'crear un borrador' WHEN 'gmail.drafts.update' THEN 'editar un borrador' ELSE 'eliminar un borrador' END,', ' ORDER BY op)
   FROM jsonb_array_elements_text(s.autonomy) op)||'.' END
$$;

-- Queues one run of a schedule on its member's running deployment, or records
-- why it was skipped. Callers hold the schedule's row lock.
CREATE FUNCTION agentonic.schedule_launch(s agentonic.agent_schedules,slot timestamptz,manual boolean) RETURNS agentonic.agent_schedule_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d agentonic.deployments; c agentonic.staging_conversations; r agentonic.agent_schedule_runs; models jsonb; choice jsonb; n integer; skip text; run_id uuid:=gen_random_uuid(); turn uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM agentonic.workspace_members m JOIN agentonic.workspaces w ON w.id=m.workspace_id WHERE m.id=s.member_id AND m.status='active' AND m.removed_at IS NULL AND w.status='active' AND w.deleted_at IS NULL) THEN skip:='member_inactive';
 ELSIF NOT EXISTS(SELECT 1 FROM agentonic.agents a WHERE a.id=s.agent_id AND a.status<>'archived') THEN skip:='agent_unavailable';
 ELSE
  SELECT * INTO d FROM agentonic.deployments dep WHERE dep.workspace_id=s.workspace_id AND dep.agent_id=s.agent_id AND dep.authorized_by_member_id=s.member_id
   AND dep.status='running' AND agentonic.deployment_authorized(dep) ORDER BY dep.activated_at DESC NULLS LAST,dep.created_at DESC LIMIT 1;
  IF d.id IS NULL THEN skip:='no_deployment';
  ELSIF NOT agentonic.deployment_online(d) THEN skip:='offline';
  END IF;
 END IF;
 IF skip IS NULL THEN
  -- One conversation per schedule and deployment, renewed when it fills or ends.
  SELECT * INTO c FROM agentonic.staging_conversations sc WHERE sc.schedule_id=s.id AND sc.deployment_id=d.id AND sc.closed_at IS NULL AND sc.expires_at>clock_timestamp()+interval '5 minutes'
   AND (SELECT count(*) FROM agentonic.staging_turns t WHERE t.conversation_id=sc.id)<100 AND agentonic.staging_conversation_authorized(sc) ORDER BY sc.created_at DESC LIMIT 1 FOR UPDATE;
  IF c.id IS NULL THEN
   INSERT INTO agentonic.staging_conversations(workspace_id,agent_id,deployment_id,owner_member_id,title,expires_at,schedule_id)
   VALUES(s.workspace_id,s.agent_id,d.id,s.member_id,'Programación: '||btrim(s.name),
    least(d.authorized_until,clock_timestamp()+least(7,(SELECT (retention_policy->>'conversationsDays')::int FROM agentonic.workspaces WHERE id=s.workspace_id))*interval '1 day'),s.id) RETURNING * INTO c;
  END IF;
  IF NOT agentonic.staging_conversation_authorized(c) THEN skip:='no_deployment';
  ELSIF EXISTS(SELECT 1 FROM agentonic.staging_turns t WHERE t.conversation_id=c.id AND t.status IN ('queued','running')) THEN skip:='busy';
  END IF;
 END IF;
 IF skip IS NOT NULL THEN
  INSERT INTO agentonic.agent_schedule_runs(id,workspace_id,schedule_id,scheduled_for,manual,status,reason,deployment_id,conversation_id,finished_at)
  VALUES(run_id,s.workspace_id,s.id,slot,manual,'skipped',skip,d.id,c.id,clock_timestamp()) RETURNING * INTO r;
  RETURN r;
 END IF;
 -- The schedule's model when the approved version allows it, else the deployment's first.
 models:=agentonic.deployment_models(d);
 choice:=CASE WHEN models @> jsonb_build_array(jsonb_build_object('model',s.model,'reasoning',s.reasoning)) THEN jsonb_build_object('model',s.model,'reasoning',s.reasoning) ELSE models->0 END;
 SELECT coalesce(max(number),0)+1 INTO n FROM agentonic.staging_turns WHERE conversation_id=c.id;
 INSERT INTO agentonic.staging_turns(workspace_id,conversation_id,request_id,number,query,response_model,reasoning_effort)
 VALUES(s.workspace_id,c.id,run_id,n,agentonic.schedule_message(s),choice->>'model',choice->>'reasoning') RETURNING id INTO turn;
 INSERT INTO agentonic.agent_schedule_runs(id,workspace_id,schedule_id,scheduled_for,manual,status,deployment_id,conversation_id,turn_id)
 VALUES(run_id,s.workspace_id,s.id,slot,manual,'queued',d.id,c.id,turn) RETURNING * INTO r;
 RETURN r;
END $$;

-- A run follows its turn.
CREATE FUNCTION agentonic.schedule_run_sync() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 UPDATE agentonic.agent_schedule_runs SET status=NEW.status,finished_at=CASE WHEN NEW.status IN ('succeeded','failed','cancelled') THEN clock_timestamp() END
 WHERE turn_id=NEW.id AND status IN ('queued','running');
 RETURN NEW;
END $$;
CREATE TRIGGER schedule_run_sync AFTER UPDATE OF status ON agentonic.staging_turns FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION agentonic.schedule_run_sync();

-- A write proposed by a scheduled run is pre-authorized when the schedule
-- authorized that operation, once per run, for the schedule's own member.
CREATE FUNCTION agentonic.schedule_autonomy() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r agentonic.agent_schedule_runs; s agentonic.agent_schedules;
BEGIN
 SELECT * INTO r FROM agentonic.agent_schedule_runs WHERE turn_id=NEW.turn_id FOR UPDATE;
 IF r.id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO s FROM agentonic.agent_schedules WHERE id=r.schedule_id;
 IF s.status<>'deleted' AND s.member_id=NEW.owner_member_id AND s.autonomy ? NEW.operation AND r.actions_approved<1 AND NEW.execution_context='staging' THEN
  NEW.approved_by_schedule_id:=s.id;
  UPDATE agentonic.agent_schedule_runs SET actions_approved=actions_approved+1 WHERE id=r.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER schedule_autonomy BEFORE INSERT ON agentonic.gmail_invocations FOR EACH ROW EXECUTE FUNCTION agentonic.schedule_autonomy();

-- The knowledge worker's tick: due schedules launch one run each, and their
-- next time is computed from now, so missed times collapse into this run.
CREATE FUNCTION agentonic.schedule_tick() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s agentonic.agent_schedules; r agentonic.agent_schedule_runs; queued integer:=0; skipped integer:=0;
BEGIN
 IF agentonic.application_role()<>'agentonic_worker' THEN RAISE insufficient_privilege; END IF;
 FOR s IN SELECT * FROM agentonic.agent_schedules WHERE status='active' AND next_run_at<=clock_timestamp() ORDER BY next_run_at LIMIT 20 FOR UPDATE SKIP LOCKED LOOP
  PERFORM 1 FROM agentonic.workspaces WHERE id=s.workspace_id FOR SHARE;
  r:=agentonic.schedule_launch(s,s.next_run_at,false);
  IF r.status='skipped' THEN skipped:=skipped+1; ELSE queued:=queued+1; END IF;
  UPDATE agentonic.agent_schedules SET last_run_at=clock_timestamp(),
   next_run_at=agentonic.schedule_next(cadence,time_of_day,weekday,every_hours,timezone,clock_timestamp()) WHERE id=s.id;
 END LOOP;
 RETURN jsonb_build_object('queued',queued,'skipped',skipped);
END $$;

-- The knowledge worker's "action" lane: a pre-authorized write whose authority
-- still holds moves to executing; one that lost it is cancelled.
CREATE FUNCTION agentonic.schedule_action_claim() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE i agentonic.gmail_invocations; s agentonic.agent_schedules; conv agentonic.staging_conversations; c agentonic.gmail_connections; d agentonic.deployments; r agentonic.configuration_releases;
BEGIN
 IF agentonic.application_role()<>'agentonic_worker' THEN RAISE insufficient_privilege; END IF;
 FOR i IN SELECT * FROM agentonic.gmail_invocations WHERE approved_by_schedule_id IS NOT NULL AND status='pending' ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED LOOP
  SELECT * INTO s FROM agentonic.agent_schedules WHERE id=i.approved_by_schedule_id;
  SELECT * INTO conv FROM agentonic.staging_conversations WHERE id=i.conversation_id;
  SELECT * INTO c FROM agentonic.gmail_connections WHERE id=i.connection_id;
  SELECT * INTO d FROM agentonic.deployments WHERE id=conv.deployment_id;
  SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id;
  IF i.expires_at<=clock_timestamp() OR i.arguments_ciphertext IS NULL OR s.status='deleted' OR NOT s.autonomy ? i.operation OR s.member_id<>i.owner_member_id
   OR NOT agentonic.staging_conversation_authorized(conv) OR NOT agentonic.gmail_allowed(c,i.owner_member_id,i.agent_id,i.operation)
   OR NOT (r.requested_access_snapshot->'tools') @> jsonb_build_array(jsonb_build_object('connectionId',c.id,'operations',jsonb_build_array(i.operation))) THEN
   UPDATE agentonic.gmail_invocations SET status=CASE WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'cancelled' END,arguments_ciphertext=NULL WHERE id=i.id;
   CONTINUE;
  END IF;
  UPDATE agentonic.gmail_invocations SET status='executing',approved_at=clock_timestamp() WHERE id=i.id;
  RETURN jsonb_build_object('id',i.id,'token',gen_random_uuid(),'kind','action','lane','action','queuedAt',i.created_at,
   'connectionId',c.id,'credential',c.credential_ciphertext,'account',c.account,'operation',i.operation,'argumentsCiphertext',i.arguments_ciphertext,'hash',i.arguments_sha256);
 END LOOP;
 RETURN NULL;
END $$;
CREATE FUNCTION agentonic.schedule_action_complete(invocation uuid,outcome text,detail jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE i agentonic.gmail_invocations;
BEGIN
 IF agentonic.application_role()<>'agentonic_worker' THEN RAISE insufficient_privilege; END IF;
 SELECT * INTO i FROM agentonic.gmail_invocations WHERE id=invocation FOR UPDATE;
 IF i.id IS NULL OR i.approved_by_schedule_id IS NULL OR i.status<>'executing' OR outcome NOT IN ('succeeded','failed','uncertain') THEN RAISE insufficient_privilege; END IF;
 IF outcome='failed' AND detail->>'code'='reconnect' THEN
  UPDATE agentonic.gmail_connections SET status='reconnect',credential_ciphertext=NULL,operations='[]' WHERE id=i.connection_id;
 END IF;
 UPDATE agentonic.gmail_invocations SET status=outcome,result=detail,finished_at=clock_timestamp(),arguments_ciphertext=NULL WHERE id=i.id;
 RETURN '{"ok":true}';
END $$;

-- What the schedules tab shows its member: their schedules for the agent, each
-- with its latest runs, and the deployment a run would use now.
CREATE FUNCTION agentonic.schedule_state(target_agent uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();d agentonic.deployments;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR w IS NULL OR m IS NULL OR NOT agentonic.can_agent(target_agent,'invoke') THEN RAISE insufficient_privilege; END IF;
 SELECT * INTO d FROM agentonic.deployments dep WHERE dep.workspace_id=w AND dep.agent_id=target_agent AND dep.authorized_by_member_id=m
  AND dep.status='running' AND agentonic.deployment_authorized(dep) ORDER BY dep.activated_at DESC NULLS LAST,dep.created_at DESC LIMIT 1;
 RETURN jsonb_build_object(
  'timezone',(SELECT timezone FROM agentonic.workspaces WHERE id=w),
  'deployment',CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object('id',d.id,'online',agentonic.deployment_online(d),'authorizedUntil',d.authorized_until,'models',agentonic.deployment_models(d),
   'writes',coalesce((SELECT jsonb_agg(DISTINCT op) FROM agentonic.configuration_releases cr CROSS JOIN LATERAL jsonb_array_elements(cr.requested_access_snapshot->'tools') t CROSS JOIN LATERAL jsonb_array_elements_text(t->'operations') op
     WHERE cr.id=d.configuration_release_id AND op IN ('gmail.drafts.create','gmail.drafts.update','gmail.drafts.delete','gmail.send')),'[]'::jsonb)) END,
  'schedules',coalesce((SELECT jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'instruction',s.instruction,'cadence',s.cadence,'timeOfDay',to_char(s.time_of_day,'HH24:MI'),
   'weekday',s.weekday,'everyHours',s.every_hours,'timezone',s.timezone,'model',s.model,'reasoning',s.reasoning,'autonomy',s.autonomy,'status',s.status,
   'nextRunAt',s.next_run_at,'lastRunAt',s.last_run_at,'createdAt',s.created_at,
   'runs',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'scheduledFor',r.scheduled_for,'manual',r.manual,'status',r.status,'reason',r.reason,'conversationId',r.conversation_id,
     'actions',(SELECT coalesce(jsonb_agg(jsonb_build_object('operation',i.operation,'status',i.status,'automatic',i.approved_by_schedule_id IS NOT NULL) ORDER BY i.created_at,i.id),'[]'::jsonb) FROM agentonic.gmail_invocations i WHERE i.turn_id=r.turn_id),
     'createdAt',r.created_at,'finishedAt',r.finished_at) ORDER BY r.created_at DESC)
    FROM (SELECT * FROM agentonic.agent_schedule_runs r0 WHERE r0.schedule_id=s.id ORDER BY r0.created_at DESC LIMIT 10) r),'[]'::jsonb))
   ORDER BY s.created_at) FROM agentonic.agent_schedules s WHERE s.workspace_id=w AND s.agent_id=target_agent AND s.member_id=m AND s.status<>'deleted'),'[]'::jsonb));
END $$;

CREATE FUNCTION agentonic.schedule_command(operation text,payload jsonb,trace_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();s agentonic.agent_schedules;r agentonic.agent_schedule_runs;allowed text[];fields text[]:=ARRAY['name','instruction','cadence','timeOfDay','weekday','everyHours','timezone','model','reasoning','autonomy','consent'];
 aid uuid;autonomy jsonb;at_time time;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR agentonic.actor_user_id() IS NULL OR w IS NULL OR m IS NULL OR trace_id IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 allowed:=CASE operation WHEN 'create' THEN fields||ARRAY['agentId','requestId'] WHEN 'update' THEN fields||ARRAY['id'] WHEN 'pause' THEN ARRAY['id'] WHEN 'resume' THEN ARRAY['id'] WHEN 'delete' THEN ARRAY['id'] WHEN 'run' THEN ARRAY['id'] END;
 IF allowed IS NULL OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR payload-allowed<>'{}' OR NOT(payload ?& allowed) THEN RAISE insufficient_privilege; END IF;
 IF operation='create' THEN
  aid:=(payload->>'agentId')::uuid;
  IF NOT agentonic.can_agent(aid,'invoke') THEN RAISE insufficient_privilege; END IF;
  SELECT * INTO s FROM agentonic.agent_schedules WHERE member_id=m AND request_id=(payload->>'requestId')::uuid;
  IF s.id IS NOT NULL THEN RETURN jsonb_build_object('ok',true,'id',s.id); END IF;
  IF (SELECT count(*) FROM agentonic.agent_schedules WHERE agent_id=aid AND member_id=m AND status<>'deleted')>=10 THEN RETURN '{"ok":false,"code":"limit"}'; END IF;
 ELSE
  SELECT * INTO s FROM agentonic.agent_schedules WHERE id=(payload->>'id')::uuid AND workspace_id=w AND member_id=m AND status<>'deleted' FOR UPDATE;
  IF s.id IS NULL OR NOT agentonic.can_agent(s.agent_id,'invoke') THEN RAISE insufficient_privilege; END IF;
  aid:=s.agent_id;
 END IF;
 IF operation IN ('create','update') THEN
  autonomy:=payload->'autonomy';
  IF jsonb_typeof(autonomy) IS DISTINCT FROM 'array' OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(autonomy))<>jsonb_array_length(autonomy)
   OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=payload->>'timezone')
   OR payload->>'timeOfDay' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
   OR (autonomy<>'[]' AND payload->'consent' IS DISTINCT FROM 'true'::jsonb) THEN RAISE insufficient_privilege; END IF;
  at_time:=(payload->>'timeOfDay')::time;
  IF operation='create' THEN
   INSERT INTO agentonic.agent_schedules(workspace_id,agent_id,member_id,request_id,name,instruction,cadence,time_of_day,weekday,every_hours,timezone,model,reasoning,autonomy,consent,next_run_at)
   VALUES(w,aid,m,(payload->>'requestId')::uuid,btrim(payload->>'name'),btrim(payload->>'instruction'),payload->>'cadence',at_time,(payload->>'weekday')::smallint,(payload->>'everyHours')::smallint,
    payload->>'timezone',payload->>'model',payload->>'reasoning',autonomy,
    CASE WHEN autonomy<>'[]' THEN jsonb_build_object('version','schedule-autonomy-v1','acceptedAt',clock_timestamp(),'operations',autonomy) END,
    agentonic.schedule_next(payload->>'cadence',at_time,(payload->>'weekday')::smallint,(payload->>'everyHours')::smallint,payload->>'timezone',clock_timestamp())) RETURNING * INTO s;
  ELSE
   UPDATE agentonic.agent_schedules SET name=btrim(payload->>'name'),instruction=btrim(payload->>'instruction'),cadence=payload->>'cadence',time_of_day=at_time,
    weekday=(payload->>'weekday')::smallint,every_hours=(payload->>'everyHours')::smallint,timezone=payload->>'timezone',model=payload->>'model',reasoning=payload->>'reasoning',autonomy=autonomy,
    consent=CASE WHEN autonomy<>'[]' THEN jsonb_build_object('version','schedule-autonomy-v1','acceptedAt',clock_timestamp(),'operations',autonomy) END,
    next_run_at=CASE WHEN status='active' THEN agentonic.schedule_next(payload->>'cadence',at_time,(payload->>'weekday')::smallint,(payload->>'everyHours')::smallint,payload->>'timezone',clock_timestamp()) END,
    updated_at=clock_timestamp() WHERE id=s.id RETURNING * INTO s;
  END IF;
 ELSIF operation='pause' THEN
  UPDATE agentonic.agent_schedules SET status='paused',next_run_at=NULL,updated_at=clock_timestamp() WHERE id=s.id;
 ELSIF operation='resume' THEN
  UPDATE agentonic.agent_schedules SET status='active',next_run_at=agentonic.schedule_next(cadence,time_of_day,weekday,every_hours,timezone,clock_timestamp()),updated_at=clock_timestamp() WHERE id=s.id;
 ELSIF operation='delete' THEN
  -- History stays; pre-authorized writes not yet started are cancelled.
  UPDATE agentonic.agent_schedules SET status='deleted',next_run_at=NULL,updated_at=clock_timestamp() WHERE id=s.id;
  UPDATE agentonic.gmail_invocations SET status='cancelled',arguments_ciphertext=NULL WHERE approved_by_schedule_id=s.id AND status='pending';
 ELSE
  -- Ejecutar ahora: at most one manual run a minute.
  IF EXISTS(SELECT 1 FROM agentonic.agent_schedule_runs WHERE schedule_id=s.id AND manual AND created_at>clock_timestamp()-interval '1 minute') THEN RETURN '{"ok":false,"code":"rate_limit"}'; END IF;
  r:=agentonic.schedule_launch(s,clock_timestamp(),true);
  INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,action,resource_type,resource_id,outcome,request_id)
  VALUES(w,agentonic.actor_user_id(),m,'schedule.run','agent_schedule',s.id::text,'succeeded',trace_id::text);
  RETURN jsonb_build_object('ok',true,'id',s.id,'runId',r.id,'status',r.status,'reason',r.reason);
 END IF;
 INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,action,resource_type,resource_id,outcome,request_id)
 VALUES(w,agentonic.actor_user_id(),m,'schedule.'||operation,'agent_schedule',s.id::text,'succeeded',trace_id::text);
 RETURN jsonb_build_object('ok',true,'id',s.id);
END $$;

-- The deployed turn learns whether its write runs on the schedule's
-- authorization, so the broker's fixed answer can say so. Otherwise unchanged.
CREATE OR REPLACE FUNCTION agentonic.gmail_staging(operation text,deployment_id uuid,secret text,job_id uuid,token uuid,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE d agentonic.deployments;conv agentonic.staging_conversations;t agentonic.staging_turns;r agentonic.configuration_releases;c agentonic.gmail_connections;g jsonb;op text:=payload->>'operation';
BEGIN
 PERFORM agentonic.staging_worker('heartbeat',deployment_id,secret,job_id,token,'{}');
 SELECT * INTO d FROM agentonic.deployments WHERE id=deployment_id;
 SELECT * INTO t FROM agentonic.staging_turns WHERE id=job_id;
 SELECT * INTO conv FROM agentonic.staging_conversations WHERE id=t.conversation_id;
 SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id;
 IF NOT EXISTS(SELECT 1 FROM agentonic.code_releases WHERE id=r.code_release_id AND execution_manifest->>'gmailContract'='1') THEN RAISE insufficient_privilege; END IF;
 IF operation='gmail-tools' THEN RETURN jsonb_build_object('tools',r.requested_access_snapshot->'tools'); END IF;
 SELECT value INTO g FROM jsonb_array_elements(r.requested_access_snapshot->'tools') WHERE value->>'connectionId'=payload->>'connectionId' AND value->'operations' ? op;
 SELECT * INTO c FROM agentonic.gmail_connections WHERE id=(g->>'connectionId')::uuid AND workspace_id=d.workspace_id AND agent_id=d.agent_id FOR UPDATE;
 IF NOT agentonic.gmail_allowed(c,conv.owner_member_id,d.agent_id,op) THEN RAISE insufficient_privilege; END IF;
 IF operation='gmail-read' AND op IN ('gmail.search','gmail.read','gmail.drafts.list','gmail.drafts.read') THEN RETURN jsonb_build_object('credential',c.credential_ciphertext,'account',c.account); END IF;
 IF operation='gmail-reconnect' THEN
  UPDATE agentonic.gmail_connections SET status='reconnect',credential_ciphertext=NULL,operations='[]' WHERE id=c.id;
  UPDATE agentonic.gmail_invocations SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,arguments_ciphertext=NULL WHERE connection_id=c.id;
  RETURN '{"ok":true}';
 END IF;
 IF operation='gmail-check' THEN RETURN '{"ok":true}'; END IF;
 IF operation='gmail-propose' AND op IN ('gmail.drafts.create','gmail.drafts.update','gmail.drafts.delete','gmail.send') THEN
  IF (SELECT count(*) FROM agentonic.gmail_invocations WHERE turn_id=job_id)>=3 OR (SELECT count(*) FROM agentonic.gmail_invocations WHERE owner_member_id=conv.owner_member_id AND created_at>clock_timestamp()-interval '1 hour')>=30 THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.gmail_invocations(id,workspace_id,agent_id,connection_id,owner_member_id,turn_id,conversation_id,operation,arguments_ciphertext,arguments_sha256)
  VALUES((payload->>'id')::uuid,d.workspace_id,d.agent_id,c.id,conv.owner_member_id,job_id,conv.id,op,payload->>'argumentsCiphertext',payload->>'hash');
  RETURN jsonb_build_object('pendingApproval',true,'id',payload->>'id','automatic',(SELECT approved_by_schedule_id IS NOT NULL FROM agentonic.gmail_invocations WHERE id=(payload->>'id')::uuid));
 END IF;
 RAISE insufficient_privilege;
END $$;

-- Staging Gmail commands (gmail_command_v29 since migration 30's preview wrapper):
-- a pre-authorized write shows as automatic, and only the platform may run it;
-- the person can still cancel it until it starts. Otherwise unchanged.
CREATE OR REPLACE FUNCTION agentonic.gmail_command_v29(operation text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
#variable_conflict use_variable
DECLARE w uuid:=agentonic.workspace_id();m uuid:=agentonic.current_member();aid uuid:=(payload->>'agentId')::uuid;
 s agentonic.gmail_oauth_states;c agentonic.gmail_connections;i agentonic.gmail_invocations;conv agentonic.staging_conversations;d agentonic.deployments;r agentonic.configuration_releases;
BEGIN
 IF agentonic.application_role()<>'agentonic_customer' OR w IS NULL OR m IS NULL THEN RAISE insufficient_privilege; END IF;
 PERFORM 1 FROM agentonic.workspaces WHERE id=w AND status='active' AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
 -- Expired private proposals are erased; only content-free audit remains.
 UPDATE agentonic.gmail_invocations SET status=CASE WHEN status='pending' THEN 'expired' WHEN status='executing' THEN 'uncertain' ELSE status END,arguments_ciphertext=NULL
 WHERE workspace_id=w AND expires_at<=clock_timestamp() AND arguments_ciphertext IS NOT NULL;
 DELETE FROM agentonic.gmail_oauth_states WHERE workspace_id=w AND expires_at<clock_timestamp()-interval '1 hour';
 IF operation IN ('list','oauth.start','permissions') AND (aid IS NULL OR NOT agentonic.can_agent(aid,'edit')) THEN RAISE insufficient_privilege; END IF;
 IF operation='list' THEN
  RETURN jsonb_build_object('connections',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'account',account,'status',status,'operations',operations) ORDER BY created_at) FROM agentonic.gmail_connections WHERE workspace_id=w AND agent_id=aid AND owner_member_id=m AND status<>'disconnected'),'[]'));
 ELSIF operation='oauth.start' THEN
  IF (SELECT count(*) FROM agentonic.gmail_oauth_states WHERE owner_member_id=m AND expires_at>clock_timestamp())>=5 THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.gmail_oauth_states(state_hash,workspace_id,agent_id,owner_member_id,connection_id,verifier_ciphertext) VALUES(payload->>'state',w,aid,m,(payload->>'connectionId')::uuid,payload->>'verifier'); RETURN '{"ok":true}';
 ELSIF operation IN ('oauth.consume','oauth.finish') THEN
  SELECT * INTO s FROM agentonic.gmail_oauth_states WHERE state_hash=payload->>'state' AND workspace_id=w AND owner_member_id=m FOR UPDATE;
  IF s.state_hash IS NULL OR s.expires_at<=clock_timestamp() OR s.finished_at IS NOT NULL OR NOT agentonic.can_agent(s.agent_id,'edit') THEN RAISE insufficient_privilege; END IF;
  IF operation='oauth.consume' THEN
   IF s.consumed_at IS NOT NULL THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.gmail_oauth_states SET consumed_at=clock_timestamp() WHERE state_hash=s.state_hash;
   RETURN jsonb_build_object('agentId',s.agent_id,'connectionId',s.connection_id,'verifier',s.verifier_ciphertext);
  END IF;
  IF s.consumed_at IS NULL THEN RAISE insufficient_privilege; END IF;
  INSERT INTO agentonic.gmail_connections(id,workspace_id,agent_id,owner_member_id,account,credential_ciphertext) VALUES(s.connection_id,w,s.agent_id,m,payload->>'account',payload->>'credential');
  UPDATE agentonic.gmail_oauth_states SET finished_at=clock_timestamp(),verifier_ciphertext='' WHERE state_hash=s.state_hash;
  RETURN jsonb_build_object('agentId',s.agent_id);
 ELSIF operation IN ('disconnect','permissions','credential','reconnect') THEN
  SELECT * INTO c FROM agentonic.gmail_connections WHERE id=(payload->>'connectionId')::uuid AND workspace_id=w AND owner_member_id=m FOR UPDATE;
  IF c.id IS NULL OR NOT agentonic.can_agent(c.agent_id,'edit') THEN RAISE insufficient_privilege; END IF;
  IF operation='disconnect' THEN
   UPDATE agentonic.gmail_connections SET status='disconnected',credential_ciphertext=NULL,operations='[]' WHERE id=c.id;
   UPDATE agentonic.gmail_invocations SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,arguments_ciphertext=NULL WHERE connection_id=c.id;
   RETURN jsonb_build_object('credential',c.credential_ciphertext);
  ELSIF operation='reconnect' THEN
   UPDATE agentonic.gmail_connections SET status='reconnect',credential_ciphertext=NULL,operations='[]' WHERE id=c.id; RETURN '{"ok":true}';
  ELSIF operation='permissions' THEN
   IF c.agent_id<>aid OR c.status<>'connected' OR NOT agentonic.valid_gmail_tools(jsonb_build_array(jsonb_build_object('connectionId',c.id,'operations',payload->'operations'))) AND payload->'operations'<>'[]' THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.gmail_connections SET operations=payload->'operations' WHERE id=c.id; RETURN '{"ok":true}';
  ELSE RAISE insufficient_privilege; END IF;
 ELSIF operation IN ('invocations','inspect','confirm','cancel','complete') THEN
  IF operation='invocations' THEN
   SELECT * INTO conv FROM agentonic.staging_conversations WHERE id=(payload->>'conversationId')::uuid AND workspace_id=w AND owner_member_id=m;
   IF conv.id IS NULL OR NOT agentonic.staging_conversation_authorized(conv) THEN RAISE insufficient_privilege; END IF;
   RETURN jsonb_build_object('items',coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'operation',v.operation,'account',gc.account,'status',v.status,'hash',v.arguments_sha256,'expiresAt',v.expires_at,'argumentsCiphertext',v.arguments_ciphertext,'result',v.result,'automatic',v.approved_by_schedule_id IS NOT NULL) ORDER BY v.created_at) FROM agentonic.gmail_invocations v JOIN agentonic.gmail_connections gc ON gc.id=v.connection_id WHERE v.conversation_id=conv.id AND v.owner_member_id=m AND gc.status='connected'),'[]'));
  END IF;
  SELECT * INTO i FROM agentonic.gmail_invocations WHERE id=(payload->>'id')::uuid AND workspace_id=w AND owner_member_id=m FOR UPDATE;
  IF i.id IS NULL THEN RAISE insufficient_privilege; END IF;
  IF operation='complete' THEN
   IF i.status<>'executing' OR payload->>'status' NOT IN ('succeeded','failed','uncertain') THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.gmail_invocations SET status=payload->>'status',result=payload->'result',finished_at=clock_timestamp(),arguments_ciphertext=NULL WHERE id=i.id; RETURN '{"ok":true}';
  END IF;
  SELECT * INTO conv FROM agentonic.staging_conversations WHERE id=i.conversation_id AND owner_member_id=m;
  SELECT * INTO c FROM agentonic.gmail_connections WHERE id=i.connection_id;
  SELECT * INTO d FROM agentonic.deployments WHERE id=conv.deployment_id;
  SELECT * INTO r FROM agentonic.configuration_releases WHERE id=d.configuration_release_id;
  IF NOT agentonic.staging_conversation_authorized(conv) OR NOT agentonic.gmail_allowed(c,m,i.agent_id,i.operation)
   OR NOT (r.requested_access_snapshot->'tools') @> jsonb_build_array(jsonb_build_object('connectionId',c.id,'operations',jsonb_build_array(i.operation))) THEN RAISE insufficient_privilege; END IF;
  IF operation='cancel' THEN
   IF i.status<>'pending' THEN RAISE insufficient_privilege; END IF;
   UPDATE agentonic.gmail_invocations SET status='cancelled',arguments_ciphertext=NULL WHERE id=i.id; RETURN '{"ok":true}';
  END IF;
  IF i.status<>'pending' OR i.expires_at<=clock_timestamp() OR i.arguments_ciphertext IS NULL OR i.arguments_sha256 IS DISTINCT FROM payload->>'hash' OR i.approved_by_schedule_id IS NOT NULL THEN RAISE insufficient_privilege; END IF;
  IF operation='confirm' THEN
   UPDATE agentonic.gmail_invocations SET status='executing',approved_at=clock_timestamp() WHERE id=i.id;
  END IF;
  RETURN jsonb_build_object('credential',c.credential_ciphertext,'connectionId',c.id,'account',c.account,'argumentsCiphertext',i.arguments_ciphertext,'operation',i.operation);
 END IF;
 RAISE insufficient_privilege;
END $$;

REVOKE ALL ON FUNCTION agentonic.schedule_next(text,time,smallint,smallint,text,timestamptz),agentonic.schedule_message(agentonic.agent_schedules),
 agentonic.schedule_launch(agentonic.agent_schedules,timestamptz,boolean),agentonic.schedule_run_sync(),agentonic.schedule_autonomy(),agentonic.schedule_tick(),
 agentonic.schedule_action_claim(),agentonic.schedule_action_complete(uuid,text,jsonb),agentonic.schedule_state(uuid),agentonic.schedule_command(text,jsonb,uuid)
 FROM PUBLIC,anon,authenticated,service_role,agentonic_admin,agentonic_customer,agentonic_worker,agentonic_eval_local,agentonic_eval_azure,agentonic_deployer_local,agentonic_deployer_azure,agentonic_runtime_local,agentonic_runtime_azure;
GRANT EXECUTE ON FUNCTION agentonic.schedule_state(uuid),agentonic.schedule_command(text,jsonb,uuid) TO agentonic_customer;
GRANT EXECUTE ON FUNCTION agentonic.schedule_tick(),agentonic.schedule_action_claim(),agentonic.schedule_action_complete(uuid,text,jsonb) TO agentonic_worker;
