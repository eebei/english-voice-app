"""Strategy-room ranking is advice on measured physical exits, never BOX authority."""
import copy
import unittest
import strategy_options as so
import pit_exit_forecaster as forecaster


def fixture():
    options=so.build_initial_plans(snapshot_id='fuel',current_lap=5,fuel_level_l=35,
        avg_fuel_per_lap_l=3.5,clean_laps_sampled=4,crossings_to_finish=20,
        reserve_l=.5,effective_capacity_l=60)
    source=dict(race_instance_id='sub:race',session_num=1,source_frame_sequence=40,
                generated_at_session_s=100.,current_lap=5)
    snap=dict(snapshot_id='live:1:100',player_lap=5,player_lap_dist_pct=.1,player_class_id=101,
        player_last_lap_time=100,cars=[dict(car_idx=i,class_position=i,class_id=101,
        lap=5,lap_dist_pct=.8-i*.1,last_lap_time=100,on_pit_road=False) for i in range(1,10)])
    cal=dict(prediction_ready=True,pit_entry_pct=.98,pit_exit_pct=.06,lane_total_q1_s=28.,
        lane_total_median_s=32.,lane_total_q3_s=36.,pit_sample_count=4,normal_sample_count=5,usable_sample_count=4)
    envelope=so.build_position_forecasts(snapshot=snap,calibration=cal,source=source)
    return options,source,envelope,snap,cal


def forecasts_for_positions(options,envelope,positions):
    # Test the ranking seam with complete real forecast metadata; the end-to-end
    # forecaster case below also uses its untouched calculated position values.
    result=copy.deepcopy(envelope)
    for label,(likely,worst) in positions.items():
        f=result['forecasts'][options['plan_'+label.lower()]['target_lap']-5]
        for kind,value in [('best',likely),('likely',likely),('worst',worst)]:
            f[kind]['position']=value
            f['common_horizon']['scenarios'][kind]['position']=value
            f['common_horizon']['scenarios'][kind]['player_progress']+=(7-value)/100
    return result


def compare(options,source,envelope,**kwargs):
    return so.compare_position_strategies(options,current_lap=5,forecasts=envelope,source=source,
        relative_pace_advantage_s=kwargs.pop('relative_pace_advantage_s',.8),
        fuel_save_recent_l_per_lap=kwargs.pop('fuel_save_recent_l_per_lap',3.0),
        rival_pitted_first=kwargs.pop('rival_pitted_first',True),clean_air=kwargs.pop('clean_air',True),**kwargs)


