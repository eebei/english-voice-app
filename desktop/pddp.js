'use strict';

// PITWALL Driver Development Program (PDDP)
// Deterministic driver-improvement summary.  No LLM or rating promises here:
// it turns confirmed race-history rows into one measurable next focus.

function finite(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

function classify(row) {
  const incidents = finite(row && row.incidents);
  const finish = finite(row && (row.finishPos ?? row.finish_pos));
  const start = finite(row && (row.startPos ?? row.start_pos));
  const dnf = row && (row.dnf === true || /dnf|disconnect|abandon/i.test(String(row.status || row.reason || '')));
  if (dnf) return 'completion';
  if (incidents !== null && incidents >= 8) return 'incident_control';
  if (incidents !== null && incidents >= 4) return 'racecraft';
  if (start !== null && finish !== null && finish - start >= 4) return 'conversion';
  return 'consistency';
}

function analyze(rows, options = {}) {
  const source = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 10));
  const recent = source.slice(-limit);
  const incidents = recent.map(r => finite(r.incidents)).filter(v => v !== null);
  const finishes = recent.map(r => finite(r.finishPos ?? r.finish_pos)).filter(v => v !== null);
  const iratings = recent.map(r => finite(r.irating)).filter(v => v !== null);
  const counts = recent.reduce((m, r) => { const k = classify(r); m[k] = (m[k] || 0) + 1; return m; }, {});
  const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const focus = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || 'consistency';
  return {
    sample_size: recent.length,
    average_incidents: avg(incidents),
    average_finish: avg(finishes),
    latest_irating: iratings.length ? iratings[iratings.length - 1] : null,
    irating_min: iratings.length ? Math.min(...iratings) : null,
    irating_max: iratings.length ? Math.max(...iratings) : null,
    issue_counts: counts,
    primary_focus: focus,
    rows: recent,
  };
}

function nextFocus(summary) {
  const s = summary || {};
  const avgInc = finite(s.average_incidents);
  if (s.primary_focus === 'completion') return { key: 'completion', metric: 'DNF率', target: '完走率を上げる' };
  if (s.primary_focus === 'incident_control' || (avgInc !== null && avgInc >= 8)) {
    return { key: 'incident_control', metric: '平均Incidents', target: 'まず平均4未満' };
  }
  if (s.primary_focus === 'racecraft' || (avgInc !== null && avgInc >= 4)) {
    return { key: 'racecraft', metric: '接触・オフトラック', target: '直近レースで半減' };
  }
  if (s.primary_focus === 'conversion') return { key: 'conversion', metric: 'スタート順位→決勝順位', target: '失う順位を2以下' };
  return { key: 'consistency', metric: '完走順位のばらつき', target: '同じ判断を再現する' };
}

function briefingLine(summary, name = 'ドライバー') {
  const s = summary || {};
  const f = nextFocus(s);
  const n = Number.isInteger(s.sample_size) ? s.sample_size : 0;
  const avgInc = finite(s.average_incidents);
  const ir = finite(s.latest_irating);
  const facts = [];
  if (n) facts.push(`直近${n}レース`);
  if (avgInc !== null) facts.push(`平均Incidents ${avgInc.toFixed(1)}`);
  if (ir !== null) facts.push(`最新iRating ${Math.round(ir)}`);
  return `${name}、${facts.join('、') || '確認できた実測がまだ少ない'}。今回の重点は${f.metric}。次の1レースは${f.target}を一つだけ試そう。`;
}

module.exports = { analyze, nextFocus, briefingLine };
