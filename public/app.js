const $ = (selector) => document.querySelector(selector);
const state = {
  clients: [],
  groups: [],
  selectedAccount: '',
  selectedTarget: null,
  mediaStream: null,
  mediaKind: null,
  mediaStartedAt: 0,
  mediaTimer: null,
  busy: new Set(),
};

const api = async (url, options = {}) => {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
};
const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body) });

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function selectedAccounts() { return state.selectedAccount ? [state.selectedAccount] : []; }
function selectedSession() {
  return state.selectedTarget && state.selectedAccount ? { account: state.selectedAccount, ...state.selectedTarget } : null;
}
function addActivity(title, detail, tone = '') {
  const list = $('#activityList');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'activity-row';
  row.innerHTML = `<span class="activity-dot ${tone}"></span><div><strong>${escapeHTML(title)}</strong><small>${escapeHTML(detail)}</small></div><time>الآن</time>`;
  list.prepend(row);
  while (list.children.length > 4) list.lastElementChild.remove();
}
function toast(message, tone = '') {
  const region = $('#toastRegion');
  const item = document.createElement('div');
  item.className = `toast ${tone}`;
  item.textContent = message;
  region.appendChild(item);
  setTimeout(() => { item.classList.add('out'); setTimeout(() => item.remove(), 320); }, 3600);
}
function feedback(id, message, tone = '') {
  const element = $(id);
  if (!element) return;
  element.textContent = message || '';
  element.className = `inline-feedback ${tone}`;
}
function setBusy(key, busy) {
  if (busy) state.busy.add(key); else state.busy.delete(key);
  const button = ({ connect: '#connectButton', refresh: '#refreshButton', join: '#joinButton', joinAll: '#joinAllButton', leave: '#leaveButton' }[key]);
  if (button) $(button).disabled = busy;
}

async function loadClients(preferred = '') {
  const data = await api('/api/discord/clients');
  state.clients = data.clients || [];
  const select = $('#accountSelect');
  const current = preferred || state.selectedAccount;
  select.innerHTML = state.clients.length
    ? state.clients.map((client) => `<option value="${escapeHTML(client.name)}">${escapeHTML(client.displayName || client.username || client.name)}</option>`).join('')
    : '<option value="">اتصل بحساب أولًا</option>';
  state.selectedAccount = state.clients.some((client) => client.name === current) ? current : (state.clients[0]?.name || '');
  select.value = state.selectedAccount;
  $('#accountBadge').textContent = state.clients.length ? `${state.clients.length} حساب متصل` : 'لا توجد حسابات';
  $('#connectionLabel').textContent = state.clients.length ? `${state.clients.length} حساب متصل` : 'جاهز للاتصال';
  await loadGuilds();
}
async function loadGuilds() {
  state.groups = [];
  state.selectedTarget = null;
  renderChannels();
  if (!state.selectedAccount) return;
  try {
    const data = await api(`/api/voice/guilds?account=${encodeURIComponent(state.selectedAccount)}`);
    state.groups = data.guilds || [];
    renderChannels();
  } catch (error) {
    feedback('#connectFeedback', error.message, 'error');
  }
}
function renderChannels() {
  const select = $('#channelSelect');
  if (!state.groups.length) {
    select.innerHTML = '<option value="">لا توجد قنوات صوتية متاحة</option>';
    updateChannelSummary();
    return;
  }
  select.innerHTML = `<option value="">اختر قناة صوتية</option>${state.groups.map((group) => `<optgroup label="${escapeHTML(group.guildName)}">${group.voiceChannels.map((channel) => `<option value="${escapeHTML(group.guildId)}::${escapeHTML(channel.id)}">${escapeHTML(channel.name)}${channel.members ? ` · ${channel.members} متصل` : ''}</option>`).join('')}</optgroup>`).join('')}`;
  updateChannelSummary();
}
function handleChannelChange() {
  const value = $('#channelSelect').value;
  if (!value) { state.selectedTarget = null; updateChannelSummary(); return; }
  const [guildId, channelId] = value.split('::');
  const group = state.groups.find((item) => item.guildId === guildId);
  const channel = group?.voiceChannels.find((item) => item.id === channelId);
  state.selectedTarget = group && channel ? { guildId, channelId, guildName: group.guildName, channelName: channel.name } : null;
  updateChannelSummary();
}
function updateChannelSummary() {
  const summary = $('#channelSummary');
  const label = $('#channelStatus');
  if (!state.selectedTarget) {
    summary.className = 'channel-summary empty';
    summary.innerHTML = '<span class="summary-icon">⌁</span><div><strong>لم يتم اختيار وجهة بعد</strong><small>بعد الاتصال، ستظهر الخوادم والقنوات المتاحة هنا.</small></div>';
    label.className = 'live-label';
    label.innerHTML = '<span></span> غير محدد';
    return;
  }
  summary.className = 'channel-summary';
  summary.innerHTML = `<span class="summary-icon">⌁</span><div><strong>${escapeHTML(state.selectedTarget.channelName)}</strong><small>${escapeHTML(state.selectedTarget.guildName)} · ${escapeHTML(state.selectedAccount)}</small></div>`;
  label.className = 'live-label is-live';
  label.innerHTML = '<span></span> وجهة محددة';
}
function requireTarget() {
  if (!state.selectedAccount) { toast('اتصل بحساب قبل تنفيذ الأمر', 'error'); return false; }
  if (!state.selectedTarget) { toast('اختر خادمًا وقناة صوتية أولًا', 'error'); return false; }
  return true;
}
function requireAccount() {
  if (!state.selectedAccount) { toast('اتصل بحساب قبل تنفيذ الأمر', 'error'); return false; }
  return true;
}