class Comparison(unittest.TestCase):
    def test_real_forecaster_uses_each_actual_delay_and_scoped_advice(self):
        options,source,envelope,snap,cal=fixture()
        for delay in range(11):
            self.assertEqual({k:v for k,v in envelope['forecasts'][delay].items() if k not in ('candidate_target_lap','common_horizon')},forecaster.forecast_pit_after_laps(snapshot=snap,calibration=cal,delay_laps=delay))
        result=compare(options,source,envelope)
        self.assertEqual(result['gain_kind'],'same_horizon_constant_pace_model')
        self.assertIn('not_common_finish_or_pit_cycle',result['comparison_time_role'])
        self.assertEqual(result['source_frame_sequence'],40)
        self.assertEqual(result['generated_at_session_s'],100)
        self.assertLessEqual(result['valid_for_s'],10)
        self.assertNotIn('execution_allowed',result)

    def test_partial_or_invalid_calibration_cannot_predict_or_stop_poll(self):
        from unittest.mock import Mock
        o,s,_,snap,cal=fixture()
        invalid=[None,'unknown',float('nan'),float('inf'),-.1,1.,1.1,True,cal['pit_entry_pct']]
        for field in ('pit_entry_pct','pit_exit_pct'):
            for value in invalid:
                bad=dict(cal,**{field:value})
                if field=='pit_entry_pct' and value==cal['pit_entry_pct']:
                    continue
                predict=Mock(side_effect=AssertionError('invalid calibration reached predictor'))
                envelope=so.build_position_forecasts(snapshot=snap,calibration=bad,source=s,forecaster=predict)
                self.assertFalse(envelope['available'],(field,value))
                self.assertEqual(envelope['forecasts'],{})
                result=compare(o,s,envelope)
                self.assertEqual(result['reason'],'calibration_geometry_unavailable')
                self.assertEqual(result['ranked_candidates'],[])
                self.assertEqual(len(result['unavailable_candidates']),3)
                self.assertEqual(result['source_frame_sequence'],s['source_frame_sequence'])
                self.assertFalse(compare(o,dict(s,race_instance_id='other'),envelope)['available'])
                predict.assert_not_called()
        for exit_pct in (.48,.6):
            bad=dict(cal,pit_exit_pct=exit_pct)
            self.assertFalse(so.build_position_forecasts(snapshot=snap,calibration=bad,source=s)['available'])
        for field in ('pit_entry_pct','pit_exit_pct'):
            bad=dict(cal);bad.pop(field)
            self.assertFalse(so.build_position_forecasts(snapshot=snap,calibration=bad,source=s)['available'])

    def test_exact_target_before_at_after_entry(self):
        o,s,e,snap,cal=fixture()
        o=so.build_initial_plans(snapshot_id='fuel',current_lap=5,fuel_level_l=35,avg_fuel_per_lap_l=3.5,clean_laps_sampled=4,crossings_to_finish=20,reserve_l=.5,effective_capacity_l=100)
        for pct in (.979,.98,.981):
            snap['player_lap_dist_pct']=pct
            envelope=so.build_position_forecasts(snapshot=snap,calibration=cal,source=s)
            first=5 if pct<=.98 else 6
            self.assertEqual(envelope['first_reachable_target_lap'],first)
            for offset,prediction in envelope['forecasts'].items():
                target=5+offset
                self.assertEqual(prediction['candidate_target_lap'],target)
                self.assertEqual(prediction['delay_laps'],target-first)
                expected=forecaster.forecast_pit_after_laps(snapshot=snap,calibration=cal,delay_laps=target-first)
                self.assertEqual(prediction['time_to_entry_s'],expected['time_to_entry_s'])
            result=compare(o,s,envelope)
            if pct>.98:
                self.assertTrue(any(r['plan_id']=='B' and r['reason']=='candidate_target_missed' for r in result['unavailable_candidates']))
                self.assertEqual(result['selected_plan'],'A')

    def test_cross_time_rank_improvement_is_not_strategy_gain(self):
        o,s,e,_,_=fixture()
        b=e['forecasts'][o['plan_b']['target_lap']-5]
        c=e['forecasts'][o['plan_c']['target_lap']-5]
        b['likely']['position']=5;b['worst']['position']=6
        c['likely']['position']=4;c['worst']['position']=5
        result=compare(o,s,e)
        self.assertEqual(result['selected_plan'],'A')
        self.assertTrue(all(r['gain_vs_baseline']==0 for r in result['ranked_candidates']))

    def test_b_beats_c_and_baseline(self):
        o,s,e,_,_=fixture();e=forecasts_for_positions(o,e,{'A':(7,8),'B':(4,6),'C':(5,7)})
        result=compare(o,s,e)
        self.assertTrue(result['available']);self.assertEqual(result['selected_plan'],'B')
        self.assertEqual([r['plan_id'] for r in result['ranked_candidates']],['B','C','A'])
        self.assertEqual(result['ranked_candidates'][0]['gain_vs_baseline'],3)

    def test_c_needs_actual_gain_and_measured_pace(self):
        o,s,e,_,_=fixture();e=forecasts_for_positions(o,e,{'A':(7,8),'B':(5,7),'C':(4,6)})
        self.assertEqual(compare(o,s,e)['selected_plan'],'C')
        self.assertEqual(compare(o,s,e,relative_pace_advantage_s=None)['selected_plan'],'A')
        self.assertNotEqual(compare(o,s,e,rival_pitted_first=None)['selected_plan'],'C')
        self.assertNotEqual(compare(o,s,e,fuel_save_recent_l_per_lap=3.6)['selected_plan'],'C')
        e=forecasts_for_positions(o,e,{'A':(7,8),'B':(8,9),'C':(7,8)})
        self.assertEqual(compare(o,s,e)['selected_plan'],'A')

    def test_ties_and_worse_tail_keep_baseline(self):
        o,s,e,_,_=fixture()
        for positions in [{'A':(7,8),'B':(5,9),'C':(4,10)},
                          {'A':(7,8),'B':(7,8),'C':(7,8)},
                          {'A':(7,8),'B':(5,7),'C':(5,7)}]:
            self.assertEqual(compare(o,s,forecasts_for_positions(o,e,positions))['selected_plan'],'A')

    def test_missing_stale_identity_mixed_model_and_cohort(self):
        o,s,e,_,_=fixture();e=forecasts_for_positions(o,e,{'A':(7,8),'B':(4,6),'C':(5,7)})
        b=o['plan_b']['target_lap']-5
        for mutate in [lambda x:x.update(source_frame_sequence=39),lambda x:x.update(generated_at_session_s=99),
            lambda x:x.update(race_instance_id='sub:other'),lambda x:x.update(session_num=2),
            lambda x:x['forecasts'][b].update(model_version=3),lambda x:x['forecasts'][b].update(snapshot_id='old'),
            lambda x:x['forecasts'][b].update(delay_laps=1),lambda x:x['forecasts'].pop(b),
            lambda x:x['forecasts'][b]['likely'].update(position=float('nan')),
            lambda x:x['forecasts'][b]['likely'].update(excluded_car_idxs=[1]),
            lambda x:x['forecasts'][b]['likely'].update(projected_car_count=1)]:
            bad=copy.deepcopy(e);mutate(bad);result=compare(o,s,bad)
            self.assertFalse(result['available'],result);self.assertEqual(result['selected_plan'],'A')

    def test_unreachable_capacity_and_outside_horizon(self):
        o,s,e,_,_=fixture();e=forecasts_for_positions(o,e,{'A':(7,8),'B':(4,6),'C':(5,7)})
        for state in [dict(fuel_level_l=1,avg_fuel_per_lap_l=3.5,effective_capacity_l=60,reserve_l=.5,crossings_to_finish=20),
                      dict(fuel_level_l=35,avg_fuel_per_lap_l=3.5,effective_capacity_l=5,reserve_l=.5,crossings_to_finish=20)]:
            self.assertEqual(compare(o,s,e,fuel_state=state)['selected_plan'],'A')
        o['plan_a']['target_lap']=18
        result=compare(o,s,e)
        self.assertFalse(result['available']);self.assertEqual(result['reason'],'baseline_prediction_unavailable')
        self.assertTrue(any(r['reason']=='candidate_target_outside_forecast_horizon' for r in result['unavailable_candidates']))

    def test_recalculation_never_conditions_only_c(self):
        o,s,e,_,_=fixture()
        params=dict(previous=o,snapshot_id='recalc',trigger_reason='fuel',current_lap=5,fuel_level_l=35,
            recent_fuel_per_lap_l=3.5,clean_laps_sampled=4,crossings_to_finish=20,reserve_l=.5,effective_capacity_l=60,
            rival_pitted_first=True,clean_air=True,rejoin_not_worse=True,fuel_save_recent_l_per_lap=3.0,relative_pace_advantage_s=.8)
        result=so.reevaluate_plans(**params)
        self.assertEqual(result['selected_plan'],'A');self.assertFalse(result['options']['position_comparison']['available'])
        e=forecasts_for_positions(o,e,{'A':(7,8),'B':(4,6),'C':(5,7)})
        result=so.reevaluate_plans(**params,position_forecasts=e,comparison_source=s)
        self.assertEqual(result['selected_plan'],'B')
        self.assertEqual(result['options']['position_comparison']['selected_plan'],'B')

