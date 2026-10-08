import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('src/admin/frontend/js/js_03_ui_dashboard.html', 'utf8');
const start = source.indexOf('let viewRefreshTimer_ = null;');
const end = source.indexOf('function nav(', start);
if(start < 0 || end < 0) throw new Error('view refresh scheduler source not found');

let pass = 0;
let fail = 0;
function check(name, condition, detail) {
  if(condition) { pass++; return; }
  fail++;
  console.error(`FAIL ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`);
}

const timers = [];
const calls = {};
let currentSection = 'sect-tracker';
let blurHandler = null;
let activeElement = null;
const count = name => { calls[name] = (calls[name] || 0) + 1; };
const ctx = {
  console,
  setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; },
  clearTimeout() {},
  document: {
    activeElement: null,
    querySelector(selector) { return selector === '.sect.on' ? { id: currentSection } : null; },
  },
  currentPosDetailId: null,
  updateMetrics: () => count('metrics'),
  renderDashboard: () => count('dashboard'),
  renderRecruitStatus: () => count('recruitStatus'),
  renderTracker: () => count('tracker'),
  renderPositions: () => count('positions'),
  renderIntTable: () => count('interviews'),
  renderReferralSection: () => count('referral'),
  renderReference: () => count('reference'),
  renderOnboarding: () => count('onboarding'),
  renderNotifyLog: () => count('notifyLog'),
  renderActivityLog: () => count('activityLog'),
  renderPeriodReport: () => count('periodReport'),
  renderTeamMaster: () => count('teamMaster'),
  renderNotifyTeamChips_: () => count('notifyTeams'),
  refreshOpenPositionDetail: () => count('positionDetail'),
  autoGrowRefReportTextareas_: () => count('autoGrow'),
};
vm.createContext(ctx);
vm.runInContext(source.slice(start, end), ctx);

ctx.scheduleViewRefresh_();
ctx.scheduleViewRefresh_();
ctx.scheduleViewRefresh_();
check('연속 저장은 렌더 예약 한 번으로 병합', timers.length === 1 && timers[0].delay === 0, timers);
timers.shift().fn();
check('대시보드와 사이드바 지표 갱신', calls.dashboard === 1 && calls.metrics === 1, calls);
check('현재 트래커 화면만 추가 갱신', calls.tracker === 1 && !calls.positions && !calls.interviews && !calls.referral, calls);

activeElement = {
  type: 'text',
  matches: selector => selector.includes('input'),
  closest: selector => selector === '.sect' ? {} : null,
  addEventListener: (name, handler) => { if(name === 'blur') blurHandler = handler; },
};
ctx.document.activeElement = activeElement;
ctx.scheduleViewRefresh_();
timers.shift().fn();
check('입력 중에는 화면 갱신 보류', calls.dashboard === 1 && typeof blurHandler === 'function', calls);
ctx.document.activeElement = null;
blurHandler();
check('입력 종료 후 다시 한 번 예약', timers.length === 1 && timers[0].delay === 0, timers);
timers.shift().fn();
check('입력 종료 후 현재 화면 갱신', calls.dashboard === 2 && calls.tracker === 2 && calls.metrics === 2, calls);

currentSection = 'sect-posdetail';
ctx.currentPosDetailId = 17;
ctx.scheduleViewRefresh_();
timers.shift().fn();
check('열린 포지션 상세 갱신', calls.positionDetail === 1, calls);

console.log(`View refresh tests: ${pass} passed, ${fail} failed`);
if(fail) process.exit(1);