async function connect() {
  if (state.busy.has('connect')) return;
  const token = $('#tokenInput').value.trim();
  const name = $('#accountName').value.trim();
  if (!token) { feedback('#connectFeedback', 'أدخل Discord Token للمتابعة.', 'error'); return; }
  setBusy('connect', true); feedback('#connectFeedback', 'جارٍ فتح اتصال Gateway والتحقق منه…');
  try {
    const data = await post('/api/discord/connect', { token, name });
    $('#tokenInput').value = '';
    $('#accountName').value = data.name || name;
    feedback('#connectFeedback', `تم الاتصال باسم ${data.username || data.name}.`, 'success');
    addActivity('تم الاتصال', data.username || data.name, 'success');
    toast('تم الاتصال بالحساب بنجاح', 'success');
    await loadClients(data.name);
    await refreshSessions();
  } catch (error) {
    feedback('#connectFeedback', error.message, 'error');
    addActivity('تعذر الاتصال', error.message, 'error');
    toast(error.message, 'error');
  } finally { setBusy('connect', false); }
}
async function disconnect() {
  if (!state.selectedAccount) { toast('لا يوجد حساب متصل لفصله', 'error'); return; }
  try {
    await post('/api/discord/disconnect', { name: state.selectedAccount });
    addActivity('تم فصل الحساب', state.selectedAccount);
    toast('تم فصل الحساب', 'success');
    state.selectedAccount = '';
    await loadClients();
    await refreshSessions();
  } catch (error) { toast(error.message, 'error'); }
}
async function refreshChannels() {
  if (!state.selectedAccount) { toast('اتصل بحساب أولًا', 'error'); return; }
  setBusy('refresh', true);
  try { await loadGuilds(); toast('تم تحديث القنوات', 'success'); addActivity('تحديث القنوات', 'تم جلب القنوات المتاحة'); }
  catch (error) { toast(error.message, 'error'); }
  finally { setBusy('refresh', false); }
}

