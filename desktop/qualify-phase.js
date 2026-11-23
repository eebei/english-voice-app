'use strict';
// 予選フェーズ判定（設計§24.16 / Build 313）：準備・アウトラップ／アタック／終了・インラップ。
//   実セッション種別と周回状態（ピットロード・コース上・周回数・残り時間）だけを使う。タイヤ温度などの実測できない値は作らない。
//   アタック中は、安全・車両異常・Driverへの返答以外の自発発話を控える（古い情報をまとめて流さない：捨てる）。
//   周回の数え方は iRacing の Lap カウンタ（ラインを横切ると +1）。ピット出口を出た周＝アウトラップ、その次の周以降＝アタック。
//   アタックを終えるのは**ピットへ戻った時／セッション終了**（複数周回の予選が通常。周回数では終えない）。スピン・コース外ではフェーズを変えない。
//   **実機のLap増加タイミング・予選で生telemetryにlap/on_pit_road/on_trackが届くか・2周計測の本命周は未検証**。
(function (root) {
  const isQualifying = (sessionType) => /qualif/i.test(String(sessionType || ''));

  function create(opts) {
    // 実際の予選は複数周回が通常（Lone/Open）。周回数でアタックを終えず、**ピットへ戻る**か**セッション終了**でアタックを終える（検査 R-C313-1）。
    //   attackLaps は上限を付けたい時だけ（既定＝上限なし）。スピン・コース外・ガレージ内の観測欠けでは、フェーズを変えない（誤ってアタック抑制を外さない）。
    const attackLaps = Number(opts && opts.attackLaps) > 0 ? Number(opts.attackLaps) : Infinity;
    let phase = 'none';
    let exitLap = null;        // ピット出口を出た時の Lap
    let hadAttack = false;     // 今回の走行で計測周回に入ったか
    let prevOnPit = null;
    let lastTransition = null;

    function setPhase(next, reason) {
      if (next !== phase) { lastTransition = { from: phase, to: next, reason }; phase = next; return true; }
      return false;
    }

    // live: { on_pit_road, on_track, lap, session_time_remaining_s }
    function update(live, sessionType, ctx) {
      lastTransition = null;
      if (!isQualifying(sessionType) || !live) {
        phase = 'none'; exitLap = null; hadAttack = false; prevOnPit = null;
        return phase;
      }
      const remaining = live.session_time_remaining_s;
      const ended = (ctx && ctx.sessionEnded === true)
        || (remaining !== null && remaining !== undefined && Number.isFinite(Number(remaining)) && Number(remaining) <= 0);
      const onPit = live.on_pit_road === true;
      const onTrack = live.on_track === true;
      const lap = Number(live.lap);
      if (ended) { setPhase('post', 'session_ended'); prevOnPit = onPit; return phase; }
      if (onPit) {
        // ピットへ戻った：走行（アタック）後なら終了後、まだ走っていなければ準備
        setPhase(hadAttack ? 'post' : 'prep', hadAttack ? 'pit_in' : 'in_pits');
        exitLap = null; prevOnPit = true;
        return phase;
      }
      if (!onTrack) {
        // スピン・コース外・ガレージ／リセット中：フェーズは変えない（アタック中のスピンで抑制を外さない）。観測が始まったばかりなら準備
        if (phase === 'none') setPhase('prep', 'off_track');
        return phase;
      }
      // コース上
      let exitedNow = false;
      if (prevOnPit === true || exitLap === null) {
        // ピット出口を出た（または途中から観測を始めた）：この周がアウトラップ
        exitLap = Number.isFinite(lap) ? lap : 0;
        hadAttack = false;
        exitedNow = (prevOnPit === true);   // 実際にピット出口を出た時だけ声かけ（途中から観測を始めた時はアウトラップと断定しない）
      }
      prevOnPit = false;
      const n = Number.isFinite(lap) ? lap - exitLap : 0;
      if (n <= 0) { if (!setPhase('prep', exitedNow ? 'outlap' : 'observe_start') && exitedNow) lastTransition = { from: phase, to: 'prep', reason: 'outlap' }; }
      else if (n <= attackLaps) { hadAttack = true; setPhase('attack', 'timed_lap'); }
      else setPhase('post', 'inlap');
      return phase;
    }

    return { update, phase: () => phase, transition: () => lastTransition, attackLaps };
  }

  // アタック中に控える自発発話。安全(P0)・危険(P1)・手順(P2)・Driverへの返答は通す。P3以降の自発情報は捨てる。
  function quietDuring(phase, prio, kind) {
    return phase === 'attack' && kind !== 'reply' && Number(prio) >= 3;
  }

  // 声かけ（決定論・実測できる値だけ）。transition: {from,to,reason}
  function lineFor(transition, ctx, lang) {
    if (!transition) return null;
    const jp = lang !== 'en';
    if (transition.to === 'prep' && transition.reason === 'outlap') {
      const t = Number(ctx && ctx.trackTempC);
      const temp = Number.isFinite(t) ? (jp ? `路面は${Math.round(t)}度。` : `Track ${Math.round(t)} degrees. `) : '';
      return jp ? `アウトラップ。${temp}タイヤを温めて、前とのクリアな間隔を作ろう。` : `Out lap. ${temp}Build tyre temperature and find a clear gap.`;
    }
    if (transition.from === 'attack' && transition.to === 'post') {
      // ピットへ戻った時（または時間終了）。有効周回・タイム・順位は確認できないので言わない
      return jp ? '走行終了。タイヤと路面を確認して、次のアタックに備えよう。' : 'Run finished. Check tyres and track, then prepare the next attack.';
    }
    return null;
  }

  const api = { create, isQualifying, quietDuring, lineFor };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitwallQualifyPhase = api;
})(typeof window !== 'undefined' ? window : globalThis);
