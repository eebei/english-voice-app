"""Boundary contracts for the native history entry, with dated SDK scope inputs."""
import copy
import unittest
import fuel_reference_planning as f


def inputs():
    now=1800000000
    c=dict(race_instance_id='current',session_num=0,cust_id=42,car_model='GT3',track='Monza Grand Prix',track_raw='monza',
      current_lap=1,lap_dist_pct=0,fuel_level_l=19,effective_capacity_l=100,time_remaining_s=1140,
      session_time_s=100,race_format='timed',configured_duration_s=1140,black_flag='false',
      telemetry_available=True,source_available=True,on_track=True,on_pit_road=False,scope_closed=False,collision=False,session_finished=False)
    p=dict(bridge_process_epoch='epoch',snapshot_id='epoch:1',snapshot_sequence=1,race_instance_id='current',session_num=0,
      source_frame=dict(available=True,session_time_s=100),telemetry_available=True,
      continuity=dict(durable_commit=True,custody_scope=dict(driver_id=42)),execution=dict(scope_closed=False,collision=False))
    r={k:p[k] for k in ('bridge_process_epoch','snapshot_id','snapshot_sequence','race_instance_id','session_num')}
    r.update(command_id='cmd',evidence_version='v1',cust_id=42,car_model='GT3',track='Monza Grand Prix',mode='propose',
      records=[dict(custId=42,car='GT3',track='monza',date='2026-01-01T00:00:00Z',avgFuelPerLap=rate,avgLap=115,
        race_instance_id='past'+str(i),sessionNum=0,totalLaps=10) for i,rate in enumerate((3.6,3.8))])
    return r,p,c,now