class FreshAdvice(unittest.TestCase):
    def setup_inputs(self, q=.1438888888888889):
        import fixed_target_authority as fa
        _,s,_,snap,cal=fixture()
        fuel=11.497222222222222-2.9*(q-.1438888888888889)
        old=so.build_initial_plans(snapshot_id='old_fuel_lap',current_lap=5,fuel_level_l=11.9,
            avg_fuel_per_lap_l=2.9,clean_laps_sampled=3,crossings_to_finish=7,reserve_l=.5,effective_capacity_l=60)
        i=fa.build_inputs(race_instance_id=s['race_instance_id'],session_num=s['session_num'],source_frame_sequence=s['source_frame_sequence'],
            session_time_s=s['generated_at_session_s'],current_lap=5,total_laps=12,lap_dist_pct=q,fuel_level_l=fuel,
            avg_fuel_per_lap_l=2.9,clean_laps_sampled=3,effective_capacity_l=60,driver_pit_sequence=0,is_lap_race=True,reserve_l=.5)
        snap['player_lap_dist_pct']=q
        e=so.build_position_forecasts(snapshot=snap,calibration=cal,source=s)
        return old,s,e,i

    def test_real_mid_lap_burn_keeps_fresh_full_distance_advice(self):
        import fixed_target_authority as fa
        for q in (.1438888888888889,.2438888888888889,.3438888888888889):
            old,s,e,i=self.setup_inputs(q);original=copy.deepcopy(old)
            fresh=so.build_comparison_plans(old,i,first_target=5)
            self.assertEqual([fresh['plan_'+k]['target_lap'] for k in ('a','b','c')],[7,5,8])
            self.assertTrue(all(fresh['plan_'+k]['set_fuel_l']==12 for k in ('a','b','c')))
            self.assertEqual(fresh['crossings_to_finish'],8)  # includes current running lap
            for k in ('a','b'):
                p=fresh['plan_'+k]
                self.assertTrue(fa.evaluate(i,p['target_lap'],frozen_set=p['set_fuel_l'])['available'])
            c=fresh['plan_c'];ci=dict(i,avg_fuel_per_lap_l=c['required_fuel_per_lap_l'])
            self.assertTrue(fa.evaluate(ci,c['target_lap'],frozen_set=c['set_fuel_l'])['available'])
            result=so.compare_position_strategies(old,current_lap=5,forecasts=e,source=s,authority_inputs=i)
            self.assertTrue(result['available'],result)
            self.assertEqual({r['plan_id'] for r in result['ranked_candidates']},{'A','B','C'})
            self.assertEqual(result['candidate_basis'],'fresh_authority_advice_not_agreed_plan')
            self.assertEqual(result['selected_plan'],'A')
            self.assertEqual(old,original)  # native/agreed plan and fill are never rewritten

    def test_wrong_scope_old_frame_unsupported_and_unreachable_do_not_pass(self):
        old,s,e,i=self.setup_inputs()
        for change in ({'source_frame_sequence':39},{'race_instance_id':'other'},{'session_num':2},
                       {'finish_kind':'unsupported_format'},{'fuel_level_l':.1},{'effective_capacity_l':1},
                       {'clean_laps_sampled':2},{'crossings_to_finish':7}):
            result=so.compare_position_strategies(old,current_lap=5,forecasts=e,source=s,authority_inputs=dict(i,**change))
            self.assertFalse(result['available'],(change,result))
            self.assertEqual(result['ranked_candidates'],[])
            self.assertEqual(result['selected_plan'],'A')

    def test_passed_entry_never_offers_this_lap(self):
        old,s,e,i=self.setup_inputs(.99)
        result=so.compare_position_strategies(old,current_lap=5,forecasts=e,source=s,authority_inputs=i)
        self.assertTrue(result['available'],result)
        self.assertTrue(all(r['target_lap']>=6 for r in result['ranked_candidates']))