async function join() {
  if (!requireTarget() || state.busy.has('join')) return;
  setBusy('join', true);
  try {
    const result = await post('/api/voice/join', { accounts: selectedAccounts(), guildId: state.selectedTarget.guildId, channelId: state.selectedTarget.channelId });
    const success = result.summary?.ok || 0;
    if (!success) throw new Error(result.results?.find((item) => !item.ok)?.error || 'تعذر الدخول إلى القناة');
    addActivity('دخلت الغرفة', `${state.selectedTarget.guildName} · ${state.selectedTarget.channelName}`, 'success');
    toast(`تم الدخول إلى ${state.selectedTarget.channelName}`, 'success');
    await refreshSessions();
  } catch (error) { toast(error.message, 'error'); addActivity('تعذر دخول الغرفة', error.message, 'error'); }
  finally { setBusy('join', false); }
}
async function joinAll() {
  if (!requireTarget() || state.busy.has('joinAll')) return;
  setBusy('joinAll', true);
  try {
    const result = await post('/api/voice/join-all', { guildId: state.selectedTarget.guildId, channelId: state.selectedTarget.channelId });
    if (!result.summary?.ok) throw new Error(result.results?.find((item) => !item.ok)?.error || 'تعذر دخول الحسابات');
    toast(`تم دخول ${result.summary.ok} حساب`, 'success'); addActivity('دخول الجميع', `${result.summary.ok} حساب إلى القناة`, 'success'); await refreshSessions();
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy('joinAll', false); }
}
async function leave() {
  if (!requireAccount() || !state.selectedTarget || state.busy.has('leave')) { if (requireAccount() && !state.selectedTarget) toast('اختر قناة مرتبطة بالجلسة قبل الخروج', 'error'); return; }
  setBusy('leave', true);
  try {
    const result = await post('/api/voice/leave', { accounts: selectedAccounts(), guildId: state.selectedTarget.guildId });
    if (!result.summary?.ok) throw new Error(result.results?.find((item) => !item.ok)?.error || 'تعذر الخروج');
    toast('تم الخروج من الغرفة', 'success'); addActivity('خرجت من الغرفة', state.selectedTarget.channelName, 'success'); await refreshSessions();
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy('leave', false); }
}
async function applyState(kind) {
  if (!requireAccount()) return;
  const values = {
    mute: { selfMute: true, selfDeaf: false, selfVideo: false, selfStream: false, label: 'تم كتم الصوت' },
    deaf: { selfMute: true, selfDeaf: true, selfVideo: false, selfStream: false, label: 'تم تفعيل العزل' },
    unmute: { selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false, label: 'تم فتح الصوت' },
    cam: { selfMute: false, selfDeaf: false, selfVideo: true, selfStream: false, label: 'تم تحديث حالة الفيديو' },
  };
  const next = values[kind];
  if (!next) return;
  if (kind === 'cam') {
    await toggleCamera();
    return;
  }
  if (!state.selectedTarget) { toast('ادخل غرفة أولًا لتغيير الحالة', 'error'); return; }
  try {
    const result = await post('/api/voice/state', { accounts: selectedAccounts(), guildId: state.selectedTarget.guildId, ...next });
    if (!result.summary?.ok) throw new Error(result.results?.find((item) => !item.ok)?.error || 'تعذر تحديث الحالة');
    document.querySelectorAll('.state-button').forEach((button) => button.classList.toggle('is-active', button.dataset.state === kind));
    feedback('#stateFeedback', next.label, 'success'); addActivity('تحديث الحالة', next.label, 'success'); toast(next.label, 'success'); await refreshSessions();
  } catch (error) { feedback('#stateFeedback', error.message, 'error'); toast(error.message, 'error'); }
}