class Contract(unittest.TestCase):
    def test_native_reference_and_raw_pair(self):
        r,p,c,n=inputs();a=f.proposal(r,p,c,n)
        self.assertTrue(a['available']);self.assertTrue(f.reference_valid(a['reference']))
        self.assertEqual((a['target_lap'],a['set_fuel_l']),(4,24))
        self.assertAlmostEqual(a['add_fuel_l'],23.7)
        c['track_raw']='foreign';self.assertFalse(f.proposal(r,p,c,n)['available'])

    def test_schema_closed_before_registration(self):
        for key,value in [('evidence_version',''),('command_id','x'*513),('bridge_process_epoch',''),('snapshot_id','x'*513)]:
            r,p,c,n=inputs();r[key]=value
            self.assertFalse(f.proposal(r,p,c,n)['available'],(key,value))

    def test_exact_retry_digest(self):
        r,_,_,_=inputs();a=f.request_digest(r)
        self.assertEqual(a,f.request_digest(copy.deepcopy(r)))
        r['records'][0]['avgFuelPerLap']+=.01;self.assertNotEqual(a,f.request_digest(r))
        r['records'][0]['avgFuelPerLap']=float('nan');self.assertIsNone(f.request_digest(r))
        self.assertIsNone(f.request_digest({'x':object()}))

    def test_live_negative_boundaries(self):
        for key,value in [('race_format','lap_race'),('race_format',None),('black_flag','unknown'),('source_available',False),
          ('scope_closed',True),('session_finished',True),('on_pit_road',True),('effective_capacity_l',20)]:
            r,p,c,n=inputs();c[key]=value
            self.assertFalse(f.proposal(r,p,c,n)['available'],(key,value))
        r,p,c,n=inputs();p['race_instance_id']='old'
        self.assertFalse(f.proposal(r,p,c,n)['available'])
        r,p,c,n=inputs();c['session_time_s']=105
        self.assertFalse(f.proposal(r,p,c,n)['available'])

    def test_worsening_measurement_requires_new_service(self):
        r,p,c,n=inputs();a=f.proposal(r,p,c,n)
        c.update(current_measured_rate_l_per_lap=4.2,current_measured_samples=1)
        self.assertFalse(f.geometry(c,a['evidence'],a['target_lap'],a['set_fuel_l'])['available'])
        new=f.geometry(c,a['evidence'],3)
        self.assertTrue(new['available']);self.assertGreater(new['set_fuel_l'],a['set_fuel_l'])

    def test_measured_pace_conservative_geometry_and_proof_identity(self):
        from types import SimpleNamespace
        import fixed_target_authority as authority
        import durable_recovery as recovery
        r,p,c,n=inputs();a=f.proposal(r,p,c,n)
        record=SimpleNamespace(plan_basis={f.CONTRACT:a['reference']},decision_id=a['decision_id'],revision=1,
          activated_source_frame_sequence=1,target_lap=a['target_lap'],add_fuel_l=a['add_fuel_l'],set_fuel_l=a['set_fuel_l'])
        base=dict.fromkeys(recovery.FUEL_INPUT_KEYS)
        before=f.inputs_for_record(record,base,c,'epoch')
        c.update(current_measured_pace_s=90,current_measured_pace_samples=1)
        self.assertFalse(f.geometry(c,a['evidence'],4,24)['available'])
        faster=f.geometry(c,a['evidence'],4)
        self.assertEqual((faster['crossings_to_finish'],faster['set_fuel_l'],faster['planning_pace_s']),(14,35,90))
        after=f.inputs_for_record(record,base,c,'epoch')
        self.assertTrue(recovery.fuel_input_schema(after,record))
        self.assertNotEqual(authority.material_key(record,before),authority.material_key(record,after))
        self.assertFalse(f.evaluate_inputs(after,4,24)['available'])
        c['effective_capacity_l']=35
        self.assertFalse(f.geometry(c,a['evidence'],4)['available'])
        c['effective_capacity_l']=100
        for pace,samples in [(130,1),(90,0),(None,1),(float('nan'),1),(20,1),(2000,1)]:
            c.update(current_measured_pace_s=pace,current_measured_pace_samples=samples)
            result=f.geometry(c,a['evidence'],4)
            self.assertEqual((result['set_fuel_l'],result['planning_pace_s']),(24,115))

    def test_native_id_stays_scope_bound_across_replans(self):
        from types import SimpleNamespace
        import driver_pit_event as pit
        r,p,c,n=inputs();a=f.proposal(r,p,c,n)
        c.update(current_measured_rate_l_per_lap=4.2,current_measured_samples=1,snapshot_id='epoch:2',source_frame_sequence=2)
        for i in range(5):
            frozen=pit.freeze_plan_reference(dict(decision_id=a['decision_id'],selected_plan='A',session_num=0,
              target_lap=a['target_lap'],evidence_snapshot_id=a['reference']['source_snapshot_id']),race_instance_id=c['race_instance_id'],session_num=0)
            self.assertIsNotNone(frozen)
            self.assertIsNone(pit.freeze_plan_reference(dict(decision_id=a['decision_id'],selected_plan='A',session_num=0),race_instance_id='foreign',session_num=0))
            self.assertLess(len(a['decision_id']),128)
            record=SimpleNamespace(plan_basis={f.CONTRACT:a['reference']},target_lap=a['target_lap'],decision_id=a['decision_id'])
            c['source_frame_sequence']+=1
            a=f.replan(record,c);self.assertTrue(a['available'])
            self.assertEqual(a['reference']['planning_rate_l_per_lap'],4.2)

    def test_actual_poll_emits_current_measured_rate_with_one_clean_sample(self):
        import tests_history_consultation_negatives as consultation
        from unittest.mock import patch
        import session_race_state
        original=session_race_state.recent_median
        with patch.object(session_race_state,'recent_median',wraps=original) as median:
            replay=consultation.h.rh.replay(consultation.running(275,4.2),session_info=consultation.core.INFO)
        # The history-only owner must expose a real first measurement to its
        # safety recalculation, while the legacy clean-three default stays three.
        self.assertTrue(any(call.kwargs.get('minimum')==1 and len(call.args[0])==1
          and abs(call.args[0][0]-4.2)<.01 for call in median.call_args_list))
        self.assertIsNone(original([4.2]))
        wire=[b['fuel_strategy'] for b in replay.broadcasts if b.get('type')=='telemetry_live' and b.get('fuel_strategy')]
        canonical=[b['recommendations']['fuel_strategy']['value'] for b in replay.broadcasts
          if b.get('type')=='canonical_lifecycle_snapshot' and b['recommendations']['fuel_strategy']['value']]
        self.assertTrue(wire and canonical)
        self.assertEqual(wire[-1]['strict_clean_laps_sampled'],1)
        self.assertAlmostEqual(wire[-1]['strict_clean_avg_fuel_per_lap'],4.2)
        self.assertEqual(canonical[-1]['strict_clean_laps_sampled'],1)
        self.assertAlmostEqual(canonical[-1]['strict_clean_avg_fuel_per_lap'],4.2)

    def test_actual_poll_exposes_current_measured_pace_before_clean_three(self):
        from unittest.mock import patch
        import session_race_state
        import tests_history_consultation_negatives as consultation
        original=session_race_state.recent_median
        with patch.object(session_race_state,'recent_median',wraps=original) as median:
            consultation.h.rh.replay(consultation.running(215,3.68,90),session_info=consultation.core.INFO)
        self.assertTrue(any(call.kwargs.get('minimum')==1 and len(call.args[0])==1
          and abs(call.args[0][0]-90.01)<.01 for call in median.call_args_list))
        self.assertIsNone(original([90]))

    def test_withdrawal_is_not_execution(self):
        r,p,c,n=inputs();r['mode']='invalidate';c.update(black_flag='unknown',on_pit_road=True)
        self.assertIsNone(f.reference_error(r,p,c))
        r['race_instance_id']='other';self.assertIsNotNone(f.reference_error(r,p,c))

    def test_frozen_native_reference_is_plain_at_input_boundary(self):
        from types import MappingProxyType, SimpleNamespace
        r,p,c,n=inputs();ref=f.proposal(r,p,c,n)['reference']
        def freeze(v):
            if isinstance(v,dict):return MappingProxyType({k:freeze(x) for k,x in v.items()})
            if isinstance(v,list):return tuple(freeze(x) for x in v)
            return v
        record=SimpleNamespace(plan_basis=freeze({f.CONTRACT:ref}))
        view=f.inputs_for_record(record,{},c,'epoch')
        self.assertEqual(copy.deepcopy(view)['provisional_history']['evidence']['record_count'],2)
        self.assertIsNotNone(f.request_digest(view))

    def test_recovery_schema_is_explicit_and_record_bound(self):
        import durable_recovery as recovery
        from types import SimpleNamespace
        r,p,c,n=inputs();ref=f.proposal(r,p,c,n)['reference']
        record=SimpleNamespace(plan_basis={f.CONTRACT:ref})
        base=dict.fromkeys(recovery.FUEL_INPUT_KEYS)
        view=f.inputs_for_record(record,base,c,'epoch')
        self.assertTrue(recovery.fuel_input_schema(view,record))
        altered=copy.deepcopy(view);altered['provisional_history']['evidence']['rate_l_per_lap']=3.8
        self.assertFalse(recovery.fuel_input_schema(altered,record))
        self.assertFalse(recovery.fuel_input_schema(dict(view,extra=True),record))
        del view['configured_duration_s'];self.assertFalse(recovery.fuel_input_schema(view,record))
        self.assertTrue(recovery.fuel_input_schema(base,record))
        self.assertFalse(recovery.fuel_input_schema(dict(base,extra=True),record))

    def test_dedup_strict_clean_and_sessions(self):
        r,p,c,n=inputs();rows=r['records'];strict=dict(rows[0],avgFuelPerLap=4,fuelSampleBasis='strict_clean',fuelSampleCount=1)
        a=f.personal_evidence(rows+[strict],c,n);b=f.personal_evidence([strict]+rows,c,n)
        self.assertEqual(a['rate_l_per_lap'],b['rate_l_per_lap']);self.assertEqual(a['record_count'],2)
        extra=dict(rows[0],sessionNum=1)
        self.assertEqual(f.personal_evidence(rows+[extra],c,n)['record_count'],3)


if __name__=='__main__':unittest.main()