if __name__=='__main__':unittest.main()


def ranking_input_fixture(inputs, winner='B'):
    """Explicit prediction I/O double for lifecycle tests, not an authority stub.

    Fuel plans and target delays are real; metadata comes from the production
    forecast builder. Physical and common-horizon outcomes are explicit scenario inputs; these do not establish real model strategy gains.
    """
    lap=inputs['current_lap']
    options=so.build_initial_plans(snapshot_id='fixture',current_lap=lap,
        fuel_level_l=inputs['fuel_level_l'],avg_fuel_per_lap_l=inputs['recent_fuel_per_lap_l'],
        clean_laps_sampled=inputs['clean_laps_sampled'],crossings_to_finish=inputs['crossings_to_finish'],
        reserve_l=inputs.get('reserve_l',.5),effective_capacity_l=inputs.get('effective_capacity_l'))
    _,source,_,snapshot,calibration=fixture()
    source.update(current_lap=lap,session_num=inputs.get('session_num',1),generated_at_session_s=inputs.get('session_time_s',100))
    snapshot.update(player_lap=lap,player_lap_dist_pct=.1)
    snapshot['cars']=[dict(car_idx=i,class_position=i,class_id=101,lap=lap,lap_dist_pct=.8-i*.01,last_lap_time=100,on_pit_road=False) for i in range(1,21)]
    envelope=so.build_position_forecasts(snapshot=snapshot,calibration=calibration,source=source)
    for label,pair in {'A':(12,14),'B':(4,6) if winner=='B' else (8,10),'C':(4,6) if winner=='C' else (8,10)}.items():
        plan=options.get('plan_'+label.lower()) or {};target=plan.get('target_lap')
        if type(target) is not int or target-lap not in envelope['forecasts']:continue
        f=envelope['forecasts'][target-lap]
        for k,value in [('best',pair[0]),('likely',pair[0]),('worst',pair[1])]:
            f[k]['position']=value
            f['common_horizon']['scenarios'][k]['position']=value
            f['common_horizon']['scenarios'][k]['player_progress']+=(12-value)/100
    return dict(position_forecasts=envelope,comparison_source=source)


