#!/usr/bin/env python3
"""WO-007 real poll replay. No paid APIs, temp calibration only."""
import sys, os, json, unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, os.path.dirname(__file__))
import bridge, replay_harness as rh, tests_wo001_road_atlanta_fixture as road
import plan_lifecycle as pl


def base():
    return road.clean_laps(7)[0]


def command(t, intent):
    return dict(command_id='wo007-'+intent, intent=intent, text='command', reason_text=None,
                race_instance_id=t['race_instance_id'], session_num=t['session_num'],
                expected_decision_id=t['active_plan_decision_id'], expected_revision=t['active_plan_revision'],
                expected_activation_source_frame_sequence=t['active_plan_activated_source_frame_sequence'],
                source_frame_sequence=t['source_frame_sequence'], driver_pit_sequence=t['driver_pit_sequence'],
                requested_target_lap=None, utterance_id='wo007-u', **{k:t[k] for k in ('bridge_process_epoch','canonical_snapshot_id','canonical_snapshot_sequence')})


def telemetry(r):
    return [b for b in r.broadcasts if b.get('type') == 'telemetry_live']


def pit_trace(r):
    return [json.loads(x.split(': ', 1)[1]) for x in r.logs_containing('PLAN LIFECYCLE PIT:')]


class ActualLifecyclePoll(unittest.TestCase):
    def run_pit(self, *, flags=0, fuel_added=5, normal=False, command_edge=None,
                intent='cancel', finish=False, collision=False,pit_transform=None):
        frames=base(); state={'spliced':False, 'command':False, 'target':None}
        def hook(cursor, frame, result):
            live=[b for b in telemetry(result) if b.get('active_plan_decision_id')]
            if not state['spliced'] and live:
                t=live[-1]; state['live']=t
                initial=(result.by_trigger('initial_strategy_plans')[-1]['strategy_options']['plan_a'] if result.by_trigger('initial_strategy_plans') else t['canonical_lifecycle']['lifecycle']['active'])
                target=initial['target_lap'] if normal else 6
                state['target']=target
                pit, fuel, tm, _=road.pit_visit(lap=target,fuel_before=30,fuel_added=fuel_added,
                                              start_time=400,black_flag=flags==0x10000)
                for f in pit: f['SessionFlags']=flags
                if pit_transform:pit=pit_transform(pit)
                if finish:
                    baseline=result.live_frames[cursor-1]['LapLastLapTime']
                    for f in pit: f['SessionState']=5; f['LapLastLapTime']=baseline
                    pit[-1]['LapLastLapTime']=baseline+1
                tail=[rh.make_frame(SessionTime=tm+i,Lap=target,FuelLevel=fuel,SessionFlags=0,
                                    LapLastLapTime=101 if finish else 100,
                                    SessionState=4 if finish else 4) for i in range(10)]
                frames[cursor:]=pit+tail
                result.live_frames[cursor:]=pit+tail
                state['spliced']=True
                if command_edge=='entry':
                    bridge._queue_driver_plan_command(command(t,intent));state['command']=True
                return
            if command_edge=='exit' and state['spliced'] and not state['command']:
                if not frame.get('OnPitRoad') and result.logs_containing('PIT DIAG ->'):
                    bridge._queue_driver_plan_command(command(state['live'],intent));state['command']=True
        bridge._pending_driver_plan_commands=[]
        context=patch.object(bridge.driver_pit_event_mod,'store_put',side_effect=bridge.driver_pit_event_mod.DriverPitEventCollisionError('mutation collision')) if collision else patch.object(bridge,'log',bridge.log)
        with context:
            r=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO,on_frame_ready=hook)
        self.assertTrue(state['spliced']);return r,state

    def test_normal_actual_pit_executes_canonical_active(self):
        r,s=self.run_pit(normal=True)
        trace=pit_trace(r)[0]
        self.assertEqual(trace['reason'],'normal')
        self.assertEqual([x['phase'] for x in trace['records']],['executed'])
        self.assertIsNone(trace['active_plan_id'])
        self.assertEqual([b for b in r.by_trigger('strategy_plan_box_call')
                          if b.get('decision_id')==s['live']['active_plan_decision_id']],[])

    def test_known_visit_raw_pit_or_track_unknown_never_executes_until_known_exit(self):
        for raw in ('OnPitRoad','IsOnTrack'):
            def unknown_exit(pit):pit[-1][raw]=None;return pit
            r,s=self.run_pit(normal=True,pit_transform=unknown_exit)
            snaps=[x for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot']
            unknown=next(x for x in snaps if x['source_frame']['session_time_s']==407)
            self.assertEqual(0,unknown['race_facts']['driver_pit_sequence']);self.assertEqual([],unknown['pit_ledger']['events']);self.assertEqual(s['live']['active_plan_decision_id'],unknown['lifecycle']['active']['decision_id']);self.assertTrue(unknown['execution']['visit_open']);self.assertFalse(unknown['execution']['allowed'])
            self.assertIsNone(unknown['current_facts']['on_pit_road' if raw=='OnPitRoad' else 'on_track'])
            recovered=next(x for x in snaps if x['source_frame']['session_time_s']==408)
            self.assertEqual(1,recovered['race_facts']['driver_pit_sequence']);self.assertEqual(1,len(recovered['pit_ledger']['events']));self.assertFalse(recovered['execution']['visit_open']);self.assertEqual('normal',recovered['pit_ledger']['events'][0]['execution_relation'])
            self.assertEqual(1,len(pit_trace(r)));self.assertEqual([],r.by_trigger('strategy_plan_box_call'))

    def test_sdk_inactive_during_known_visit_preserves_boundary_and_applies_one_exit(self):
        def inactive(pit):pit.insert(-1,rh.make_frame(_inactive=True));return pit
        r,s=self.run_pit(normal=True,pit_transform=inactive)
        snaps=[x for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot']
        unknown=next(x for x in snaps if not x['telemetry_available']);self.assertEqual(0,unknown['race_facts']['driver_pit_sequence']);self.assertTrue(unknown['execution']['visit_open']);self.assertFalse(unknown['execution']['allowed']);self.assertIsNotNone(unknown['lifecycle']['active'])
        self.assertEqual(1,len(pit_trace(r)));self.assertEqual('unresolved',pit_trace(r)[0]['reason'])
        resolved={rec['decision_id'] for rec in pit_trace(r)[0]['records'] if rec['phase']=='invalidated'}
        self.assertTrue(resolved);self.assertEqual([], [box for box in r.by_trigger('strategy_plan_box_call') if box['decision_id'] in resolved])
        for box in r.by_trigger('strategy_plan_box_call'):
            self.assertEqual(1,box['authority_proof']['driver_pit_sequence']);self.assertEqual(2,box['authority_proof']['expected_pit_sequence'])

    def test_unknown_to_true_does_not_forge_entry_and_known_exit_is_unresolved(self):
        def unknown_entry(pit):pit[0]['OnPitRoad']=None;return pit
        r,s=self.run_pit(normal=True,pit_transform=unknown_entry)
        self.assertEqual([],r.by_trigger('pit_entry'))
        events=[x for x in r.broadcasts if x.get('type')=='canonical_lifecycle_snapshot' and x['pit_ledger']['events']]
        self.assertTrue(events);event=events[0]['pit_ledger']['events'][0];self.assertEqual('unresolved',event['execution_relation']);self.assertIsNone(event['entry']['source_frame_sequence']);self.assertIsNone(event['entry']['session_time_s']);self.assertEqual(1,events[0]['race_facts']['driver_pit_sequence']);self.assertEqual([],r.by_trigger('strategy_plan_box_call'))

    def test_penalty_and_unknown_fail_closed_with_and_without_fuel(self):
        for flags,relation in [(0x10000,'penalty'),(None,'unresolved')]:
            for fuel in [0,5]:
                with self.subTest(flags=flags,fuel=fuel):
                    r,_=self.run_pit(flags=flags,fuel_added=fuel)
                    self.assertEqual(pit_trace(r)[0]['reason'],relation)
                    self.assertTrue(all(x['phase']=='invalidated' for x in pit_trace(r)[0]['records']))
                    self.assertEqual(r.by_trigger('strategy_plan_box_call'),[])

    def test_entry_command_freezes_start_plan_reference(self):
        for intent in ['cancel','early_pit']:
            r,s=self.run_pit(command_edge='entry',intent=intent)
            dpe=json.loads(r.logs_containing('DRIVER PIT EVENT:')[0].split(': ',1)[1])
            self.assertEqual(dpe['plan_reference']['decision_id'],s['live']['active_plan_decision_id'])
            ack=[b for b in r.broadcasts if b.get('type')=='driver_plan_command_ack'][0]
            self.assertEqual(ack['outcome'],'applied')
            self.assertEqual(pit_trace(r)[0]['records'],[]) # terminal command record stays unchanged

    def test_exit_command_has_no_false_applied_ack(self):
        r,s=self.run_pit(command_edge='exit')
        self.assertTrue(s['command'])
        ack=[b for b in r.broadcasts if b.get('type')=='driver_plan_command_ack'][0]
        self.assertNotEqual(ack['outcome'],'applied')
        self.assertEqual(pit_trace(r)[0]['reason'],'early')

    def test_exit_finish_executes_before_close_and_closed_latch_survives_raw_rollback(self):
        r,_=self.run_pit(normal=True,finish=True)
        self.assertEqual([x['phase'] for x in pit_trace(r)[0]['records']],['executed'])
        closed=r.logs_containing('PLAN LIFECYCLE SCOPE CLOSED: reason=session_end')
        self.assertEqual(len(closed),1)
        self.assertLess(r.logs.index(r.logs_containing('PLAN LIFECYCLE PIT:')[0]),r.logs.index(closed[0]))
        self.assertEqual(r.by_trigger('strategy_plan_box_call'),[])
        self.assertTrue(any((x.get('strategy_plan') or {}).get('reason')=='scope_closed' for x in telemetry(r)))

    def test_collision_holds_without_applying_noncanonical_event(self):
        r,state=self.run_pit(collision=True,normal=True)
        self.assertEqual(pit_trace(r),[])
        self.assertTrue(r.logs_containing('DRIVER PIT EVENT INVARIANT ERROR'))
        self.assertTrue(r.logs_containing('reason=pit_event_collision'))
        self.assertEqual(r.by_trigger('strategy_plan_box_call'),[])
        self.assertEqual(len(r.logs_containing('PLAN LIFECYCLE INITIAL REGISTRATION:')),1)
        samples=[x for x in telemetry(r) if x.get('driver_pit_sequence',0)>=1]
        self.assertTrue(samples)
        self.assertTrue(all((x.get('strategy_plan') or {}).get('reason')=='pit_event_collision' for x in samples))

    def test_known_true_unknown_false_preserves_active_revision_and_only_releases_flag_hold(self):
        frames=base();state={}
        def hook(cursor,frame,result):
            live=[x for x in telemetry(result) if x.get('active_plan_decision_id')]
            if live and not state:
                state['live']=live[-1]
                injected=[rh.make_frame(SessionTime=500+i,Lap=6,FuelLevel=40,SessionFlags=f) for i,f in enumerate([0x10000]*4+[None]*4+[0]*4)]
                result.live_frames[cursor:]=injected
        r=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO,on_frame_ready=hook)
        ids={x['active_plan_decision_id'] for x in telemetry(r) if x.get('active_plan_decision_id')}
        self.assertEqual(ids,{state['live']['active_plan_decision_id']})
        self.assertEqual({x['active_plan_revision'] for x in telemetry(r) if x.get('active_plan_decision_id')},{state['live']['active_plan_revision']})
        reasons={(x.get('strategy_plan') or {}).get('reason') for x in telemetry(r)}
        self.assertIn('black_flag_true',reasons);self.assertIn('black_flag_unknown',reasons)

    def test_initial_registration_blocked_for_true_and_unknown(self):
        for flags in [0x10000,None]:
            f=base()
            for x in f:x['SessionFlags']=flags
            r=rh.replay(f,session_info=road.ROAD_ATLANTA_SESSION_INFO)
            self.assertEqual(r.logs_containing('PLAN LIFECYCLE INITIAL REGISTRATION:'),[])
            self.assertEqual(r.by_trigger('strategy_plan_decision'),[])

    def test_visit_true_to_false_retains_visit_penalty(self):
        frames=base(); state={}
        def hook(cursor,frame,result):
            live=[x for x in telemetry(result) if x.get('active_plan_decision_id')]
            if live and not state:
                state['set']=True
                pit,fuel,tm,_=road.pit_visit(lap=6,fuel_before=30,fuel_added=5,start_time=400,black_flag=True)
                for f in pit[2:]:f['SessionFlags']=0
                result.live_frames[cursor:]=pit+[rh.make_frame(SessionTime=tm+i,Lap=6,FuelLevel=fuel) for i in range(5)]
        r=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO,on_frame_ready=hook)
        self.assertEqual(pit_trace(r)[0]['reason'],'penalty')

    def test_held_accept_is_consumed_without_automatic_activation_after_flag_release(self):
        import tests_bridge_plan_lifecycle_wiring as bc
        state={}
        def hook(cursor,frame,result):
            if not state and result.by_trigger('strategy_plan_proposal'):
                proposal=result.by_trigger('strategy_plan_proposal')[-1]
                state.update(proposal)
                bridge._queue_strategy_decision_response(proposal['decision_id'],True,
                    session_num=bc.PLAN_BC_ACCEPT_SESSION_NUM,dispatch_id=proposal['dispatch_id'])
                holds=[rh.make_frame(SessionTime=500+i,Lap=16,FuelLevel=30,SessionFlags=0x10000 if i<6 else 0) for i in range(15)]
                result.live_frames[cursor:]=holds
        r=bc._plan_bc_seed_replay(bc._plan_bc_accept_build_frames(),
            session_info=bc.PLAN_BC_ACCEPT_SESSION_INFO,on_frame_ready=hook)
        self.assertTrue(state)
        acks=[b for b in r.broadcasts if b.get('type')=='strategy_decision_ack']
        self.assertEqual(len(acks),1);self.assertEqual(acks[0]['outcome'],'held')
        self.assertEqual(r.logs_containing('PLAN LIFECYCLE ACCEPT REPLACED:'),[])
        self.assertFalse(any(x.get('active_plan_decision_id')==state['decision_id'] for x in telemetry(r)))

    def test_leader_checker_only_does_not_close_scope(self):
        frames=base(); baseline=frames[-1]['LapLastLapTime']
        frames += [rh.make_frame(SessionTime=500+i,Lap=8,FuelLevel=35,SessionState=5,
                                 LapLastLapTime=baseline) for i in range(8)]
        r=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO)
        self.assertEqual(r.logs_containing('PLAN LIFECYCLE SCOPE CLOSED: reason=session_end'),[])

    def test_closed_latch_survives_same_identity_disconnect_and_blocks_new_registration(self):
        frames=base(); baseline=frames[-1]['LapLastLapTime']
        frames += [rh.make_frame(SessionTime=500+i,Lap=8,FuelLevel=35,SessionState=5,
                                 LapLastLapTime=baseline+(1 if i>=2 else 0)) for i in range(5)]
        frames += [rh.make_frame(_inactive=True) for _ in range(18)]
        tail=base()
        for i,f in enumerate(tail):f['SessionTime']=600+i;f['SessionState']=4
        frames += tail
        r=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO)
        closed=r.logs_containing('PLAN LIFECYCLE SCOPE CLOSED: reason=session_end')
        self.assertEqual(len(closed),1)
        closeidx=r.logs.index(closed[0])
        self.assertFalse(any('PLAN LIFECYCLE INITIAL REGISTRATION:' in x or 'PLAN LIFECYCLE COMMIT:' in x
                             for x in r.logs[closeidx+1:]))
        self.assertTrue(any((x.get('strategy_plan') or {}).get('reason')=='scope_closed' for x in telemetry(r)))
        self.assertEqual(r.by_trigger('strategy_plan_box_call'),[])

    def test_black_hold_preserves_p0_fuel_fact_without_box_or_setting(self):
        frames=base();state={}
        def hook(cursor,frame,result):
            live=[x for x in telemetry(result) if x.get('active_plan_decision_id')]
            if live and not state:
                state['ready']=True
                result.live_frames[cursor:]=[rh.make_frame(SessionTime=500+i,Lap=6,
                    FuelLevel=6 if i==0 else 4,SessionFlags=0x10000) for i in range(12)]
        r=rh.replay(frames,session_info=road.ROAD_ATLANTA_SESSION_INFO,on_frame_ready=hook)
        held=[x for x in r.broadcasts if x.get('fact_only')]
        self.assertTrue(held, 'P0 facts were silenced by execution hold')
        for x in held:
            self.assertNotIn('box',x['message'].lower())
            self.assertNotIn('pit this lap',x['message'].lower())
            self.assertIsNone(x.get('set_fuel_l'));self.assertIsNone(x.get('safety_override'))
        self.assertTrue(any(x['trigger']=='fuel_warning' for x in held))
        # Native Renderer test reads these actual production payloads.
        from pathlib import Path
        Path('/tmp/wo007-held-fuel-replay.json').write_text(json.dumps(held))

    def test_same_frame_exit_accept_uses_terminal_state_and_no_activation(self):
        import tests_bridge_plan_lifecycle_wiring as bc
        state={}
        def hook(cursor,frame,result):
            if not state and result.by_trigger('strategy_plan_proposal'):
                p=result.by_trigger('strategy_plan_proposal')[-1];state.update(p)
                pit,_,tm=bc._plan_bc_accept_pit_visit(lap=16,fuel_before=30,fuel_added=5,start_time=500)
                pit[-1]['_wo007_exit']=True
                result.live_frames[cursor:]=pit+[rh.make_frame(SessionTime=tm+i,Lap=16,FuelLevel=35) for i in range(8)]
            elif frame.get('_wo007_exit'):
                bridge._queue_strategy_decision_response(state['decision_id'],True,
                    session_num=bc.PLAN_BC_ACCEPT_SESSION_NUM,dispatch_id=state['dispatch_id'])
        r=bc._plan_bc_seed_replay(bc._plan_bc_accept_build_frames(),
            session_info=bc.PLAN_BC_ACCEPT_SESSION_INFO,on_frame_ready=hook)
        self.assertTrue(state)
        ack=[b for b in r.broadcasts if b.get('type')=='strategy_decision_ack']
        self.assertEqual(len(ack),1);self.assertIn(ack[0]['outcome'],('no_match','stale'))
        self.assertEqual(r.logs_containing('PLAN LIFECYCLE ACCEPT REPLACED:'),[])
        records=pit_trace(r)[0]['records']
        self.assertEqual(len(records),2);self.assertEqual({x['phase'] for x in records},{'invalidated'})

    def test_real_identity_change_reopens_previously_closed_scope(self):
        frames=base(); baseline=frames[-1]['LapLastLapTime']
        frames += [rh.make_frame(SessionTime=500+i,Lap=8,FuelLevel=35,SessionState=5,
                                 LapLastLapTime=baseline+(1 if i>=2 else 0)) for i in range(5)]
        new=base()
        for i,f in enumerate(new):f['SessionNum']=1;f['SessionTime']=600+i
        frames+=new
        info=road.ROAD_ATLANTA_SESSION_INFO.replace('DriverInfo:',
            ' - SessionNum: 1\n   SessionType: Race\n   SessionLaps: 25\n   SessionTime: unlimited\nDriverInfo:')
        r=rh.replay(frames,session_info=info)
        self.assertEqual(len(r.logs_containing('PLAN LIFECYCLE INITIAL REGISTRATION:')),2)
        self.assertEqual(len(r.logs_containing('PLAN LIFECYCLE SCOPE CLOSED: reason=session_end')),1)
        self.assertTrue(any(x.get('session_num')==1 and x.get('active_plan_decision_id') for x in telemetry(r)))

    def test_collision_latch_survives_cancel_accept_and_reconnect_until_real_identity_change(self):
        frames=base();state={}
        info=road.ROAD_ATLANTA_SESSION_INFO.replace('DriverInfo:',
            ' - SessionNum: 1\n   SessionType: Race\n   SessionLaps: 25\n   SessionTime: unlimited\nDriverInfo:')
        def hook(cursor,frame,result):
            live=[x for x in telemetry(result) if x.get('active_plan_decision_id')]
            if not state and live:
                state['old']=live[-1]['active_plan_decision_id']
                state['delayed_cancel']=command(live[-1],'cancel')
                target=(result.by_trigger('initial_strategy_plans')[-1]['strategy_options']['plan_a'] if result.by_trigger('initial_strategy_plans') else live[-1]['canonical_lifecycle']['lifecycle']['active'])['target_lap']
                pit,fuel,tm,_=road.pit_visit(lap=target,fuel_before=30,fuel_added=5,start_time=400)
                holds=[rh.make_frame(SessionTime=tm+i,Lap=target,FuelLevel=fuel) for i in range(10)]
                reconnect=[rh.make_frame(_inactive=True) for _ in range(18)]
                after=[rh.make_frame(SessionTime=600+i,Lap=target,FuelLevel=fuel) for i in range(10)]
                new=base()
                for i,f in enumerate(new):f['SessionNum']=1;f['SessionTime']=700+i
                result.live_frames[cursor:]=pit+holds+reconnect+after+new
            elif not state.get('sent') and any(x.get('driver_pit_sequence')==1 for x in telemetry(result)):
                state['sent']=True
                bridge._queue_driver_plan_command(state['delayed_cancel'])
                bridge._queue_strategy_decision_response(state['old'],True,session_num=0,dispatch_id='old#1')
        bridge._pending_driver_plan_commands=[]
        with patch.object(bridge.driver_pit_event_mod,'store_put',side_effect=bridge.driver_pit_event_mod.DriverPitEventCollisionError('persistent mutation')):
            r=rh.replay(frames,session_info=info,on_frame_ready=hook)
        self.assertTrue(state.get('sent'))
        ack=[x for x in r.broadcasts if x.get('type')=='driver_plan_command_ack']
        self.assertEqual(ack[0]['outcome'],'applied')
        accept=[x for x in r.broadcasts if x.get('type')=='strategy_decision_ack']
        self.assertEqual(accept[0]['outcome'],'held');self.assertEqual(accept[0]['reason'],'pit_event_collision')
        held=[x for x in telemetry(r) if x.get('session_num')==0 and x.get('driver_pit_sequence',0)>=1]
        self.assertTrue(held);self.assertTrue(all((x.get('strategy_plan') or {}).get('reason')=='pit_event_collision' for x in held))
        registrations=r.logs_containing('PLAN LIFECYCLE INITIAL REGISTRATION:')
        self.assertEqual(len(registrations),1)  # no old-scope new initial
        commits=r.logs_containing('PLAN LIFECYCLE COMMIT:')
        self.assertEqual(len(commits),2)
        self.assertIn('action=register_new',commits[-1])
        self.assertIn('clean_3_laps_established:1:',commits[-1])
        self.assertTrue(any(x.get('session_num')==1 and x.get('active_plan_decision_id') for x in telemetry(r)))
        self.assertEqual([x for x in r.by_trigger('strategy_plan_box_call') if x.get('decision_id')==state['old']],[])

    def test_mutation_restoring_old_box_generation_makes_same_f01_assertion_red(self):
        # WO008 independent fresh authority blocks the old WO007-only mutation.
        with patch.object(pl,'apply_pit_event',side_effect=lambda state,event:(state,pl.LifecycleOutcome(status='diagnostic',reason='mutation_disabled'))):
            protected=road.run_scenario()
        self.assertEqual([],protected['box_calls'])
        protected_traces=pit_trace(protected['result'])
        with self.assertRaises(AssertionError):
            self.assertTrue(any(r['phase']=='executed' for t in protected_traces for r in t['records']))
        real=bridge.fixed_target_authority_mod.evaluate
        def old_unchecked(inputs,target,**kw):
            v=real(inputs,target,**kw)
            if inputs.get('current_lap')==target:
                return dict(available=True,reason='mutation_old_box',target_lap=target,
                            set_fuel_l=kw.get('frozen_set'),authority_inputs=inputs)
            return v
        real_advance=bridge.box_authority_delivery_mod.advance
        def old_delivery(ledger,record,inputs,**kw):
            inputs=dict(inputs)
            if record:inputs['driver_pit_sequence']=record.expected_pit_sequence-1
            return real_advance(ledger,record,inputs,**kw)
        # Remove the new WO009 composer's consistency barrier as well. The
        # candidate still comes from the real poll/WO008 advance path.
        composer_src=Path(bridge.canonical_mod.__file__).read_text()
        composer_src=composer_src.replace("can_execute=available and reason is None and active is not None and on_track is True and on_pit_road is False","can_execute=available and active is not None and bool(box.get('allowed_attempt_id'))")
        mutant_ns={'__name__':'wo009_mutant_composer'};exec(composer_src,mutant_ns)
        mutant_ns['LifecycleSnapshot']=bridge.canonical_mod.LifecycleSnapshot
        mutant_ns['PROCESS_EPOCH']=bridge.canonical_mod.PROCESS_EPOCH
        with patch.object(pl,'apply_pit_event',side_effect=lambda state,event:(state,pl.LifecycleOutcome(status='diagnostic',reason='mutation_disabled'))), patch.object(bridge.fixed_target_authority_mod,'evaluate',side_effect=old_unchecked), patch.object(bridge.box_authority_delivery_mod,'advance',side_effect=old_delivery), patch.object(bridge.canonical_mod,'build',side_effect=mutant_ns['build']):
            r=road.run_scenario()
        self.assertTrue(r['box_calls'],'compound mutation did not resurrect old BOX')
        with self.assertRaises(AssertionError):self.assertEqual(r['box_calls'],[])
        print('F01 compound mutation RED confirmed: old BOX count=%s'%len(r['box_calls']))

if __name__=='__main__':unittest.main()