function formatDuration(seconds) { return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }
function renderSessions(sessions = []) {
  $('#navSessionCount').textContent = String(sessions.length);
  const list = $('#sessionsList');
  if (!sessions.length) {
    list.innerHTML = '<div class="empty-state"><span class="empty-pulse"></span><p>لا توجد جلسات نشطة الآن</p><small>عند الدخول إلى غرفة ستظهر تفاصيلها هنا.</small></div>';
    return;
  }
  list.innerHTML = sessions.map((session) => `<div class="session-row"><span class="session-avatar">${escapeHTML((session.name || '?')[0].toUpperCase())}</span><div class="session-info"><strong>${escapeHTML(session.name)}</strong><small>${escapeHTML(session.guildId)} · ${escapeHTML(session.channelId)}</small></div><div class="session-state">${session.selfMute ? '◌' : '♫'}${session.selfDeaf ? ' ⊘' : ''}${session.selfVideo ? ' ▣' : ''}${session.selfStream ? ' ▤' : ''}</div><button class="session-leave" type="button" data-leave-name="${escapeHTML(session.name)}" data-leave-guild="${escapeHTML(session.guildId)}" title="خروج">×</button></div>`).join('');
  list.querySelectorAll('[data-leave-name]').forEach((button) => button.addEventListener('click', () => quickLeave(button.dataset.leaveName, button.dataset.leaveGuild)));
}
async function refreshSessions() {
  try {
    const data = await api('/api/voice/sessions');
    renderSessions(data.sessions || []);
  } catch (error) { console.warn('[voice] sessions refresh failed', error); }
}
async function quickLeave(name, guildId) {
  try { await post('/api/voice/leave', { accounts: [name], guildId }); toast('تم إنهاء الجلسة', 'success'); addActivity('إنهاء جلسة', name); await refreshSessions(); }
  catch (error) { toast(error.message, 'error'); }
}

function stopCurrentStream({ updateDiscord = true } = {}) {
  const previousKind = state.mediaKind;
  if (state.mediaStream) state.mediaStream.getTracks().forEach((track) => track.stop());
  state.mediaStream = null; state.mediaKind = null; state.mediaStartedAt = 0;
  if (state.mediaTimer) { clearInterval(state.mediaTimer); state.mediaTimer = null; }
  const video = $('#cameraPreview');
  video.pause(); video.srcObject = null; video.classList.remove('is-visible');
  $('#stagePlaceholder').style.display = '';
  $('#stageOverlay').classList.remove('is-visible');
  $('#stopMediaButton').disabled = true;
  $('#cameraButton').classList.remove('is-active'); $('#screenButton').classList.remove('is-active');
  $('#cameraState').textContent = 'متوقف'; $('#screenState').textContent = 'متوقف';
  $('#mediaStatus').classList.remove('is-live'); $('#mediaStatus').innerHTML = '<span></span> متوقف';
  if (updateDiscord && previousKind && state.selectedTarget && state.selectedAccount) {
    post('/api/voice/state', { accounts: selectedAccounts(), guildId: state.selectedTarget.guildId, selfVideo: false, selfStream: false }).catch(() => {});
  }
}
function bindMediaEnded(stream) { stream.getVideoTracks().forEach((track) => track.addEventListener('ended', () => { if (state.mediaStream === stream) stopCurrentStream(); })); }
function showMediaStream(stream, kind) {
  stopCurrentStream({ updateDiscord: false });
  state.mediaStream = stream; state.mediaKind = kind; state.mediaStartedAt = Date.now();
  const video = $('#cameraPreview'); video.srcObject = stream; video.style.transform = kind === 'camera' ? 'scaleX(-1)' : 'none'; video.classList.add('is-visible'); $('#stagePlaceholder').style.display = 'none'; $('#stageOverlay').classList.add('is-visible'); $('#stageSource').textContent = kind === 'camera' ? 'كاميرا محلية' : 'مشاركة شاشة'; $('#stopMediaButton').disabled = false;
  $('#cameraButton').classList.toggle('is-active', kind === 'camera'); $('#screenButton').classList.toggle('is-active', kind === 'screen'); $('#cameraState').textContent = kind === 'camera' ? 'يعمل الآن' : 'متوقف'; $('#screenState').textContent = kind === 'screen' ? 'يعمل الآن' : 'متوقف'; $('#mediaStatus').classList.add('is-live'); $('#mediaStatus').innerHTML = '<span></span> مباشر';
  state.mediaTimer = setInterval(() => { $('#stageTimer').textContent = formatDuration(Math.floor((Date.now() - state.mediaStartedAt) / 1000)); }, 1000);
  bindMediaEnded(stream); video.play().catch(() => {});
  addActivity(kind === 'camera' ? 'الكاميرا تعمل' : 'مشاركة الشاشة تعمل', 'المعاينة المحلية جاهزة', 'success'); toast(kind === 'camera' ? 'تم تشغيل الكاميرا' : 'تم تشغيل مشاركة الشاشة', 'success');
}
async function toggleCamera() {
  if (state.mediaKind === 'camera') { stopCurrentStream(); return; }
  if (!navigator.mediaDevices?.getUserMedia) { toast('المتصفح لا يدعم الوصول إلى الكاميرا', 'error'); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
    showMediaStream(stream, 'camera');
    if (state.selectedTarget && state.selectedAccount) post('/api/voice/state', { accounts: selectedAccounts(), guildId: state.selectedTarget.guildId, selfVideo: true }).catch(() => {});
  } catch (error) { toast(error.name === 'NotAllowedError' ? 'تم رفض إذن الكاميرا' : `تعذر تشغيل الكاميرا: ${error.message}`, 'error'); addActivity('فشل تشغيل الكاميرا', error.message, 'error'); }
}
async function toggleScreen() {
  if (state.mediaKind === 'screen') { stopCurrentStream(); return; }
  if (!navigator.mediaDevices?.getDisplayMedia) { toast('المتصفح لا يدعم مشاركة الشاشة', 'error'); return; }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always', frameRate: { ideal: 30, max: 60 } }, audio: false });
    showMediaStream(stream, 'screen');
    $('#cameraPreview').style.transform = 'none';
    if (state.selectedTarget && state.selectedAccount) post('/api/voice/state', { accounts: selectedAccounts(), guildId: state.selectedTarget.guildId, selfStream: true }).catch(() => {});
  } catch (error) {
    if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') toast(`تعذرت مشاركة الشاشة: ${error.message}`, 'error');
  }
}