from contextlib import contextmanager
from unittest.mock import patch


@contextmanager
def synthetic_positive_b_forecast(*, evidence, capacity_l=60.):
    """TEST ONLY prediction-output seam for delivery/consent coverage.

    The production same-horizon constant-pace model correctly has no timing
    benefit between identical stops. This deliberately synthetic +1 s/P1 B
    versus P3 baseline scenario tests proposal transport, NOT forecast skill.
    Scope/frame/time/model/cohort/targets come from the real builder unchanged;
    lifecycle, comparator, Driver consent and BOX authority are not patched.
    Fixture SDK fuel uses exactly 2 L/lap and the existing .5 L reserve.
    capacity_l is an explicit SDK fixture input and must match SessionInfo.
    """
    import bridge
    original=so.build_position_forecasts

    def forecast_boundary(**kwargs):
        envelope=original(**kwargs)
        if not envelope:return envelope
        current=kwargs['source']['current_lap']
        # This legacy proposal fixture feeds SessionLapsRemain directly to
        # the real fuel recommendation. Do not substitute FA's +1 geometry.
        remaining=bridge.reader.read_int('SessionLapsRemain')
        fuel=bridge.reader.read_float('FuelLevel')
        options=so.build_initial_plans(snapshot_id='test_prediction_boundary',current_lap=current,
            fuel_level_l=fuel,avg_fuel_per_lap_l=2.,clean_laps_sampled=3,
            crossings_to_finish=remaining,reserve_l=.5,effective_capacity_l=capacity_l)
        if not options.get('available'):return envelope
        a,b=(options.get('plan_'+label) or {} for label in ('a','b'))
        if not b.get('fuel_window_open'):return envelope
        af=envelope['forecasts'].get(a['target_lap']-current)
        bf=envelope['forecasts'].get(b['target_lap']-current)
        if not af or not bf or not all(f.get('available') and f.get('common_horizon') for f in (af,bf)):
            return envelope
        if any(f['likely']['projected_car_count']<2 for f in (af,bf)):return envelope
        assert af['candidate_target_lap']==a['target_lap']
        assert bf['candidate_target_lap']==b['target_lap']
        before=copy.deepcopy(envelope)
        for case in ('best','likely','worst'):
            af[case]['position']=3
            bf[case]['position']=1
            base=af['common_horizon']['scenarios'][case]
            alternate=bf['common_horizon']['scenarios'][case]
            base['position']=3
            alternate['position']=1
            alternate['player_progress']=base['player_progress']+1./bf['common_horizon']['pace_s']
        evidence.append(dict(source_frame_sequence=envelope['source_frame_sequence'],
            expected_targets={'A':a['target_lap'],'B':b['target_lap']},
            unchanged_origin={k:envelope[k] for k in ('race_instance_id','session_num','source_frame_sequence','generated_at_session_s','snapshot_id','class_id','cohort_car_idxs')},
            synthetic_gain_s=1.,before=before,after=copy.deepcopy(envelope)))
        return envelope

    with patch.object(so,'build_position_forecasts',side_effect=forecast_boundary):
        yield


def assert_synthetic_b_targets(broadcasts, evidence):
    """Prove the I/O fixture's targets match the actual published comparator."""
    expected={x['source_frame_sequence']:x['expected_targets'] for x in evidence}
    checked=[]
    for b in broadcasts:
        if b.get('type')!='canonical_lifecycle_snapshot':continue
        options=((b.get('recommendations') or {}).get('strategy_options') or {}).get('value') or {}
        # This fixture exercises the native proposal comparator. The separately
        # refreshed advisory copy can legitimately use authority-aligned targets.
        c=(options.get('decision_evidence') or {}).get('position_comparison') or {}
        if c.get('source_frame_sequence') not in expected:continue
        for row in c.get('ranked_candidates') or []:
            label=row['plan_id']
            if label not in expected[c['source_frame_sequence']]:continue
            assert row['target_lap']==expected[c['source_frame_sequence']][label],(row,expected[c['source_frame_sequence']])
            checked.append((c['source_frame_sequence'],label,row['target_lap']))
    assert any(label=='B' for _,label,_ in checked), 'synthetic forecast never reached the real comparator publication'
    return checked
