(() => {
  const IDS = ['hyeonho', 'taeho', 'yeonho', 'kyeonghun', 'minju', 'youngwon', 'suji', 'hyeonjeong'];
  const NAMES = { hyeonho: '김현호', taeho: '김태호', yeonho: '김연호', kyeonghun: '김경훈', minju: '진민주', youngwon: '김영원', suji: '안수지', hyeonjeong: '고현정' };

  const sheetValues = (answer) => {
    let a = answer;
    if (a && Array.isArray(a.content)) a = a.content.map((c) => c.text || '').join('');
    if (typeof a === 'string') {
      try { a = JSON.parse(a); } catch (e) { throw new Error(a.slice(0, 300)); }
    }
    if (!a || !Array.isArray(a.values)) throw new Error('values가 없는 응답: ' + Object.keys(a || {}).join(', '));
    return a.values;
  };
  const isoDate = (v) => {
    const m = String(v ?? '').trim().match(/^(\d{2,4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})\.?(?:\s+(\d{1,2}:\d{2}))?/);
    if (!m) return { date: '', time: '' };
    const y = m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1]);
    return { date: y + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0'), time: m[4] || '' };
  };

  dash.loader('tasks', {
    description: '작업배정 시트(작업자 배정, 사업명, 사업금액, 기관명, 마감일시, 평가)를 행으로 바꿉니다. 마감일시는 2026-10-28, 26.10.28 10:00 형식을 읽고, 사업명이 빈 행은 뺍니다.',
    fn: ({ answer }) => {
      const rows = sheetValues(answer).slice(1).filter((r) => r && String(r[1] ?? '').trim()).map((r) => {
        const d = isoDate(r[4]);
        return { assignees: String(r[0] ?? '').trim(), project: String(r[1]).trim(), budget: String(r[2] ?? '').trim(), org: String(r[3] ?? '').trim(), deadline: d.date, time: d.time, eval: String(r[5] ?? '').trim() };
      });
      return { columns: ['assignees', 'project', 'budget', 'org', 'deadline', 'time', 'eval'], rows };
    },
  });

  dash.loader('holidays', {
    description: '공휴일 시트(날짜, 요일, 내용)를 날짜와 이름으로 바꿉니다.',
    fn: ({ answer }) => {
      const rows = sheetValues(answer).slice(1).map((r) => ({ date: isoDate(r && r[0]).date, name: String((r && r[2]) ?? '').trim() || '공휴일' })).filter((r) => r.date);
      return { columns: ['date', 'name'], rows };
    },
  });

  IDS.forEach((id) => dash.loader(id, {
    description: '시트의 values 배열을 행으로 바꿉니다. 첫 행(머리글)과 날짜가 빈 행은 빼고, 상세내용 끝의 메일 번호 (#123)은 지웁니다.',
    fn: ({ answer }) => {
      const rows = sheetValues(answer).slice(1).filter((r) => r && r[0]).map((r) => ({
        date: String(r[0]).trim().slice(0, 10),
        type: String(r[1] ?? '').trim(),
        mid: String(r[2] ?? '').trim(),
        sub: String(r[3] ?? '').trim(),
        project: String(r[4] ?? '').trim(),
        hours: r[5] === undefined || r[5] === null || String(r[5]).trim() === '' ? null : Number(r[5]),
        detail: String(r[6] ?? '').replace(/\s*\(#\d+\)\s*$/, '').trim(),
      }));
      return { columns: ['date', 'type', 'mid', 'sub', 'project', 'hours', 'detail'], rows };
    },
  }));

  dash.calc('entries', {
    title: '팀 업무일지 통합',
    description: '팀원 8명의 업무일지를 합치고 팀원, 월, 주(월요일 시작)를 붙입니다. 소요시간이 없는 행은 뺍니다.',
    inputs: IDS,
    fn: (hyeonho, taeho, yeonho, kyeonghun, minju, youngwon, suji, hyeonjeong) => {
      const sheets = [['김현호', hyeonho], ['김태호', taeho], ['김연호', yeonho], ['김경훈', kyeonghun], ['진민주', minju], ['김영원', youngwon], ['안수지', suji], ['고현정', hyeonjeong]];
      const types = ['제안', '감리', '기타', '교육', '휴가'];
      const out = [];
      sheets.forEach(([member, rows]) => (rows || []).forEach((r) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !(r.hours > 0)) return;
        const t = Date.parse(r.date + 'T00:00:00Z');
        const week = new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10);
        out.push({ member, date: r.date, month: r.date.slice(0, 7), week, type: types.includes(r.type) ? r.type : '기타', mid: r.mid, sub: r.sub, project: r.project.replace(/\s+/g, ' '), hours: r.hours, detail: r.detail || '' });
      }));
      return out;
    },
  });

  dash.calc('ref', {
    title: '기준일',
    description: '팀원 업무일지 제안 행 가운데 가장 최근 날짜. 투입시간과 미입력 평일은 이 날짜까지 셉니다.',
    inputs: ['entries'],
    fn: (entries) => {
      let ref = '';
      entries.forEach((e) => { if (e.type === '제안' && e.date > ref) ref = e.date; });
      return [{ ref, month: ref.slice(0, 7) }];
    },
  });

  dash.calc('member_month', {
    title: '팀원별 월 투입시간',
    description: '팀원·월별 구분 시간 합계, 기준일까지 기록 없는 평일 수(공휴일 시트와 2026년 법정 공휴일 제외), 하루 8시간을 넘긴 날 수.',
    inputs: ['entries', 'ref', 'holidays'],
    fn: (entries, ref, holidays) => {
      const HOLIDAYS = (holidays || []).map((h) => h.date).concat(['2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-02', '2026-05-05', '2026-05-25', '2026-06-03', '2026-08-17', '2026-09-24', '2026-09-25', '2026-10-05', '2026-10-09', '2026-12-25']);
      const refDate = ref.length ? ref[0].ref : '';
      const key = { 제안: 'proposal', 감리: 'audit', 기타: 'other', 교육: 'training', 휴가: 'leave' };
      const day = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
      const nextMonth = (m) => { let [y, mo] = m.split('-').map(Number); mo += 1; if (mo > 12) { mo = 1; y += 1; } return y + '-' + String(mo).padStart(2, '0'); };
      const daily = new Map();
      const span = new Map();
      const agg = new Map();
      const blank = (month, member) => ({ month, member, total: 0, proposal: 0, audit: 0, other: 0, training: 0, leave: 0, missing: 0, over8: 0 });
      entries.forEach((e) => {
        if (!refDate || e.date > refDate) return;
        const dk = e.member + '|' + e.date;
        daily.set(dk, (daily.get(dk) || 0) + e.hours);
        const s = span.get(e.member) || { first: e.date, last: e.date };
        if (e.date < s.first) s.first = e.date;
        if (e.date > s.last) s.last = e.date;
        span.set(e.member, s);
        const mk = e.month + '|' + e.member;
        if (!agg.has(mk)) agg.set(mk, blank(e.month, e.member));
        const o = agg.get(mk);
        o.total += e.hours;
        o[key[e.type]] += e.hours;
      });
      span.forEach((s, member) => {
        for (let m = s.first.slice(0, 7); m <= s.last.slice(0, 7); m = nextMonth(m)) {
          if (!agg.has(m + '|' + member)) agg.set(m + '|' + member, blank(m, member));
        }
      });
      agg.forEach((o) => {
        const s = span.get(o.member);
        const start = (o.month + '-01') > s.first ? o.month + '-01' : s.first;
        const monthEnd = day(nextMonth(o.month) + '-01', -1);
        const end = monthEnd < refDate ? monthEnd : refDate;
        for (let d = start; d <= end; d = day(d, 1)) {
          const wd = new Date(d + 'T00:00:00Z').getUTCDay();
          if (wd >= 1 && wd <= 5 && !HOLIDAYS.includes(d) && !daily.has(o.member + '|' + d)) o.missing += 1;
        }
        daily.forEach((h, k) => { const [mem, d] = k.split('|'); if (mem === o.member && d.slice(0, 7) === o.month && h > 8) o.over8 += 1; });
        ['total', 'proposal', 'audit', 'other', 'training', 'leave'].forEach((f) => { o[f] = Math.round(o[f] * 10) / 10; });
      });
      return [...agg.values()].sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
    },
  });

  dash.calc('team_month', {
    title: '팀 월 합계',
    description: '팀원별 월 투입시간을 월마다 더한 값.',
    inputs: ['member_month'],
    fn: (member_month) => {
      const m = new Map();
      member_month.forEach((r) => {
        const o = m.get(r.month) || { month: r.month, total: 0, proposal: 0, audit: 0, otherTraining: 0, leave: 0, missing: 0, over8: 0, members: 0 };
        o.total += r.total; o.proposal += r.proposal; o.audit += r.audit; o.otherTraining += r.other + r.training; o.leave += r.leave;
        o.missing += r.missing; o.over8 += r.over8; if (r.total > 0) o.members += 1;
        m.set(r.month, o);
      });
      return [...m.values()].map((o) => ({ ...o, total: Math.round(o.total * 10) / 10, proposal: Math.round(o.proposal * 10) / 10, audit: Math.round(o.audit * 10) / 10, otherTraining: Math.round(o.otherTraining * 10) / 10, leave: Math.round(o.leave * 10) / 10 })).sort((a, b) => (a.month < b.month ? 1 : -1));
    },
  });

  dash.calc('member_week', {
    title: '팀원별 주간 투입시간',
    description: '팀원·주(월요일 시작)별 시간 합계, 기준일까지.',
    inputs: ['entries', 'ref'],
    fn: (entries, ref) => {
      const refDate = ref.length ? ref[0].ref : '';
      const m = new Map();
      entries.forEach((e) => {
        if (e.date > refDate) return;
        const k = e.week + '|' + e.member;
        const o = m.get(k) || { week: e.week, member: e.member, total: 0 };
        o.total += e.hours;
        m.set(k, o);
      });
      return [...m.values()].map((o) => ({ ...o, total: Math.round(o.total * 10) / 10 }));
    },
  });

  dash.calc('proposals', {
    title: '제안 사업별 현황',
    description: '제안 행을 사업명별로 합친 투입시간, 기록 기간, 참여 팀원, 단계(중분류 기준). 기준일 14일 안에 기록이 있으면 진행 중.',
    inputs: ['entries', 'ref'],
    fn: (entries, ref) => {
      const STAGE = { '제안 준비': 0, '제안서 일정': 1, '제안서 인력': 1, '제안서 첨부 및 서류': 2, '제안서류': 2, '제안서 품질검수': 3, '제안서 제출': 4, '제안평가 지원': 5 };
      const LABEL = ['준비', '작성', '서류', '검수', '제출', '평가'];
      const refDate = ref.length ? ref[0].ref : '';
      const d14 = new Date(Date.parse(refDate + 'T00:00:00Z') - 14 * 864e5).toISOString().slice(0, 10);
      const m = new Map();
      entries.forEach((e) => {
        if (e.type !== '제안' || !e.project || e.date > refDate) return;
        const o = m.get(e.project) || { project: e.project, first: e.date, last: e.date, hours: 0, members: new Set(), s: [0, 0, 0, 0, 0, 0], submitted: '' };
        if (e.date < o.first) o.first = e.date;
        if (e.date > o.last) o.last = e.date;
        o.hours += e.hours;
        o.members.add(e.member);
        const st = STAGE[e.mid];
        if (st !== undefined) o.s[st] = 1;
        if (st === 4 && (!o.submitted || e.date < o.submitted)) o.submitted = e.date;
        m.set(e.project, o);
      });
      return [...m.values()].map((o) => {
        const stage = o.s.lastIndexOf(1);
        const status = o.s[5] ? '평가 지원' : o.s[4] ? '제출 완료' : o.last >= d14 ? '진행 중' : '14일 넘게 기록 없음';
        return { project: o.project, first: o.first, last: o.last, hours: Math.round(o.hours * 10) / 10, members: [...o.members].join('·'), stage, stageLabel: stage >= 0 ? LABEL[stage] : '-', s0: o.s[0], s1: o.s[1], s2: o.s[2], s3: o.s[3], s4: o.s[4], s5: o.s[5], submitted: o.submitted, status };
      }).sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
    },
  });

  dash.calc('proposal_summary', {
    title: '제안 요약',
    description: '진행 중 사업 수, 기준일 30일 안에 제출한 사업 수, 90일 안에 제출한 사업의 평균 투입시간.',
    inputs: ['proposals', 'ref'],
    fn: (proposals, ref) => {
      const refDate = ref.length ? ref[0].ref : '';
      const back = (n) => new Date(Date.parse(refDate + 'T00:00:00Z') - n * 864e5).toISOString().slice(0, 10);
      const d30 = back(30);
      const d90 = back(90);
      const sub90 = proposals.filter((p) => p.submitted && p.submitted >= d90);
      const avg = sub90.length ? Math.round((sub90.reduce((s, p) => s + p.hours, 0) / sub90.length) * 10) / 10 : null;
      return [{ active: proposals.filter((p) => p.status === '진행 중').length, submitted30: proposals.filter((p) => p.submitted && p.submitted >= d30).length, avgHours90: avg, n90: sub90.length }];
    },
  });

  dash.calc('audit_days', {
    title: '감리 일',
    description: '팀원별 감리 날짜. 사업명이 빈 감리 행은 7일 안의 앞선 감리 사업명을 이어받고, 같은 날 제안 시간도 붙입니다. 앞으로 잡힌 감리도 포함합니다.',
    inputs: ['entries'],
    fn: (entries) => {
      const prop = new Map();
      entries.forEach((e) => { if (e.type === '제안') prop.set(e.member + '|' + e.date, (prop.get(e.member + '|' + e.date) || 0) + e.hours); });
      const aud = entries.filter((e) => e.type === '감리').sort((a, b) => (a.member === b.member ? (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) : a.member < b.member ? -1 : 1));
      const lastProj = new Map();
      const lastDate = new Map();
      const out = new Map();
      aud.forEach((e) => {
        const k = e.member + '|' + e.date;
        let p = e.project;
        const ld = lastDate.get(e.member);
        if (!p && ld && (Date.parse(e.date) - Date.parse(ld)) / 864e5 <= 7) p = lastProj.get(e.member) || '';
        if (p) lastProj.set(e.member, p);
        lastDate.set(e.member, e.date);
        if (!out.has(k)) out.set(k, { member: e.member, date: e.date, month: e.month, project: p || '(사업명 없음)', hours: 0, proposalHours: Math.round((prop.get(k) || 0) * 10) / 10 });
        out.get(k).hours += e.hours;
      });
      return [...out.values()];
    },
  });

  dash.calc('audit_runs', {
    title: '감리 기간',
    description: '같은 팀원·같은 사업의 감리 일을 4일 이내 공백까지 한 기간으로 묶고, 제안 시간이 있던 날을 셉니다.',
    inputs: ['audit_days'],
    fn: (audit_days) => {
      const rows = [...audit_days].sort((a, b) => (a.member === b.member ? (a.date < b.date ? -1 : 1) : a.member < b.member ? -1 : 1));
      const runs = [];
      let cur = null;
      rows.forEach((d) => {
        const gap = cur ? (Date.parse(d.date) - Date.parse(cur.end)) / 864e5 : 99;
        if (cur && cur.member === d.member && cur.project === d.project && gap <= 4) {
          cur.end = d.date; cur.days += 1; if (d.proposalHours > 0) cur.overlap += 1;
        } else {
          cur = { member: d.member, project: d.project, start: d.date, end: d.date, days: 1, overlap: d.proposalHours > 0 ? 1 : 0 };
          runs.push(cur);
        }
      });
      return runs;
    },
  });

  dash.calc('audit_team_month', {
    title: '감리 월 합계',
    description: '월별 감리 인·일 수, 같은 날 제안도 한 날 수, 감리에 투입된 팀원 수.',
    inputs: ['audit_days'],
    fn: (audit_days) => {
      const m = new Map();
      audit_days.forEach((d) => {
        const o = m.get(d.month) || { month: d.month, days: 0, overlap: 0, who: new Set() };
        o.days += 1; if (d.proposalHours > 0) o.overlap += 1; o.who.add(d.member);
        m.set(d.month, o);
      });
      return [...m.values()].map((o) => ({ month: o.month, days: o.days, overlap: o.overlap, members: o.who.size }));
    },
  });

  dash.calc('day_cells', {
    title: '팀원별 일일 근무',
    description: '팀원·날짜별 구분 시간과 근무 상태, 그날 한 일(구분·중분류·소분류·사업명·상세내용·시간). 감리·휴가·교육 가운데 하나가 8시간 이상이고 다른 구분이 없으면 그 상태(감리 현장·휴가·교육), 다른 구분과 섞이면 복합, 그 밖은 사무실.',
    inputs: ['entries'],
    fn: (entries) => {
      const key = { 제안: 'proposal', 감리: 'audit', 기타: 'other', 교육: 'training', 휴가: 'leave' };
      const m = new Map();
      entries.forEach((e) => {
        const k = e.member + '|' + e.date;
        const o = m.get(k) || { member: e.member, date: e.date, total: 0, proposal: 0, audit: 0, other: 0, training: 0, leave: 0, items: [] };
        o.total += e.hours;
        o[key[e.type]] += e.hours;
        o.items.push({ type: e.type, mid: e.mid, sub: e.sub, project: e.project, detail: e.detail, hours: e.hours });
        m.set(k, o);
      });
      const r1 = (v) => Math.round(v * 10) / 10;
      return [...m.values()].map((o) => {
        const away = [['audit', 'field'], ['leave', 'vacation'], ['training', 'education']].filter(([f]) => o[f] >= 8);
        const kinds = ['proposal', 'audit', 'other', 'training', 'leave'].filter((f) => o[f] > 0).length;
        const status = away.length === 1 && kinds === 1 ? away[0][1] : away.length ? 'mixed' : 'office';
        return { ...o, total: r1(o.total), proposal: r1(o.proposal), audit: r1(o.audit), other: r1(o.other), training: r1(o.training), leave: r1(o.leave), status };
      });
    },
  });

  dash.calc('deadlines', {
    title: '제안 마감',
    description: '작업배정 시트의 사업별 마감일과 담당자. 작업자 배정 칸을 쉼표·공백으로 나누고 첫 이름을 정담당으로 봅니다. 마감일을 못 읽은 행은 뺍니다.',
    inputs: ['tasks'],
    fn: (tasks) => tasks.filter((t) => t.deadline).map((t) => ({ ...t, assignees: t.assignees ? t.assignees.split(/[,，\s]+/).filter(Boolean) : [] })),
  });

  dash.calc('holiday_days', {
    title: '휴일',
    description: '공휴일 시트를 날짜당 한 행으로 합친 것(같은 날 이름이 여럿이면 첫 이름).',
    inputs: ['holidays'],
    fn: (holidays) => {
      const m = new Map();
      holidays.forEach((h) => { if (!m.has(h.date)) m.set(h.date, h.name); });
      return [...m].map(([date, name]) => ({ date, name }));
    },
  });

  // ---------- page ----------
  const MEMBER_ORDER = IDS.map((id) => NAMES[id]);
  const TYPES = [['proposal', '제안'], ['audit', '감리'], ['other', '기타'], ['training', '교육'], ['leave', '휴가']];
  const f1 = d3.format(',.1~f');
  const enc = (s) => String(s).replace(/%/g, '%25').replace(/&/g, '%26').replace(/=/g, '%3D');
  const byOrder = (a, b) => MEMBER_ORDER.indexOf(a.member) - MEMBER_ORDER.indexOf(b.member);
  const monthLabel = (m) => (m ? Number(m.slice(5, 7)) + '월' : '—');
  const lastDayOf = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
  let tab = 'hours';
  const CAL_EXCLUDED = ['김영원'];
  const CAL_MEMBERS = MEMBER_ORDER.filter((n) => !CAL_EXCLUDED.includes(n));
  const DOW = ['일', '월', '화', '수', '목', '금', '토'];
  const STATUS = { field: ['감리 현장', 1], vacation: ['휴가', 4], education: ['교육', 3], mixed: ['복합', null] };
  const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const mondayOf = (d) => { const t = Date.parse(d + 'T00:00:00Z'); return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10); };
  const localToday = () => { const n = new Date(); return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0'); };
  const md = (d) => Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10));
  const dayLabel = (d) => md(d) + '(' + DOW[new Date(d + 'T00:00:00Z').getUTCDay()] + ')';
  let calWeek = mondayOf(localToday());
  let pFilter = 'active';
  let pQuery = '';

  const monthPick = document.getElementById('month-pick');
  monthPick.addEventListener('change', () => {
    const today = localToday();
    calWeek = mondayOf(today.slice(0, 7) === monthPick.value ? today : monthPick.value + '-01');
    dash.setParams({ month: monthPick.value });
  });
  const calPick = document.getElementById('cal-week');
  const setWeek = (w) => { calWeek = w; render(); };
  calPick.addEventListener('change', () => setWeek(calPick.value));
  document.getElementById('cal-prev').addEventListener('click', () => setWeek(addDays(calWeek, -7)));
  document.getElementById('cal-next').addEventListener('click', () => setWeek(addDays(calWeek, 7)));
  document.getElementById('cal-today').addEventListener('click', () => setWeek(mondayOf(localToday())));
  const dlg = document.getElementById('cal-dlg');
  document.getElementById('cal-dlg-x').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });
  document.getElementById('p-search').addEventListener('input', (ev) => { pQuery = ev.target.value.trim(); render(); });
  document.getElementById('p-filter').addEventListener('change', (ev) => { pFilter = ev.target.value; render(); });

  const tabs = [...document.querySelectorAll('.tm-tab')];
  const showTab = (id, link) => {
    tab = id;
    tabs.forEach((b) => b.setAttribute('aria-selected', String(b.getAttribute('aria-controls') === id)));
    ['hours', 'calendar', 'proposals', 'audit'].forEach((s) => { document.getElementById(s).hidden = s !== id; });
    if (link) dash.setLink(id);
    render();
  };
  tabs.forEach((b) => b.addEventListener('click', () => showTab(b.getAttribute('aria-controls'), true)));

  function tipBox(box) {
    let t = box.querySelector(':scope > .tm-tip');
    if (!t) { t = document.createElement('div'); t.className = 'tm-tip'; t.hidden = true; box.appendChild(t); }
    return t;
  }
  function showTip(box, ev, head, lines) {
    const t = tipBox(box);
    const h = document.createElement('div'); h.className = 'h'; h.textContent = head;
    t.replaceChildren(h, ...lines.map(([color, text]) => {
      const d = document.createElement('div');
      if (color) { const s = document.createElement('span'); s.className = 'tm-sw'; s.style.background = color; d.append(s); }
      d.append(document.createTextNode(text));
      return d;
    }));
    t.hidden = false;
    const r = box.getBoundingClientRect();
    let x = ev.clientX - r.left + 12;
    let y = ev.clientY - r.top + 12;
    if (x + t.offsetWidth > r.width) x = Math.max(0, ev.clientX - r.left - t.offsetWidth - 12);
    if (y + t.offsetHeight > r.height) y = Math.max(0, ev.clientY - r.top - t.offsetHeight - 12);
    t.style.left = x + 'px';
    t.style.top = y + 'px';
  }
  const hideTip = (box) => { const t = box.querySelector(':scope > .tm-tip'); if (t) t.hidden = true; };

  function failed(el) {
    const p = document.createElement('div'); p.className = 'tm-fail'; p.textContent = '불러오지 못함';
    el.replaceChildren(p);
  }
  function empty(el, text) {
    const p = document.createElement('p'); p.className = 'tm-empty'; p.textContent = text;
    el.replaceChildren(p);
  }
  const isBad = (s) => s === 'error' || s === 'connect' || s === 'declined' || s === 'missing';

  function legend(el, items) {
    el.replaceChildren(...items.map(([color, text]) => {
      const s = document.createElement('span');
      const sw = document.createElement('span'); sw.className = 'tm-sw'; sw.style.background = color;
      s.append(sw, document.createTextNode(text));
      return s;
    }));
  }

  function fillMarks(selector, source, where, rows) {
    const row = rows.find(where.match);
    document.querySelectorAll(selector).forEach((el) => {
      el.dataset.where = where.attr;
      el.classList.remove('dash-skeleton');
      const v = row ? row[el.dataset.field] : null;
      el.textContent = v === null || v === undefined ? '—' : typeof v === 'number' ? f1(v) : v;
    });
    return row;
  }

  function drawMix(el, rows) {
    el.replaceChildren();
    const W = el.clientWidth;
    if (!W) return;
    if (!rows.length) { empty(el, '이 달에 기록이 없습니다.'); return; }
    const rowH = 30;
    const svg = d3.select(el).append('svg').attr('width', '100%');
    const names = svg.append('g').selectAll('text').data(rows).join('text').attr('font-size', 12).style('fill', 'var(--color-fg)').text((d) => d.member);
    let labW = 0;
    names.each(function () { labW = Math.max(labW, this.getComputedTextLength()); });
    const m = { t: 6, r: 48, b: 26, l: Math.ceil(labW) + 12 };
    const H = m.t + m.b + rows.length * rowH;
    svg.attr('viewBox', `0 0 ${W} ${H}`).attr('height', H);
    const max = d3.max(rows, (r) => r.total) || 1;
    const x = d3.scaleLinear([0, max], [m.l, W - m.r]).nice();
    const ticks = x.ticks(W < 420 ? 3 : 5);
    svg.insert('g', ':first-child').selectAll('line').data(ticks).join('line')
      .attr('x1', (d) => x(d)).attr('x2', (d) => x(d)).attr('y1', m.t).attr('y2', H - m.b).style('stroke', 'var(--cds-chart-grid)');
    svg.append('g').selectAll('text').data(ticks).join('text').attr('x', (d) => x(d)).attr('y', H - 8).attr('text-anchor', 'middle').attr('font-size', 11).style('fill', 'var(--color-fg-muted)').text((d) => d + 'h');
    names.attr('x', m.l - 8).attr('text-anchor', 'end').attr('y', (d, i) => m.t + i * rowH + 15).attr('dy', '.32em');
    rows.forEach((r, i) => {
      const y = m.t + i * rowH + 7;
      let acc = 0;
      TYPES.forEach(([k, label], j) => {
        const v = r[k];
        if (!(v > 0)) return;
        svg.append('rect').attr('x', x(acc)).attr('y', y).attr('width', Math.max(1, x(acc + v) - x(acc) - 1)).attr('height', 16).attr('rx', 3).style('fill', dash.colors[j])
          .on('mousemove', (ev) => showTip(el, ev, r.member, TYPES.filter(([kk]) => r[kk] > 0).map(([kk, lab], jj) => [dash.colors[TYPES.findIndex((t) => t[0] === kk)], `${lab} ${f1(r[kk])}h`])))
          .on('mouseleave', () => hideTip(el));
        acc += v;
      });
      svg.append('text').attr('x', x(acc) + 6).attr('y', y + 8).attr('dy', '.32em').attr('font-size', 12).style('fill', 'var(--color-fg-muted)').text(f1(r.total) + 'h');
    });
  }

  function drawWeeks(el, weeks, month, refDate) {
    el.replaceChildren();
    const W = el.clientWidth;
    if (!W) return;
    const endDate = lastDayOf(month) < refDate ? lastDayOf(month) : refDate;
    const t = Date.parse(endDate + 'T00:00:00Z');
    const endWeek = new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * 864e5);
    const wk = d3.range(11, -1, -1).map((i) => new Date(endWeek.getTime() - i * 7 * 864e5).toISOString().slice(0, 10));
    const members = MEMBER_ORDER.filter((mbr) => weeks.some((w) => w.member === mbr && wk.includes(w.week)));
    if (!members.length) { empty(el, '이 기간에 기록이 없습니다.'); return; }
    const cols = W > 640 ? 4 : W > 340 ? 2 : 1;
    el.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    const cellW = (W - (cols - 1) * 16) / cols;
    const yMax = Math.max(48, d3.max(weeks.filter((w) => wk.includes(w.week)), (w) => w.total) || 0);
    const h = 74;
    const mt = 18;
    const mb = 4;
    const x = d3.scaleBand(wk, [0, cellW]).padding(0.25);
    const y = d3.scaleLinear([0, yMax], [h - mb, mt]);
    members.forEach((mbr) => {
      const box = document.createElement('div');
      box.style.position = 'relative';
      el.appendChild(box);
      const data = wk.map((w) => ({ week: w, total: (weeks.find((r) => r.member === mbr && r.week === w) || { total: 0 }).total }));
      const last = data[data.length - 1].total;
      const svg = d3.select(box).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${cellW} ${h}`).attr('height', h);
      svg.append('text').attr('x', 0).attr('y', 12).attr('font-size', 12).style('fill', 'var(--color-fg)').text(mbr);
      svg.append('text').attr('x', cellW).attr('y', 12).attr('text-anchor', 'end').attr('font-size', 11).style('fill', 'var(--color-fg-muted)').text(`이번 주 ${f1(last)}h`);
      svg.append('line').attr('x1', 0).attr('x2', cellW).attr('y1', y(40)).attr('y2', y(40)).style('stroke', 'var(--cds-chart-reference)').attr('stroke-dasharray', '3 3');
      svg.append('g').selectAll('rect').data(data).join('rect')
        .attr('x', (d) => x(d.week)).attr('width', x.bandwidth()).attr('y', (d) => y(d.total)).attr('height', (d) => Math.max(0, y(0) - y(d.total))).attr('rx', 2)
        .style('fill', (d) => (d.total > 52 ? 'var(--cds-chart-status-critical)' : d.week === wk[wk.length - 1] ? dash.colors[0] : 'var(--cds-chart-muted)'))
        .on('mousemove', (ev, d) => showTip(box, ev, `${mbr} · ${d.week} 주`, [[null, `${f1(d.total)}h`]]))
        .on('mouseleave', () => hideTip(box));
    });
  }

  function drawMemberTable(rows) {
    const tb = document.querySelector('#member-table tbody');
    tb.replaceChildren(...rows.map((r) => {
      const tr = document.createElement('tr');
      tr.dataset.key = enc(r.month) + ',' + enc(r.member);
      const cells = [r.member, f1(r.total), f1(r.proposal), f1(r.audit), f1(r.other), f1(r.training), f1(r.leave), String(r.missing), String(r.over8)];
      cells.forEach((v, i) => {
        const td = document.createElement('td');
        td.textContent = v;
        if (i > 0) td.className = 'n';
        if (i === 7 && r.missing > 0) td.className = 'n warn';
        if (i === 8 && r.over8 > 0) td.className = 'n warn';
        tr.appendChild(td);
      });
      return tr;
    }));
  }

  function drawProposals(rows, refDate) {
    const d90 = new Date(Date.parse(refDate + 'T00:00:00Z') - 90 * 864e5).toISOString().slice(0, 10);
    const q = pQuery.toLowerCase();
    const shown = rows.filter((p) => (pFilter === 'all' ? true : pFilter === '90' ? p.last >= d90 : p.status === '진행 중'))
      .filter((p) => !q || p.project.toLowerCase().includes(q) || p.members.toLowerCase().includes(q));
    document.getElementById('p-count').textContent = `${shown.length}건`;
    const scaleMax = Math.max(25, d3.max(shown, (p) => p.hours) || 0);
    const tb = document.querySelector('#p-table tbody');
    tb.replaceChildren(...shown.map((p) => {
      const tr = document.createElement('tr');
      const tdP = document.createElement('td'); tdP.className = 'proj'; tdP.textContent = p.project;
      const tdL = document.createElement('td'); tdL.textContent = p.last; tdL.className = 'muted';
      const tdS = document.createElement('td');
      const chips = document.createElement('span'); chips.className = 'tm-stages'; chips.setAttribute('aria-hidden', 'true');
      [p.s0, p.s1, p.s2, p.s3, p.s4, p.s5].forEach((on) => { const c = document.createElement('span'); c.className = 'tm-stage'; if (on) c.style.background = dash.colors[0]; chips.append(c); });
      tdS.append(chips, document.createTextNode(p.stageLabel));
      const tdH = document.createElement('td'); tdH.className = 'n';
      const bar = document.createElement('span'); bar.className = 'tm-hbar'; bar.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('i'); fill.style.width = Math.min(100, (p.hours / scaleMax) * 100) + '%'; fill.style.background = p.hours > 15 * 1.5 ? 'var(--cds-chart-status-critical)' : dash.colors[0];
      const tick = document.createElement('b'); tick.style.left = (15 / scaleMax) * 100 + '%';
      bar.append(fill, tick);
      tdH.append(document.createTextNode(f1(p.hours)), bar);
      const tdM = document.createElement('td'); tdM.textContent = p.members;
      const tdT = document.createElement('td');
      const pill = document.createElement('span');
      pill.className = 'tm-pill ' + (p.status === '진행 중' ? 'go' : p.status === '14일 넘게 기록 없음' ? 'stale' : 'done');
      pill.textContent = p.status;
      tdT.append(pill);
      tr.append(tdP, tdL, tdS, tdH, tdM, tdT);
      return tr;
    }));
  }

  function drawLanes(el, days, month) {
    el.replaceChildren();
    const W = el.clientWidth;
    if (!W) return;
    const inMonth = days.filter((d) => d.month === month);
    const legendEl = document.getElementById('lane-legend');
    if (!inMonth.length) { legendEl.replaceChildren(); empty(el, '이 달에 기록된 감리가 없습니다.'); return; }
    const projects = [...new Set(inMonth.map((d) => d.project))];
    const color = (p) => dash.colors[projects.indexOf(p) % dash.colors.length];
    legend(legendEl, projects.map((p) => [color(p), p]));
    const members = MEMBER_ORDER.filter((mbr) => inMonth.some((d) => d.member === mbr));
    const n = Number(lastDayOf(month).slice(8, 10));
    const dates = d3.range(1, n + 1).map((i) => month + '-' + String(i).padStart(2, '0'));
    const svg = d3.select(el).append('svg').attr('width', '100%');
    const names = svg.append('g').selectAll('text').data(members).join('text').attr('font-size', 12).style('fill', 'var(--color-fg)').text((d) => d);
    let labW = 0;
    names.each(function () { labW = Math.max(labW, this.getComputedTextLength()); });
    const m = { t: 6, r: 8, b: 24, l: Math.ceil(labW) + 12 };
    const rowH = 26;
    const H = m.t + m.b + members.length * rowH;
    svg.attr('viewBox', `0 0 ${W} ${H}`).attr('height', H);
    const x = d3.scaleBand(dates, [m.l, W - m.r]).padding(0.12);
    svg.insert('g', ':first-child').selectAll('rect').data(dates.filter((d) => [0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay()))).join('rect')
      .attr('x', (d) => x(d)).attr('width', x.bandwidth()).attr('y', m.t).attr('height', H - m.t - m.b).style('fill', 'var(--cds-chart-grid)').attr('opacity', 0.5);
    names.attr('x', m.l - 8).attr('text-anchor', 'end').attr('y', (d, i) => m.t + i * rowH + 12).attr('dy', '.32em');
    const step = W < 420 ? 7 : W < 700 ? 5 : 2;
    svg.append('g').selectAll('text').data(dates.filter((d, i) => i % step === 0)).join('text')
      .attr('x', (d) => x(d) + x.bandwidth() / 2).attr('y', H - 8).attr('text-anchor', 'middle').attr('font-size', 11).style('fill', 'var(--color-fg-muted)').text((d) => Number(d.slice(8, 10)));
    inMonth.forEach((d) => {
      const i = members.indexOf(d.member);
      const y = m.t + i * rowH + 3;
      svg.append('rect').attr('x', x(d.date)).attr('y', y).attr('width', x.bandwidth()).attr('height', 18).attr('rx', 3).style('fill', color(d.project))
        .on('mousemove', (ev) => showTip(el, ev, `${d.member} · ${d.date}`, [[color(d.project), d.project], [null, d.proposalHours > 0 ? `같은 날 제안 ${f1(d.proposalHours)}h` : '제안 기록 없음']]))
        .on('mouseleave', () => hideTip(el));
      if (d.proposalHours > 0) {
        svg.append('circle').attr('cx', x(d.date) + x.bandwidth() / 2).attr('cy', y + 9).attr('r', Math.min(3.5, x.bandwidth() / 4)).style('fill', 'var(--cds-chart-status-critical)').style('pointer-events', 'none');
      }
    });
  }

  function drawRuns(runs, month) {
    const start = month + '-01';
    const end = lastDayOf(month);
    const shown = runs.filter((r) => r.start <= end && r.end >= start).sort((a, b) => byOrder(a, b) || (a.start < b.start ? -1 : 1));
    const tb = document.querySelector('#run-table tbody');
    if (!shown.length) {
      const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 6; td.className = 'muted'; td.textContent = '이 달과 겹치는 감리 기간이 없습니다.'; tr.append(td);
      tb.replaceChildren(tr);
      return;
    }
    tb.replaceChildren(...shown.map((r) => {
      const tr = document.createElement('tr');
      tr.dataset.key = enc(r.member) + ',' + enc(r.start);
      [r.member, r.project, r.start, r.end, String(r.days), String(r.overlap)].forEach((v, i) => {
        const td = document.createElement('td'); td.textContent = v;
        if (i === 1) td.className = 'proj';
        if (i >= 4) td.className = 'n' + (i === 5 && r.overlap > 0 ? ' warn' : '');
        tr.append(td);
      });
      return tr;
    }));
  }

  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  function taskLines(t, today) {
    const diff = Math.round((Date.parse(t.deadline + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 864e5);
    const dd = diff === 0 ? 'D-day' : diff > 0 ? 'D-' + diff : 'D+' + -diff + ' 지남';
    const lines = [];
    if (t.org) lines.push([null, '기관 ' + t.org]);
    if (t.budget) lines.push([null, '금액 ' + t.budget]);
    lines.push([diff >= 0 && diff <= 3 ? 'var(--color-warn)' : null, '마감 ' + t.deadline + (t.time ? ' ' + t.time : '') + ' · ' + dd]);
    if (t.eval) lines.push([null, '평가 ' + t.eval]);
    lines.push([null, t.assignees.length ? '정담당 ' + t.assignees[0] + (t.assignees.length > 1 ? ' · 부담당 ' + t.assignees.slice(1).join(', ') : '') : '담당 미배정']);
    return lines;
  }

  function taskChips(list) {
    const box = mk('div', 'tm-tasks');
    list.forEach((t) => {
      const c = mk('span', 'tm-tchip' + (t.assignees.length ? '' : ' un'));
      if (t.assignees.length) c.style.setProperty('--c', dash.colors[0]);
      c.dataset.task = JSON.stringify(t);
      if (t.assignees.length) c.append(mk('b', '', t.assignees[0] + (t.assignees.length > 1 ? '+' + (t.assignees.length - 1) : '')));
      c.append(document.createTextNode(t.project));
      box.append(c);
    });
    return box;
  }

  function openDay(name, d, cell, tasks) {
    document.getElementById('cal-dlg-title').textContent = `${name} · ${d.slice(0, 4)}년 ${dayLabel(d)}`;
    const body = document.getElementById('cal-dlg-body');
    body.replaceChildren();
    if (cell && cell.items.length) {
      const ul = mk('ul', 'tm-items');
      cell.items.forEach((it) => {
        const li = mk('li', 'tm-item');
        const chip = mk('span', 'tm-chip');
        const sw = mk('span', 'tm-sw'); sw.style.background = dash.colors[Math.max(0, TYPES.findIndex((t) => t[1] === it.type))];
        chip.append(sw, document.createTextNode(it.type));
        const main = it.detail || it.project || it.sub || it.mid || '(내용 없음)';
        const meta = [it.mid, it.sub, it.detail ? it.project : ''].filter((v) => v && v !== main).join(' · ');
        li.append(chip, mk('span', 't', main), mk('span', 'hh', f1(it.hours) + 'h'));
        if (meta) li.append(mk('span', 's', meta));
        ul.append(li);
      });
      const sum = mk('li', 'tm-item sum');
      sum.append(mk('span', '', ''), mk('span', 't', '합계'), mk('span', 'hh', f1(cell.total) + 'h'));
      ul.append(sum);
      body.append(ul);
    } else {
      body.append(mk('p', 'tm-empty', '이 날 업무일지 기록이 없습니다.'));
    }
    if (tasks.length) {
      body.append(mk('h3', '', '이 날 제안 마감'));
      const today = localToday();
      tasks.forEach((t) => {
        const art = mk('div', 'tm-note');
        art.style.marginBottom = 'var(--cds-gap-sm)';
        art.append(mk('div', '', t.project));
        taskLines(t, today).forEach(([, line]) => art.append(mk('div', '', line)));
        body.append(art);
      });
    }
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }

  function drawCalendar() {
    const wrap = document.getElementById('cal-wrap');
    const host = document.getElementById('cal-host');
    const cells = dash.data('day_cells');
    const dl = dash.data('deadlines');
    const hol = dash.data('holiday_days');
    const year = calWeek.slice(0, 4);
    const weeks = [];
    for (let w = mondayOf(year + '-01-01'); w <= mondayOf(year + '-12-31'); w = addDays(w, 7)) weeks.push(w);
    if (!weeks.includes(calWeek)) weeks.push(calWeek);
    calPick.replaceChildren(...weeks.map((w) => new Option(`${md(w)}(월) ~ ${md(addDays(w, 6))}(일)`, w)));
    calPick.value = calWeek;
    const today = localToday();
    const days = d3.range(7).map((i) => addDays(calWeek, i));
    const end = days[6];
    document.getElementById('cal-title').textContent = `${calWeek.slice(0, 4)}년 ${md(calWeek)} ~ ${md(end)} 주간 근무표`;
    legend(document.getElementById('cal-legend'), TYPES.map(([, label], j) => [dash.colors[j], label]).concat([[dash.colors[0], '제안 마감(작업배정)']]));
    const kpiIds = ['ck-hours', 'ck-due', 'ck-un', 'ck-field', 'ck-away', 'ck-miss'];
    if (isBad(cells.status)) { failed(wrap); kpiIds.forEach((id) => { const e = document.getElementById(id); e.classList.remove('dash-skeleton'); e.textContent = '—'; }); return; }
    if (cells.status !== 'ok') return;

    const holMap = new Map((hol.status === 'ok' ? hol.data : []).map((h) => [h.date, h.name]));
    const cellMap = new Map();
    cells.data.forEach((c) => { if (c.date >= calWeek && c.date <= end) cellMap.set(c.member + '|' + c.date, c); });
    const tasks = dl.status === 'ok' ? dl.data.filter((t) => t.deadline >= calWeek && t.deadline <= end) : [];
    const mine = (n, d) => tasks.filter((t) => t.deadline === d && t.assignees.includes(n));
    const orphan = (d) => tasks.filter((t) => t.deadline === d && !t.assignees.some((a) => CAL_MEMBERS.includes(a)));
    const meta = days.map((d) => {
      const w = new Date(d + 'T00:00:00Z').getUTCDay();
      const off = w === 0 || w === 6 || holMap.has(d);
      const any = CAL_MEMBERS.some((n) => cellMap.has(n + '|' + d)) || tasks.some((t) => t.deadline === d);
      return { d, off, hol: holMap.get(d) || '', merge: off && !any };
    });

    // KPIs
    let hours = 0; let field = 0; let away = 0; let miss = 0;
    CAL_MEMBERS.forEach((n) => meta.forEach((m) => {
      const c = cellMap.get(n + '|' + m.d);
      if (c) { hours += c.total; if (c.status === 'field') field += 1; if (c.status === 'vacation' || c.status === 'education') away += 1; }
      else if (!m.off && m.d < today) miss += 1;
    }));
    const un = meta.reduce((s, m) => s + orphan(m.d).length, 0);
    [['ck-hours', f1(Math.round(hours * 10) / 10)], ['ck-due', dl.status === 'ok' ? String(tasks.length) : '—'], ['ck-un', dl.status === 'ok' ? String(un) : '—'], ['ck-field', String(field)], ['ck-away', String(away)], ['ck-miss', String(miss)]]
      .forEach(([id, v]) => { const e = document.getElementById(id); e.classList.remove('dash-skeleton'); e.textContent = v; });
    document.getElementById('ck-un-box').classList.toggle('warn', un > 0);
    document.getElementById('ck-miss-box').classList.toggle('warn', miss > 0);

    const table = mk('table', 'tm-cal');
    const thead = mk('thead'); const hr = mk('tr');
    hr.append(mk('th', 'who', '팀원'));
    meta.forEach((m) => {
      const th = mk('th', [m.off ? 'off' : '', m.merge ? 'narrow' : '', m.d === today ? 'today' : ''].filter(Boolean).join(' '));
      th.append(mk('span', 'd', m.merge ? md(m.d) : dayLabel(m.d)));
      if (m.merge) th.append(mk('span', '', DOW[new Date(m.d + 'T00:00:00Z').getUTCDay()]));
      if (m.hol) th.append(mk('div', 'hol', m.hol));
      const o = orphan(m.d).length;
      if (o && !m.merge) th.append(mk('div', '', `미배정 ${o}건`));
      hr.append(th);
    });
    thead.append(hr);

    const tbody = mk('tbody');
    CAL_MEMBERS.forEach((n) => {
      const tr = mk('tr');
      tr.append(mk('td', 'who', n));
      meta.forEach((m) => {
        if (m.merge) { tr.append(mk('td', 'off')); return; }
        const c = cellMap.get(n + '|' + m.d);
        const tl = mine(n, m.d);
        const td = mk('td', 'cell' + (m.off ? ' off' : ''));
        td.tabIndex = 0;
        td.setAttribute('role', 'button');
        td.setAttribute('aria-label', `${n} ${dayLabel(m.d)} ${c ? f1(c.total) + '시간' : '기록 없음'}`);
        if (c) {
          const st = STATUS[c.status];
          if (st) { const s = mk('span', 'tm-st', st[0]); s.style.color = st[1] === null ? 'var(--color-warn)' : dash.colors[st[1]]; td.append(s); }
          td.append(mk('span', 'tm-h', f1(c.total) + 'h'));
          const kinds = TYPES.filter(([k]) => c[k] > 0);
          if (c.status === 'office' || c.status === 'mixed' || kinds.length > 1) {
            const chips = mk('div', 'tm-chips');
            kinds.forEach(([k, label]) => {
              const ch = mk('span', 'tm-chip');
              const sw = mk('span', 'tm-sw'); sw.style.background = dash.colors[TYPES.findIndex((t) => t[0] === k)];
              ch.append(sw, document.createTextNode(`${label} ${f1(c[k])}h`));
              chips.append(ch);
            });
            td.append(chips);
          }
        } else if (!m.off && m.d < today) {
          td.append(mk('span', 'tm-h warn', '미입력'));
        }
        if (tl.length) td.append(taskChips(tl));
        const open = () => openDay(n, m.d, c, tl);
        td.addEventListener('click', (ev) => { if (!ev.target.closest('.tm-tchip')) open(); });
        td.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
        tr.append(td);
      });
      tbody.append(tr);
    });
    if (meta.some((m) => orphan(m.d).length)) {
      const tr = mk('tr', 'unrow');
      tr.append(mk('td', 'who', '미배정'));
      meta.forEach((m) => { const td = mk('td', m.off ? 'off' : ''); const o = orphan(m.d); if (o.length && !m.merge) td.append(taskChips(o)); tr.append(td); });
      tbody.append(tr);
    }

    const tfoot = mk('tfoot'); const fr = mk('tr');
    fr.append(mk('td', 'who', '일별 합계'));
    meta.forEach((m) => {
      const td = mk('td', m.off ? 'off' : '');
      if (!m.merge) {
        let sum = 0; const cnt = { office: 0, field: 0, vacation: 0, education: 0 };
        CAL_MEMBERS.forEach((n) => { const c = cellMap.get(n + '|' + m.d); if (c) { sum += c.total; cnt[c.status === 'mixed' ? 'office' : c.status] += 1; } });
        if (sum > 0) td.append(mk('b', '', f1(Math.round(sum * 10) / 10) + 'h'));
        const parts = [['사무실', cnt.office], ['감리', cnt.field], ['휴가', cnt.vacation], ['교육', cnt.education]].filter(([, v]) => v).map(([k, v]) => k + ' ' + v);
        if (parts.length) td.append(mk('span', '', parts.join(' · ')));
      }
      fr.append(td);
    });
    tfoot.append(fr);
    table.append(thead, tbody, tfoot);
    wrap.replaceChildren(table);

    table.addEventListener('mousemove', (ev) => {
      const chip = ev.target.closest('.tm-tchip');
      if (!chip) { hideTip(host); return; }
      const t = JSON.parse(chip.dataset.task);
      showTip(host, ev, t.project, taskLines(t, today));
    });
    table.addEventListener('mouseleave', () => hideTip(host));
  }

  function render() {
    const sheetBad = IDS.filter((id) => isBad(dash.data(id).status));
    const alertEl = document.getElementById('load-alert');
    alertEl.hidden = !sheetBad.length;
    alertEl.textContent = sheetBad.length ? `불러오지 못한 업무일지: ${sheetBad.map((id) => NAMES[id]).join(', ')} (시트 공유 권한 확인)` : '';

    const refD = dash.data('ref');
    const tm = dash.data('team_month');
    const refRow = refD.status === 'ok' && refD.data.length ? refD.data[0] : null;
    if (refRow && !dash.params().month) { dash.setParams({ month: refRow.month }); return; }
    const month = dash.params().month || (refRow ? refRow.month : '');
    const refDate = refRow ? refRow.ref : '';

    document.getElementById('take-month').textContent = monthLabel(month);
    if (tm.status === 'ok') {
      const months = tm.data.map((r) => r.month).filter((m) => !refRow || m <= refRow.month);
      monthPick.replaceChildren(...months.map((m) => new Option(`${m.slice(0, 4)}년 ${Number(m.slice(5, 7))}월`, m)));
      monthPick.value = month;
    }
    const whereMonth = { attr: 'month=' + enc(month), match: (r) => r.month === month };

    document.querySelectorAll('[data-source="ref"]').forEach((el) => {
      el.classList.remove('dash-skeleton');
      el.textContent = refRow ? refRow.ref : '—';
    });
    if (tm.status === 'ok') {
      const row = fillMarks('[data-source="team_month"][data-field]', 'team_month', whereMonth, tm.data);
      document.getElementById('kpi-missing').classList.toggle('warn', !!(row && row.missing > 0));
    }

    if (tab === 'hours') {
      const mm = dash.data('member_month');
      const mw = dash.data('member_week');
      const mix = document.getElementById('mix-chart');
      const wkEl = document.getElementById('week-chart');
      legend(document.getElementById('mix-legend'), TYPES.map(([, label], j) => [dash.colors[j], label]));
      if (mm.status === 'ok') {
        const rows = mm.data.filter((r) => r.month === month).sort(byOrder);
        drawMix(mix, rows.filter((r) => r.total > 0));
        drawMemberTable(rows);
      } else if (isBad(mm.status) || mm.status === 'error') { failed(mix); document.querySelector('#member-table tbody').replaceChildren(); } else { mix.replaceChildren(); }
      if (mw.status === 'ok' && refRow) drawWeeks(wkEl, mw.data, month, refDate);
      else if (isBad(mw.status)) failed(wkEl); else wkEl.replaceChildren();
    }

    if (tab === 'calendar') drawCalendar();

    if (tab === 'proposals') {
      const ps = dash.data('proposal_summary');
      if (ps.status === 'ok') {
        document.querySelectorAll('[data-source="proposal_summary"]').forEach((el) => {
          el.classList.remove('dash-skeleton');
          const v = ps.data[0] ? ps.data[0][el.dataset.field] : null;
          el.textContent = v === null || v === undefined ? '—' : f1(v);
        });
      }
      const pr = dash.data('proposals');
      if (pr.status === 'ok' && refRow) drawProposals(pr.data, refDate);
      else if (isBad(pr.status)) document.querySelector('#p-table tbody').replaceChildren();
    }

    if (tab === 'audit') {
      const atm = dash.data('audit_team_month');
      if (atm.status === 'ok') fillMarks('.m-audit', 'audit_team_month', whereMonth, atm.data);
      const ad = dash.data('audit_days');
      const lane = document.getElementById('lane-chart');
      if (ad.status === 'ok') drawLanes(lane, ad.data, month);
      else if (isBad(ad.status)) failed(lane); else lane.replaceChildren();
      const ar = dash.data('audit_runs');
      if (ar.status === 'ok') drawRuns(ar.data, month);
    }
  }

  dash.onData(render);

  const named = location.hash.slice(1);
  if (['hours', 'calendar', 'proposals', 'audit'].includes(named)) showTab(named, false);
})();