function initTheme() {
  const saved = localStorage.getItem('voice-theme');
  if (saved === 'light') document.body.classList.add('light-theme');
  $('#themeToggle').addEventListener('click', () => { document.body.classList.toggle('light-theme'); localStorage.setItem('voice-theme', document.body.classList.contains('light-theme') ? 'light' : 'dark'); });
}
function initLanguage() {
  $('#languageToggle').addEventListener('click', () => {
    const button = $('#languageToggle');
    const isArabic = document.documentElement.lang === 'ar';
    document.documentElement.lang = isArabic ? 'en' : 'ar';
    document.documentElement.dir = isArabic ? 'ltr' : 'rtl';
    button.textContent = isArabic ? 'AR' : 'EN';
    toast(isArabic ? 'English mode is ready' : 'تم تفعيل العربية', 'success');
  });
}
function initNavigation() { document.querySelectorAll('[data-scroll]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.scroll)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))); }
function init() {
  initTheme(); initLanguage(); initNavigation();
  $('#connectButton').addEventListener('click', connect); $('#disconnectButton').addEventListener('click', disconnect); $('#refreshButton').addEventListener('click', refreshChannels); $('#accountSelect').addEventListener('change', async (event) => { state.selectedAccount = event.target.value; await loadGuilds(); }); $('#channelSelect').addEventListener('change', handleChannelChange); $('#joinButton').addEventListener('click', join); $('#joinAllButton').addEventListener('click', joinAll); $('#leaveButton').addEventListener('click', leave); $('#cameraButton').addEventListener('click', toggleCamera); $('#screenButton').addEventListener('click', toggleScreen); $('#stopMediaButton').addEventListener('click', () => stopCurrentStream()); document.querySelectorAll('.state-button').forEach((button) => button.addEventListener('click', () => applyState(button.dataset.state)));
  window.addEventListener('beforeunload', () => stopCurrentStream({ updateDiscord: false }));
  loadClients().catch(() => {}); refreshSessions(); setInterval(refreshSessions, 8000);
}
init();
