"""Shared gap budget and real broadcast/held-delivery contract; zero network."""
import copy
import unittest
from unittest.mock import patch
import bridge as b
from gap_call_policy import InformationalGapBudget,MulticlassApproachLatch

class Policies(unittest.TestCase):
 def test_budget_scope_and_dispatch_only(self):
  p=InformationalGapBudget();p.ensure_scope(('r',1));self.assertTrue(p.allows(10));self.assertTrue(p.allows(11))
  p.delivered(11);self.assertFalse(p.allows(70.9));self.assertTrue(p.allows(71));p.ensure_scope(('r',2));self.assertTrue(p.allows(12))
 def test_latch_noise_far_and_different_target(self):
  p=MulticlassApproachLatch();p.ensure_scope('r');key=('GTP',1);p.delivered(key,1)
  for now,groups in [(1,{}),(2,{key:[5.6]}),(3,{key:[8.1]}),(4,{key:[7.9]}),(5,{key:[8.2]}),(6,{key:[7.8]})]:p.observe(groups,now);self.assertEqual(p.stages[key],1)
  p.observe({key:[8.1]},10);p.observe({key:[8.2]},12.9);self.assertEqual(p.stages[key],1)
  p.observe({key:[8.2]},13);self.assertNotIn(key,p.stages)
  p.delivered(key,2);self.assertNotIn(('GTP',2),p.stages)
  p.observe({},20);p.observe({},23);self.assertNotIn(key,p.stages)
  p.delivered(key,1);p.ensure_scope('next');self.assertFalse(p.stages)

class Delivery(unittest.TestCase):
 def setUp(self):
  self.saved=(b._gap_radio_budget,b._mc_approach_latch,copy.deepcopy(b._mc_delivery_context),copy.deepcopy(b._gate_state),b._gate_active,b._gate_window_ok,b.connected_clients,b.loop)
  b._gap_radio_budget=InformationalGapBudget();b._gap_radio_budget.ensure_scope(('r',1,101,'epoch'))
  b._mc_approach_latch=MulticlassApproachLatch();b._mc_approach_latch.ensure_scope(('r',1,101,'epoch'))
  b._mc_delivery_context.clear();b._mc_delivery_context[('GTP',9)]={'gap':5.6,'approaching':True}
  b._gate_state.update(pending=None,since=0);b._gate_active=False;b._gate_window_ok=True;b.connected_clients={'test'};b.loop=object();self.now=100.
  self.patches=[patch.object(b.time,'time',side_effect=lambda:self.now),patch.object(b,'_activity_allows_broadcast',return_value=True),patch.object(b,'director_gate',return_value=True),patch.object(b.asyncio,'run_coroutine_threadsafe',side_effect=lambda coro,loop:coro.close())]
  for p in self.patches:p.start()
 def tearDown(self):
  for p in reversed(self.patches):p.stop()
  b._gap_radio_budget,b._mc_approach_latch,mc,gate,b._gate_active,b._gate_window_ok,b.connected_clients,b.loop=self.saved;b._mc_delivery_context.clear();b._mc_delivery_context.update(mc);b._gate_state.clear();b._gate_state.update(gate)
 def event(self,trigger='multiclass',stage=1):
  return b._bind_gap_radio({'type':'radio','trigger':trigger,'stage':stage,'class_name':'GTP','target_car_idx':9,'delta':5.6})
 def test_cross_kind_budget_and_safety_bypass(self):
  self.assertEqual(b.broadcast(self.event()),b.BROADCAST_DISPATCHED)
  self.now=110;self.assertEqual(b.broadcast(self.event('gap_trend')),b.BROADCAST_DROPPED)
  self.assertEqual(b.broadcast(self.event(stage=2)),b.BROADCAST_DISPATCHED)
  self.assertEqual(b.broadcast({'type':'radio','trigger':'side_by_side'}),b.BROADCAST_DISPATCHED)
  self.now=160;self.assertEqual(b.broadcast(self.event('gap_trend')),b.BROADCAST_DISPATCHED)
 def test_failed_and_held_not_consumed_then_flush(self):
  b.connected_clients=set();self.assertEqual(b.broadcast(self.event()),b.BROADCAST_DROPPED);self.assertIsNone(b._gap_radio_budget.delivered_at)
  b.connected_clients={'test'};b._gate_active=True;b._gate_window_ok=False
  self.assertEqual(b.broadcast(self.event()),b.BROADCAST_HELD);self.assertIsNone(b._gap_radio_budget.delivered_at)
  self.now=101;b._gate_window_ok=True;b.flush_radio();self.assertEqual(b._gap_radio_budget.delivered_at,101);self.assertIsNone(b._gate_state['pending'])
 def test_real_director_priority_preserves_safety(self):
  self.patches[2].stop()
  with patch.object(b.race_lifecycle,'director_active',return_value=True),patch.object(b,'_director_allows',return_value=(True,'test')):
   for event,priority in [(self.event(),4),(self.event('gap_trend'),4),(self.event(stage=2),1),({'type':'radio','trigger':'side_by_side'},0)]:
    self.assertTrue(b.director_gate(event));self.assertEqual(event['prio'],priority)
  self.patches[2].start()
 def test_urgent_cancels_same_target_held_preparation(self):
  b._gate_active=True;b._gate_window_ok=False
  self.assertEqual(b.broadcast(self.event()),b.BROADCAST_HELD)
  b._gate_active=False
  self.assertEqual(b.broadcast(self.event(stage=2)),b.BROADCAST_DISPATCHED)
  self.assertIsNone(b._gate_state['pending'])
  self.assertIsNone(b._gap_radio_budget.delivered_at)
 def test_held_scope_target_expiry_fail_closed(self):
  for mutate in ['scope','target','expired']:
   b._gap_radio_budget.delivered_at=None;b._gate_active=True;b._gate_window_ok=False;self.now=100
   self.assertEqual(b.broadcast(self.event()),b.BROADCAST_HELD)
   if mutate=='scope':b._gap_radio_budget.ensure_scope(('new',2))
   elif mutate=='target':b._mc_delivery_context.clear()
   else:self.now=110
   b._gate_window_ok=True;b.flush_radio();self.assertIsNone(b._gap_radio_budget.delivered_at)
   b._gap_radio_budget.ensure_scope(('r',1,101,'epoch'));b._mc_delivery_context[('GTP',9)]={'gap':5.6,'approaching':True}

if __name__=='__main__':unittest.main()
