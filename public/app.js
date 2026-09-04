const $ = (selector) => document.querySelector(selector);
const state = {
  clients: [],
  groups: [],
  allGroups: [],
  selectedAccount: '',
  selectedGuildId: '',
  selectedTarget: null,
  mediaStream: null,
  mediaKind: null,
  mediaStartedAt: 0,
  mediaTimer: null,
  rotationRoomFilter: '',
  rotationRoomPage: 0,
  rotationRoomSelection: new Set(),
  busy: new Set(),
  overviewFilter: '', overviewSort: 'account',
  lastOperation: null, authenticated: false, mediaBusy: false,
  refreshPromise: null, liveEvents: null, liveRefreshTimer: null,
};

let authPromptPromise = null;
function requestAuthentication(message = 'أدخل كلمة مرور المساحة للمتابعة. لا يمكن استخدام الموقع قبل المصادقة.') {
  if (state.authenticated) return Promise.resolve(true);
  if (authPromptPromise) return authPromptPromise;
  const modal = $('#authModal');
  const form = $('#authForm');
  const input = $('#authPasswordInput');
  const feedback = $('#authFeedback');
  const submit = $('#authSubmitButton');
  const cancel = $('#authCancelButton');
  if (!modal || !form || !input || !feedback || !submit || !cancel) return Promise.reject(new Error('Authentication UI unavailable'));

  authPromptPromise = new Promise((resolve) => {
    let submitting = false;
    const setFeedback = (text = '', tone = '') => { feedback.textContent = text; feedback.className = `auth-feedback ${tone}`; };
    const finish = () => {
      state.authenticated = true;
      modal.hidden = true;
      document.body.classList.remove('auth-locked');
      form.reset();
      setFeedback();
      cleanup();
      resolve(true);
      authPromptPromise = null;
    };
    const cleanup = () => {
      form.removeEventListener('submit', onSubmit);
      cancel.removeEventListener('click', onCancel);
    };
    const onCancel = () => {
      // Deliberately keep the modal open: cancelling must never leave the app usable.
      input.value = '';
      setFeedback('يلزم إدخال كلمة المرور لاستخدام الموقع.', 'error');
      input.focus();
    };
    const onSubmit = async (event) => {
      event.preventDefault();
      if (submitting) return;
      const password = input.value;
      if (!password) { setFeedback('أدخل كلمة المرور أولًا.', 'error'); input.focus(); return; }
      submitting = true;
      submit.disabled = true;
      cancel.disabled = true;
      setFeedback('جارٍ التحقق…');
      try {
        const auth = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Voice-Studio': '1' }, body: JSON.stringify({ password }), credentials: 'include', cache: 'no-store' });
        const payload = await auth.json().catch(() => ({}));
        if (!auth.ok || payload.success === false) throw new Error(auth.status === 429 ? 'محاولات كثيرة. حاول لاحقًا.' : 'كلمة المرور غير صحيحة.');
        const session = await fetch('/api/auth/status', { credentials: 'include', cache: 'no-store' });
        const sessionPayload = await session.json().catch(() => ({}));
        if (!session.ok || !sessionPayload.authenticated) throw new Error('تم قبول كلمة المرور لكن لم تُحفظ جلسة الدخول. تحقق من الكوكيز أو افتح الموقع من نفس الرابط.');
        finish();
      } catch (error) {
        setFeedback(error.message || 'تعذر التحقق من كلمة المرور.', 'error');
        input.select();
        submitting = false;
        submit.disabled = false;
        cancel.disabled = false;
        input.focus();
      }
    };
    form.addEventListener('submit', onSubmit);
    cancel.addEventListener('click', onCancel);
    $('#authMessage').textContent = message;
    modal.hidden = false;
    document.body.classList.add('auth-locked');
    requestAnimationFrame(() => input.focus());
  });
  return authPromptPromise;
}

const api = async (url, options = {}) => {
  const response = await fetch(url, { ...options, credentials: 'include', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-Voice-Studio': '1', ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && !options._authRetry) {
    await requestAuthentication();
    return api(url, { ...options, _authRetry: true });
  }
  if (!response.ok || payload.success === false) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
};
const operationNames = { connect: 'Connect account', 'connect-bulk': 'Connect accounts', join: 'Join voice room', 'join-all': 'Join accounts', leave: 'Leave voice room', state: 'Update voice state', 'rotation/start': 'Start channel rotation', 'rotation/stop': 'Stop channel rotation', 'state-cycle/start': 'Start state cycle', 'state-cycle/stop': 'Stop state cycle' };
function operationStart(url, body = {}) { const modal = $('#operationModal'); if (!modal) return; const key = Object.keys(operationNames).find((item) => url.includes(item)); $('#operationTitle').textContent = operationNames[key] || 'Processing'; $('#operationSubtitle').textContent = 'Preparing request…'; $('#operationResult').textContent = ''; $('#operationClose').hidden = true; $('.operation-loader')?.classList.remove('is-done', 'is-error'); const names = Array.isArray(body.accounts) ? body.accounts.map((item) => typeof item === 'string' ? item : item.name).filter(Boolean) : (body.name ? [body.name] : []); const profiles = names.map((name) => state.clients.find((client) => client.name === name) || { name, nickname: name }).filter(Boolean); modal.dataset.accountNames = JSON.stringify(names); $('#operationAccounts').innerHTML = profiles.length ? profiles.map((profile) => `<div class="operation-account" data-operation-name="${escapeHTML(profile.name)}"><span>${profile.avatar ? `<img src="${escapeHTML(profile.avatar)}" alt="" />` : escapeHTML((profile.nickname || profile.name || '?')[0])}</span><strong>${escapeHTML(profile.nickname || profile.displayName || profile.name)}</strong><small>Waiting…</small></div>`).join('') : '<div class="operation-empty">Working on the selected accounts…</div>'; modal.hidden = false; }
function operationFinish(payload) { const modal = $('#operationModal'); if (!modal) return; const results = Array.isArray(payload?.results) ? payload.results : []; const calculated = { total: results.length, ok: results.filter((item) => item?.ok === true).length, failed: results.filter((item) => item?.ok !== true).length }; const resultSummary = results.length ? calculated : (payload?.summary || { total: 0, ok: 0, failed: 0 }); const byName = new Map(results.filter((item) => item?.name).map((item) => [String(item.name), item])); $('#operationSubtitle').textContent = 'Completed'; $('#operationResult').textContent = `${resultSummary.ok} succeeded · ${resultSummary.failed} failed`; let rows = [...$('#operationAccounts').querySelectorAll('.operation-account')]; if (!rows.length && results.length) { $('#operationAccounts').innerHTML = results.map((result) => `<div class="operation-account" data-operation-name="${escapeHTML(result.name || '')}"><span>${result.avatar ? `<img src="${escapeHTML(result.avatar)}" alt="" />` : escapeHTML((result.nickname || result.name || '?')[0])}</span><strong>${escapeHTML(result.nickname || result.displayName || result.name || 'Account')}</strong><small></small></div>`).join(''); rows = [...$('#operationAccounts').querySelectorAll('.operation-account')]; } rows.forEach((row, index) => { const result = byName.get(row.dataset.operationName) || results[index]; if (result) { row.classList.remove('is-error','is-success'); row.classList.add(result.ok === true ? 'is-success' : 'is-error'); const avatar = row.querySelector(':scope > span'); if (avatar) avatar.innerHTML = result.avatar ? `<img src="${escapeHTML(result.avatar)}" alt="" />` : escapeHTML((result.nickname || result.name || '?')[0]); const name = row.querySelector('strong'); if (name) name.textContent = result.nickname || result.displayName || result.name || 'Account'; const detail = row.querySelector('small'); if (detail) detail.textContent = result.ok === true ? 'Success' : (result.error || 'Failed'); } }); $('.operation-loader')?.classList.add(resultSummary.failed ? 'is-error' : 'is-done'); $('#operationClose').hidden = false; }
function operationFail(error) { const modal = $('#operationModal'); if (!modal) return; $('#operationSubtitle').textContent = 'Failed'; $('#operationResult').textContent = error.message || 'Request failed'; $('.operation-loader')?.classList.add('is-error'); $('#operationClose').hidden = false; }
const post = async (url, body) => { operationStart(url, body); try { const result = await api(url, { method: 'POST', body: JSON.stringify(body) }); operationFinish(result); return result; } catch (error) { operationFail(error); throw error; } };

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function selectedAccounts() {
  const selectedBulk = [...document.querySelectorAll('#automationAccounts input[type="checkbox"]:checked')].map((input) => input.value);
  return selectedBulk.length > 1 ? selectedBulk : (state.selectedAccount ? [state.selectedAccount] : []);
}
function updateQuickStateButtons() {
  const selectedBulk = [...document.querySelectorAll('#automationAccounts input[type="checkbox"]:checked')];
  if (selectedBulk.length > 1) {
    document.querySelectorAll('.state-button').forEach((button) => button.classList.remove('is-active'));
    return;
  }
  const voice = state.clients.find((client) => client.name === state.selectedAccount)?.voice;
  const active = {
    mute: !!voice?.selfMute,
    deaf: !!voice?.selfDeaf,
    unmute: !!voice && !voice.selfMute && !voice.selfDeaf && !voice.selfVideo && !voice.selfStream,
    cam: !!voice?.selfVideo,
    stream: !!voice?.selfStream,
  };
  document.querySelectorAll('.state-button').forEach((button) => button.classList.toggle('is-active', !!active[button.dataset.state]));
}
function selectedSession() {
  return state.selectedTarget && state.selectedAccount ? { account: state.selectedAccount, ...state.selectedTarget } : null;
}
function addActivity(title, detail, tone = '', account = '') {
  const list = $('#activityList');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'activity-row';
  row.innerHTML = `<span class="activity-dot ${tone}"></span><div><strong>${escapeHTML(title)}</strong><small>${escapeHTML(detail)}</small></div><time>الآن</time>`;
  list.prepend(row);
  while (list.children.length > 12) list.lastElementChild.remove();
  const stored = JSON.parse(localStorage.getItem('voice-activity') || '[]'); stored.unshift({ title, detail, tone, account, time: new Date().toISOString() }); localStorage.setItem('voice-activity', JSON.stringify(stored.slice(0, 500)));
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
  $('#accountBadge').textContent = state.clients.length ? `${state.clients.length} connected` : 'No accounts'; $('#navAccountCount').textContent = String(state.clients.length);
  $('#connectionLabel').textContent = state.clients.length ? `${state.clients.length} حساب متصل` : 'جاهز للاتصال';
  renderProfiles(state.clients);
  await loadGuilds();
  await loadAutomationCatalog();
}
async function loadAutomationCatalog() {
  const guildSelect = $('#automationGuild');
  if (!guildSelect) return;
  try {
    const data = await api('/api/voice/guilds');
    state.allGroups = data.guilds || [];
    const guilds = [...new Map(state.allGroups.map((group) => [group.guildId, group])).values()];
    guildSelect.innerHTML = guilds.length ? `<option value="">اختر السيرفر</option>${guilds.map((group) => `<option value="${escapeHTML(group.guildId)}">${escapeHTML(group.guildName)}</option>`).join('')}` : '<option value="">لا توجد سيرفرات متاحة</option>';
    renderAutomationChannels();
  } catch (error) { console.warn('[voice] automation catalog failed', error); }
}
function selectedAutomationAccounts() { return [...document.querySelectorAll('#automationAccounts input[type="checkbox"]:checked')].map((input) => input.value); }
function selectedRotationChannels() { return [...state.rotationRoomSelection]; }
function selectedAutomationStates() { return [...document.querySelectorAll('#statePicker input[type="checkbox"]:checked')].map((input) => input.value); }
function selectedAutomationChannel() { return $('#automationChannel')?.value || ''; }
function renderAutomationChannels() {
  const guildId = $('#automationGuild')?.value;
  const channelSelect = $('#automationChannel');
  const groups = state.allGroups.filter((group) => group.guildId === guildId);
  const channels = [...new Map(groups.flatMap((group) => group.voiceChannels || []).map((channel) => [channel.id, channel])).values()];
  state.rotationRoomPage = 0;
  state.rotationRoomSelection.clear();
  if (!guildId) { channelSelect.innerHTML = '<option value="">اختر السيرفر أولًا</option>'; renderRotationRooms([]); renderTargetAccounts(); return; }
  channelSelect.innerHTML = channels.length ? `<option value="">اختر الروم</option>${channels.map((channel) => `<option value="${escapeHTML(channel.id)}">${escapeHTML(channel.name)} · ${channel.members || 0} متصل</option>`).join('')}` : '<option value="">لا توجد رومات متاحة</option>';
  renderRotationRooms(channels);
  renderTargetAccounts();
}
function rotationRooms() {
  const guildId = $('#automationGuild')?.value;
  return [...new Map(state.allGroups.filter((group) => group.guildId === guildId).flatMap((group) => group.voiceChannels || []).map((channel) => [channel.id, channel])).values()];
}
function renderRotationRooms(channels = rotationRooms()) {
  const wrapper = $('#rotationChannels');
  const filter = state.rotationRoomFilter.trim().toLocaleLowerCase();
  const filtered = channels.filter((channel) => channel.name.toLocaleLowerCase().includes(filter));
  const pageSize = 60;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  state.rotationRoomPage = Math.min(state.rotationRoomPage, pages - 1);
  const visible = filtered.slice(state.rotationRoomPage * pageSize, (state.rotationRoomPage + 1) * pageSize);
  wrapper.innerHTML = visible.length ? visible.map((channel) => `<label class="channel-check"><input type="checkbox" value="${escapeHTML(channel.id)}" ${state.rotationRoomSelection.has(channel.id) ? 'checked' : ''} /><span><strong>${escapeHTML(channel.name)}</strong><small>${channel.members || 0} متصل · ${channel.bitrate || 64} kbps</small></span></label>`).join('') : '<div class="task-empty">لا توجد رومات مطابقة</div>';
  wrapper.querySelectorAll('input[type="checkbox"]').forEach((input) => input.addEventListener('change', () => { if (input.checked) state.rotationRoomSelection.add(input.value); else state.rotationRoomSelection.delete(input.value); updateRotationPager(filtered.length, pages); }));
  updateRotationPager(filtered.length, pages);
}
function updateRotationPager(filteredCount, pages) {
  $('#rotationRoomCount').textContent = `${state.rotationRoomSelection.size} selected · ${filteredCount} rooms`;
  $('#rotationPageLabel').textContent = `Page ${state.rotationRoomPage + 1} / ${pages}`;
  $('#rotationPrevButton').disabled = state.rotationRoomPage === 0;
  $('#rotationNextButton').disabled = state.rotationRoomPage >= pages - 1;
}
async function renderTargetAccounts() {
  const wrapper = $('#automationAccounts');
  const guildId = $('#automationGuild')?.value;
  const channelId = selectedAutomationChannel();
  if (!guildId || !channelId) { wrapper.innerHTML = '<div class="task-empty">اختر سيرفرًا ورومًا لعرض الحسابات</div>'; return; }
  try {
    const data = await api(`/api/voice/target-accounts?guildId=${encodeURIComponent(guildId)}&channelId=${encodeURIComponent(channelId)}`);
    wrapper.innerHTML = data.accounts.length ? data.accounts.map((account) => `<label class="account-target ${account.available ? '' : 'is-disabled'}"><input type="checkbox" value="${escapeHTML(account.name)}" ${account.available ? '' : 'disabled'} /><span class="target-avatar">${account.avatar ? `<img src="${escapeHTML(account.avatar)}" alt="" />` : escapeHTML((account.nickname || '?')[0])}</span><span class="target-copy"><strong>${escapeHTML(account.nickname)}</strong><small>ID: ${escapeHTML(account.id || '—')} · ${account.available ? (account.current ? `حاليًا في ${escapeHTML(account.current.channelName)} · ${account.current.selfMute ? 'Mute' : 'Unmute'}${account.current.selfDeaf ? ' · Deafen' : ''}${account.current.selfVideo ? ' · Video' : ''}${account.current.selfStream ? ' · Stream' : ''}` : 'جاهز للدخول') : escapeHTML(account.reason)}</small></span><span class="target-status">${account.available ? 'متاح' : 'مستبعد'}</span></label>`).join('') : '<div class="task-empty">لا توجد حسابات متصلة</div>';
  } catch (error) { wrapper.innerHTML = `<div class="task-empty">تعذر تحميل الحسابات: ${escapeHTML(error.message)}</div>`; }
}
async function loadGuilds() {
  state.groups = [];
  state.selectedGuildId = '';
  state.selectedTarget = null;
  $('#serverSelect') && ($('#serverSelect').innerHTML = '<option value="">اختر السيرفر</option>');
  renderChannels();
  if (!state.selectedAccount) return;
  try {
    const data = await api(`/api/voice/guilds?account=${encodeURIComponent(state.selectedAccount)}`);
    state.groups = data.guilds || [];
    const voice = state.clients.find((client) => client.name === state.selectedAccount)?.voice;
    state.selectedGuildId = voice?.guildId && state.groups.some((group) => group.guildId === voice.guildId) ? voice.guildId : (state.groups[0]?.guildId || '');
    renderServers();
    renderChannels();
    if (voice) {
      const value = `${voice.guildId}::${voice.channelId}`;
      if ([...$('#channelSelect').options].some((option) => option.value === value)) {
        $('#channelSelect').value = value;
        handleChannelChange();
      }
    }
  } catch (error) {
    feedback('#connectFeedback', error.message, 'error');
  }
}
function renderServers() {
  const select = $('#serverSelect'); if (!select) return;
  select.innerHTML = `<option value="">اختر السيرفر</option>${state.groups.map((group) => `<option value="${escapeHTML(group.guildId)}">${escapeHTML(group.guildName)}</option>`).join('')}`;
  select.value = state.selectedGuildId;
}
function renderChannels() {
  const select = $('#channelSelect');
  const group = state.groups.find((item) => item.guildId === state.selectedGuildId);
  const query = ($('#roomSearch')?.value || '').trim().toLowerCase();
  if (!group) {
    select.innerHTML = '<option value="">لا توجد قنوات صوتية متاحة</option>';
    updateChannelSummary();
    return;
  }
  const channels = group.voiceChannels.filter((channel) => !query || channel.name.toLowerCase().includes(query));
  select.innerHTML = `<option value="">اختر قناة صوتية</option>${channels.map((channel) => `<option value="${escapeHTML(group.guildId)}::${escapeHTML(channel.id)}">${escapeHTML(channel.name)}${channel.members ? ` · ${channel.members} متصل` : ''}</option>`).join('')}`;
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
function currentVoiceTarget() {
  const voice = state.clients.find((client) => client.name === state.selectedAccount)?.voice;
  return state.selectedTarget || (voice?.guildId && voice?.channelId
    ? { guildId: voice.guildId, channelId: voice.channelId, channelName: voice.channelName || voice.channelId }
    : null);
}

async function connect() {
  if (state.busy.has('connect')) return;
  const token = $('#tokenInput').value.trim();
  const name = '';
  if (!token) { feedback('#connectFeedback', 'أدخل Discord Token للمتابعة.', 'error'); return; }
  setBusy('connect', true); feedback('#connectFeedback', 'جارٍ فتح اتصال Gateway والتحقق منه…');
  try {
    const data = await post('/api/discord/connect', { token, name });
    $('#tokenInput').value = '';
    feedback('#connectFeedback', `تم الاتصال باسم ${data.username || data.name}.`, 'success');
    addActivity('تم الاتصال', data.username || data.name, 'success');
    toast('تم الاتصال بالحساب بنجاح', 'success');
    try { await loadClients(data.name); await refreshSessions(); }
    catch (refreshError) { console.warn('[voice] connected, but post-connect refresh failed', refreshError); addActivity('تم الاتصال', 'نجح الاتصال، حدّث القنوات يدويًا إذا لم تظهر بعد', 'success'); }
  } catch (error) {
    feedback('#connectFeedback', error.message, 'error');
    addActivity('تعذر الاتصال', error.message, 'error');
    toast(error.message, 'error');
  } finally { setBusy('connect', false); }
}
async function bulkConnect() {
  const lines = $('#bulkTokensInput').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const accounts = lines.map((token) => ({ token }));
  if (!accounts.length) { feedback('#bulkFeedback', 'أضف توكنًا واحدًا على الأقل، كل توكن في سطر.', 'error'); return; }
  $('#bulkConnectButton').disabled = true; feedback('#bulkFeedback', `جارٍ اتصال ${accounts.length} حساب بحد تزامن آمن…`);
  try {
    const result = await post('/api/discord/connect-bulk', { accounts });
    const failed = result.results.filter((item) => !item.ok);
    feedback('#bulkFeedback', `اكتمل الاتصال: ${result.summary.ok} نجح، ${result.summary.failed} فشل.`, failed.length ? 'error' : 'success');
    addActivity('استيراد جماعي', `${result.summary.ok} حساب متصل`, failed.length ? 'error' : 'success');
    toast(`تم اتصال ${result.summary.ok} حساب`, failed.length ? 'error' : 'success');
    $('#bulkTokensInput').value = '';
    try { await loadClients(); await refreshSessions(); }
    catch (refreshError) { console.warn('[voice] bulk connection completed, but refresh failed', refreshError); }
  } catch (error) { feedback('#bulkFeedback', error.message, 'error'); toast(error.message, 'error'); }
  finally { $('#bulkConnectButton').disabled = false; }
}

function renderProfiles(clients = []) {
  const list = $('#profilesList');
  if (!list) return;
  if (!clients.length) { list.innerHTML = '<div class="task-empty">لا توجد حسابات متصلة</div>'; return; }
  list.innerHTML = clients.map((client) => {
    const voice = client.voice;
    const avatar = client.avatar ? `<img src="${escapeHTML(client.avatar)}" alt="" />` : escapeHTML((client.nickname || client.name || '?')[0].toUpperCase());
    const voiceText = voice ? `${escapeHTML(voice.guildName || voice.guildId)} · ${escapeHTML(voice.channelName || voice.channelId)}` : 'Not in a room';
    const flags = voice ? `${voice.selfMute ? 'Mute' : 'Unmute'}${voice.selfDeaf ? ' · Deafen' : ''}${voice.selfVideo ? ' · Video' : ''}${voice.selfStream ? ' · Stream' : ''}` : 'Offline'; const health = client.health || {}; const healthText = health.state === 'healthy' ? 'Healthy' : health.state === 'degraded' ? `Degraded${health.lastError ? ` · ${health.lastError}` : ''}` : 'Unknown';
    return `<div class="profile-row"><span class="profile-row-avatar">${avatar}</span><div class="profile-row-main"><strong>${escapeHTML(client.nickname || client.displayName || client.name)}</strong><small>@${escapeHTML(client.username || client.name)} · ID: ${escapeHTML(client.id || '—')} · <span class="health-${escapeHTML(health.state || 'unknown')}">${escapeHTML(healthText)}</span></small></div><div class="profile-row-voice"><span class="profile-online"></span><strong>${voiceText}</strong><small>${flags}</small></div><button class="profile-leave" type="button" data-profile-leave="${escapeHTML(client.name)}" data-profile-guild="${escapeHTML(voice?.guildId || '')}" ${voice ? '' : 'disabled'}>Leave</button></div>`;
  }).join('');
  list.querySelectorAll('[data-profile-leave]').forEach((button) => button.addEventListener('click', () => quickLeave(button.dataset.profileLeave, button.dataset.profileGuild)));
  updateQuickStateButtons();
}

function openDisconnect() {
  const list = $('#disconnectAccountList');
  if (!state.clients.length) { toast('لا توجد حسابات متصلة لفصلها', 'error'); return; }
  list.innerHTML = state.clients.map((client) => `<label class="account-target disconnect-target"><input type="checkbox" value="${escapeHTML(client.name)}" checked /><span class="target-avatar">${client.avatar ? `<img src="${escapeHTML(client.avatar)}" alt="" />` : escapeHTML((client.nickname || client.name || '?')[0])}</span><span class="target-copy"><strong>${escapeHTML(client.nickname || client.displayName || client.name)}</strong><small>@${escapeHTML(client.username || client.name)} · ID: ${escapeHTML(client.id || '—')}</small></span><span class="target-status">Connected</span></label>`).join('');
  $('#disconnectModal').hidden = false;
}
async function disconnectSelected() {
  const accounts = [...document.querySelectorAll('#disconnectAccountList input:checked')].map((input) => input.value);
  if (!accounts.length) { toast('اختر حسابًا واحدًا على الأقل', 'error'); return; }
  $('#disconnectModal').hidden = true;
  try {
    const result = await post('/api/discord/disconnect-bulk', { accounts });
    const failed = result.results?.filter((item) => item.ok !== true) || [];
    addActivity('Disconnect accounts', `${result.summary?.ok || 0} disconnected`, failed.length ? 'error' : 'success');
    toast(`${result.summary?.ok || 0} accounts disconnected`, failed.length ? 'error' : 'success');
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
    addActivity('تنقل إلى غرفة', `${state.clients.find((client) => client.name === state.selectedAccount)?.nickname || state.selectedAccount} · ${state.selectedTarget.guildName} · ${state.selectedTarget.channelName}`, 'success', state.selectedAccount);
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
  const voice = state.clients.find((client) => client.name === state.selectedAccount)?.voice;
  const guildId = state.selectedTarget?.guildId || voice?.guildId;
  if (!requireAccount() || !guildId || state.busy.has('leave')) { if (requireAccount() && !guildId) toast('اختر حسابًا داخل روم صوتي قبل الخروج', 'error'); return; }
  setBusy('leave', true);
  try {
    const result = await post('/api/voice/leave', { accounts: selectedAccounts(), guildId });
    if (!result.summary?.ok) throw new Error(result.results?.find((item) => !item.ok)?.error || 'تعذر الخروج');
    toast('تم الخروج من الغرفة', 'success'); addActivity('خرج من الغرفة', `${state.clients.find((client) => client.name === state.selectedAccount)?.nickname || state.selectedAccount} · ${state.selectedTarget.channelName}`, 'success', state.selectedAccount); await refreshSessions();
  } catch (error) { toast(error.message, 'error'); }
  finally { setBusy('leave', false); }
}
async function applyState(kind) {
  if (!requireAccount()) return;
  const accounts = selectedAccounts();
  const values = {
    mute: { selfMute: true, selfDeaf: false, selfVideo: false, selfStream: false, label: 'Mute enabled' },
    deaf: { selfMute: true, selfDeaf: true, selfVideo: false, selfStream: false, label: 'Deafen enabled' },
    unmute: { selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false, label: 'Unmute enabled' },
    cam: { selfMute: false, selfDeaf: false, selfVideo: true, selfStream: false, label: 'Video enabled' },
    stream: { selfMute: false, selfDeaf: false, selfVideo: false, selfStream: true, label: 'Stream enabled' },
  };
  if (!values[kind]) return;
  const next = { ...values[kind] };
  const currentVoice = state.clients.find((client) => client.name === state.selectedAccount)?.voice;
  if (accounts.length === 1 && kind === 'mute' && currentVoice?.selfMute) { next.selfMute = false; next.selfDeaf = false; next.label = 'Mute disabled'; }
  if (accounts.length === 1 && kind === 'deaf' && currentVoice?.selfDeaf) { next.selfMute = false; next.selfDeaf = false; next.label = 'Deafen disabled'; }
  if (accounts.length === 1 && kind === 'unmute' && !currentVoice?.selfMute && !currentVoice?.selfDeaf) { next.selfMute = true; next.selfDeaf = false; next.label = 'Mute enabled'; }
  if (kind === 'cam' && accounts.length === 1) {
    await toggleCamera();
    return;
  }
  if (kind === 'stream' && accounts.length === 1) {
    await toggleScreen();
    return;
  }
  const target = currentVoiceTarget();
  if (!target) { toast('ادخل غرفة أولًا لتغيير الحالة', 'error'); return; }
  state.selectedTarget = target;
  const buttons = [...document.querySelectorAll('.state-button')]; buttons.forEach((button) => { button.disabled = true; button.classList.add('is-pending'); });
  try {
    const result = await post('/api/voice/state', { accounts, guildId: target.guildId, ...next });
    if (!result.summary?.ok) throw new Error(result.results?.find((item) => !item.ok)?.error || 'تعذر تحديث الحالة');
    updateQuickStateButtons();
    const failed = result.summary.failed || 0;
    const message = failed ? `${next.label}: ${result.summary.ok} succeeded, ${failed} failed` : next.label;
    feedback('#stateFeedback', message, failed ? 'error' : 'success'); addActivity('تحديث حالة صوتية', `${state.clients.find((client) => client.name === state.selectedAccount)?.nickname || state.selectedAccount} · ${message}`, failed ? 'error' : 'success', state.selectedAccount); toast(message, failed ? 'error' : 'success'); await refreshSessions();
  } catch (error) { feedback('#stateFeedback', error.message, 'error'); toast(error.message, 'error'); } finally { buttons.forEach((button) => { button.disabled = false; button.classList.remove('is-pending'); }); updateQuickStateButtons(); }
}

function formatDuration(seconds) { return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }
function renderSessions(sessions = []) {
  const query = state.overviewFilter.trim().toLocaleLowerCase();
  const visibleSessions = sessions.filter((session) => !query || [session.name, session.guildName, session.channelName].some((value) => String(value || '').toLocaleLowerCase().includes(query))).sort((a,b) => { if (state.overviewSort === 'server') return String(a.guildName || '').localeCompare(String(b.guildName || '')); if (state.overviewSort === 'members') return Number(b.memberCount || 0) - Number(a.memberCount || 0); return String(a.name || '').localeCompare(String(b.name || '')); });
  $('#navSessionCount').textContent = String(sessions.length);
  const list = $('#sessionsList');
  const healthy = state.clients.filter((client) => client.health?.state === 'healthy').length; const degraded = state.clients.filter((client) => client.health?.state === 'degraded').length; const unknown = state.clients.length - healthy - degraded; $('#healthSummary').innerHTML = `<span class="health-pill healthy">${healthy} healthy</span><span class="health-pill degraded">${degraded} degraded</span><span class="health-pill">${unknown} unknown</span><span class="health-pill">${state.clients.length} total</span>`;
  if (!visibleSessions.length) {
    list.innerHTML = '<div class="empty-state"><span class="empty-pulse"></span><p>لا توجد جلسات نشطة الآن</p><small>عند الدخول إلى غرفة ستظهر تفاصيلها هنا.</small></div>';
    return;
  }
  list.innerHTML = visibleSessions.map((session) => `<div class="session-row"><span class="session-avatar">${session.guildIcon ? `<img src="${escapeHTML(session.guildIcon)}" alt="" />` : escapeHTML((session.guildName || '?')[0].toUpperCase())}</span><div class="session-info"><strong>${escapeHTML(session.name)}</strong><small>${escapeHTML(session.guildName || session.guildId)} · ${escapeHTML(session.channelName || session.channelId)} · ${Number(session.memberCount || 0)} متصل</small></div><div class="session-state">${session.selfMute ? 'Mute' : 'Unmute'}${session.selfDeaf ? ' · Deafen' : ''}${session.selfVideo ? ' · Video' : ''}${session.selfStream ? ' · Stream' : ''}</div><button class="session-leave" type="button" data-leave-name="${escapeHTML(session.name)}" data-leave-guild="${escapeHTML(session.guildId)}" title="خروج">×</button></div>`).join('');
  list.querySelectorAll('[data-leave-name]').forEach((button) => button.addEventListener('click', () => quickLeave(button.dataset.leaveName, button.dataset.leaveGuild)));
}
async function refreshSessions() {
  if (state.refreshPromise) return state.refreshPromise;
  state.refreshPromise = (async () => {
    try {
      const clients = await api('/api/discord/clients');
      state.clients = clients.clients || state.clients;
      renderProfiles(state.clients);
      const data = await api('/api/voice/sessions');
      renderSessions(data.sessions || []);
      await loadTasks();
    } catch (error) { console.warn('[voice] sessions refresh failed', error); }
    finally { state.refreshPromise = null; }
  })();
  return state.refreshPromise;
}
async function loadTasks() {
  try {
    const [rotations, cycles] = await Promise.all([api('/api/voice/rotations'), api('/api/voice/state-cycles')]);
    renderTasks([...(rotations.rotations || []).map((task) => ({ ...task, type: 'rotation', title: 'تنقل بين القنوات' })), ...(cycles.cycles || []).map((task) => ({ ...task, type: 'cycle', title: 'تدوير الحالات' }))]);
  } catch (error) { console.warn('[voice] tasks refresh failed', error); }
}
function renderTasks(tasks) {
  const list = $('#tasksList');
  if (!list) return;
  if (!tasks.length) { list.innerHTML = '<div class="task-empty">لا توجد مهام قيد التشغيل</div>'; return; }
  list.innerHTML = tasks.map((task) => `<div class="task-row"><div><strong>${escapeHTML(task.title)}</strong><small>${task.accounts?.length || 0} حساب · كل ${Math.round((task.intervalMs || 0) / 60000)} دقيقة</small></div><button type="button" class="task-stop" data-task-type="${task.type}" data-task-id="${escapeHTML(task.id)}">إيقاف</button></div>`).join('');
  list.querySelectorAll('.task-stop').forEach((button) => button.addEventListener('click', () => stopTask(button.dataset.taskType, button.dataset.taskId)));
}
async function bulkJoinSelected() {
  const accounts = selectedAutomationAccounts();
  const guildId = $('#automationGuild').value;
  const channelId = selectedAutomationChannel();
  if (!accounts.length) { toast('حدد حسابًا واحدًا على الأقل', 'error'); return; }
  if (!guildId || !channelId) { toast('اختر السيرفر والروم أولًا', 'error'); return; }
  try {
    const result = await post('/api/voice/join', { accounts, guildId, channelId });
    const failed = result.results.filter((item) => !item.ok);
    toast(`${result.summary.ok} نجح · ${result.summary.failed} فشل`, failed.length ? 'error' : 'success');
    addActivity('دخول جماعي', `${result.summary.ok} حساب إلى الروم`, failed.length ? 'error' : 'success');
    await refreshSessions(); await renderTargetAccounts();
  } catch (error) { toast(error.message, 'error'); }
}
async function applyBulkState() { const accounts = selectedAutomationAccounts(); const guildId = $('#automationGuild')?.value || ''; const kind = $('#bulkStateTemplate')?.value || 'unmute'; const stateMap = { unmute: { selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false }, mute: { selfMute: true, selfDeaf: false, selfVideo: false, selfStream: false }, deaf: { selfMute: true, selfDeaf: true, selfVideo: false, selfStream: false }, cam: { selfMute: false, selfDeaf: false, selfVideo: true, selfStream: false }, stream: { selfMute: false, selfDeaf: false, selfVideo: false, selfStream: true } }; if (!accounts.length || !guildId) { toast('اختر الحسابات والسيرفر أولًا من Automation', 'error'); return; } try { const result = await post('/api/voice/state', { accounts, guildId, ...stateMap[kind] }); const failed = result.summary?.failed || 0; toast(`${result.summary?.ok || 0} succeeded · ${failed} failed`, failed ? 'error' : 'success'); await refreshSessions(); } catch (error) { toast(error.message, 'error'); } }
async function startRotation() {
  if (!state.clients.length) { toast('اتصل بحساب واحد على الأقل أولًا', 'error'); return; }
  const accounts = selectedAutomationAccounts();
  const guildId = $('#automationGuild').value;
  const channelIds = selectedRotationChannels();
  if (accounts.length < 1) { toast('اختر حسابًا واحدًا على الأقل للمهمة', 'error'); return; }
  if (!guildId) { toast('اختر السيرفر الذي ستعمل عليه المهمة', 'error'); return; }
  if (channelIds.length < 2) { toast('حدد رومتين على الأقل للتنقل بينهما', 'error'); return; }
  const guild = state.allGroups.find((group) => group.guildId === guildId);
  const intervalMs = Math.max(1, Number($('#automationMinutes').value || 5)) * 60000;
  try { await post('/api/voice/rotation/start', { accounts, guildId, guildName: guild?.guildName || guildId, channelIds, intervalMs, randomOrder: $('#randomRotation').checked }); toast('بدأ التنقل الدوري بين القنوات', 'success'); addActivity('مهمة جديدة', 'التنقل بين القنوات', 'success'); await loadTasks(); }
  catch (error) { toast(error.message, 'error'); }
}
async function startCycle() {
  if (!state.clients.length) { toast('اتصل بحساب واحد على الأقل أولًا', 'error'); return; }
  const accounts = selectedAutomationAccounts();
  const guildId = $('#automationGuild').value;
  if (!accounts.length) { toast('اختر الحسابات المستهدفة للمهمة', 'error'); return; }
  if (!guildId) { toast('اختر السيرفر الذي سيطبق الحالات', 'error'); return; }
  const selected = selectedAutomationStates();
  if (selected.length < 2) { toast('اختر حالتين على الأقل', 'error'); return; }
  const stateMap = { unmute: { selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false }, mute: { selfMute: true, selfDeaf: false, selfVideo: false, selfStream: false }, deaf: { selfMute: true, selfDeaf: true, selfVideo: false, selfStream: false }, cam: { selfMute: false, selfDeaf: false, selfVideo: true, selfStream: false }, stream: { selfMute: false, selfDeaf: false, selfVideo: false, selfStream: true } };
  const intervalMs = Math.max(1, Number($('#automationMinutes').value || 5)) * 60000;
  try { await post('/api/voice/state-cycle/start', { accounts, guildId, states: selected.map((key) => stateMap[key]), intervalMs }); toast('بدأ تدوير الحالات الصوتية', 'success'); addActivity('مهمة جديدة', 'تدوير الحالات الصوتية', 'success'); await loadTasks(); }
  catch (error) { toast(error.message, 'error'); }
}
async function stopTask(type, id) {
  const endpoint = type === 'rotation' ? '/api/voice/rotation/stop' : '/api/voice/state-cycle/stop';
  try { await post(endpoint, { id }); toast('تم إيقاف المهمة', 'success'); addActivity('إيقاف مهمة', id); await loadTasks(); }
  catch (error) { toast(error.message, 'error'); }
}
async function quickLeave(name, guildId) {
  try { await post('/api/voice/leave', { accounts: [name], guildId }); toast('تم إنهاء الجلسة', 'success'); addActivity('إنهاء جلسة', `${state.clients.find((client) => client.name === name)?.nickname || name} · ${guildId}`, 'success', name); await refreshSessions(); }
  catch (error) { toast(error.message, 'error'); }
}

async function syncMediaVoiceState(next, kind) {
  const current = state.clients.find((client) => client.name === state.selectedAccount)?.voice;
  const target = currentVoiceTarget();
  if (!target || !state.selectedAccount) {
    if ($('#mediaNotice')) $('#mediaNotice').textContent = 'Join a voice room first to request a Discord voice-state update.';
    return { synced: false };
  }
  state.selectedTarget = target;
  try {
    const result = await post('/api/voice/state', { accounts: selectedAccounts(), guildId: target.guildId, ...next });
    if (!result.summary?.ok) throw new Error(result.results?.find((item) => !item.ok)?.error || 'Discord did not apply the media state');
    if ($('#mediaNotice')) $('#mediaNotice').textContent = `${kind} state confirmed by Discord.`;
    return { synced: true };
  } catch (error) {
    if ($('#mediaNotice')) $('#mediaNotice').textContent = `Discord was not updated: ${error.message}`;
    toast(`تعذر تحديث حالة Discord: ${error.message}`, 'error');
    return { synced: false, error };
  }
}
function stopCurrentStream({ updateDiscord = true } = {}) {
  const previousKind = state.mediaKind;
  if (state.mediaStream) state.mediaStream.getTracks().forEach((track) => track.stop());
  state.mediaStream = null; state.mediaKind = null; state.mediaStartedAt = 0;
  if (state.mediaTimer) { clearInterval(state.mediaTimer); state.mediaTimer = null; }
  const video = $('#cameraPreview');
  if (video) { video.pause(); video.srcObject = null; video.classList.remove('is-visible'); }
  if ($('#stagePlaceholder')) $('#stagePlaceholder').style.display = '';
  if ($('#stageOverlay')) $('#stageOverlay').classList.remove('is-visible');
  if ($('#stopMediaButton')) $('#stopMediaButton').disabled = true;
  $('#cameraButton')?.classList.remove('is-active'); $('#screenButton')?.classList.remove('is-active');
  if ($('#cameraState')) $('#cameraState').textContent = 'Off'; if ($('#screenState')) $('#screenState').textContent = 'Off';
  if ($('#mediaStatus')) { $('#mediaStatus').classList.remove('is-live'); $('#mediaStatus').innerHTML = '<span></span> Offline'; }
  if ($('#mediaNotice')) $('#mediaNotice').textContent = 'Media preview is disabled.';
  if (updateDiscord && previousKind && currentVoiceTarget() && state.selectedAccount) {
    syncMediaVoiceState({ selfVideo: false, selfStream: false }, 'Media').catch(() => {});
  }
}
function bindMediaEnded(stream) { stream.getVideoTracks().forEach((track) => track.addEventListener('ended', () => { if (state.mediaStream === stream) stopCurrentStream(); })); }
function showMediaStream(stream, kind) {
  stopCurrentStream({ updateDiscord: false });
  state.mediaStream = stream; state.mediaKind = kind; state.mediaStartedAt = Date.now();
  const video = $('#cameraPreview'); if (video) { video.srcObject = stream; video.style.transform = kind === 'camera' ? 'scaleX(-1)' : 'none'; video.classList.add('is-visible'); video.play().catch(() => {}); }
  if ($('#stagePlaceholder')) $('#stagePlaceholder').style.display = 'none'; $('#stageOverlay')?.classList.add('is-visible'); if ($('#stageSource')) $('#stageSource').textContent = kind === 'camera' ? 'Camera' : 'Screen share'; if ($('#stopMediaButton')) $('#stopMediaButton').disabled = false;
  $('#cameraButton')?.classList.toggle('is-active', kind === 'camera'); $('#screenButton')?.classList.toggle('is-active', kind === 'screen'); if ($('#cameraState')) $('#cameraState').textContent = kind === 'camera' ? 'Live' : 'Off'; if ($('#screenState')) $('#screenState').textContent = kind === 'screen' ? 'Live' : 'Off'; $('#mediaStatus')?.classList.add('is-live'); if ($('#mediaStatus')) $('#mediaStatus').innerHTML = '<span></span> Live';
  state.mediaTimer = setInterval(() => { if ($('#stageTimer')) $('#stageTimer').textContent = formatDuration(Math.floor((Date.now() - state.mediaStartedAt) / 1000)); }, 1000);
  bindMediaEnded(stream);
  addActivity(kind === 'camera' ? 'الكاميرا تعمل' : 'مشاركة الشاشة تعمل', 'المعاينة المحلية جاهزة', 'success'); toast(kind === 'camera' ? 'تم تشغيل الكاميرا' : 'تم تشغيل مشاركة الشاشة', 'success');
}
async function toggleCamera() {
  if (state.mediaBusy) return;
  const current = state.clients.find((client) => client.name === state.selectedAccount)?.voice;
  if (current?.selfVideo) {
    stopCurrentStream({ updateDiscord: false });
    await syncMediaVoiceState({ selfVideo: false, selfStream: false }, 'Camera');
    await refreshSessions();
    return;
  }
  if (state.mediaKind === 'camera') { stopCurrentStream(); return; }
  state.mediaBusy = true;
  try {
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#080b18'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const stream = canvas.captureStream(15);
    const synced = await syncMediaVoiceState({ selfVideo: true, selfStream: false }, 'Camera');
    if (!synced.synced) throw synced.error || new Error('Discord did not confirm camera state');
    showMediaStream(stream, 'camera');
    if ($('#mediaNotice')) $('#mediaNotice').textContent = 'Safe camera preview: a blank frame is used; no camera permission is requested.';
  } catch (error) { toast(`تعذر تشغيل المعاينة: ${error.message}`, 'error'); addActivity('فشل تشغيل الكاميرا', error.message, 'error'); } finally { state.mediaBusy = false; updateQuickStateButtons(); }
}
async function toggleScreen() {
  if (state.mediaBusy) return;
  if (!state.selectedAccount) { toast('ادخل الحساب إلى غرفة صوتية أولًا', 'error'); return; }
  const current = state.clients.find((client) => client.name === state.selectedAccount)?.voice;
  const target = currentVoiceTarget();
  if (!target) { toast('ادخل الحساب إلى غرفة صوتية أولًا', 'error'); return; }
  state.selectedTarget = target;
  const enabled = !current?.selfStream;
  state.mediaBusy = true;
  try {
    const result = await post('/api/voice/state', { accounts: selectedAccounts(), guildId: target.guildId, selfVideo: false, selfStream: enabled });
    if (!result.summary?.ok) throw new Error(result.results?.find((item) => !item.ok)?.error || 'تعذر تشغيل البث الاصطناعي');
    const button = document.querySelector('.state-button[data-state="stream"]');
    button?.classList.toggle('is-active', enabled);
    button?.querySelector('small') && (button.querySelector('small').textContent = enabled ? 'Synthetic stream on' : 'Screen share off');
    if (!enabled && state.mediaKind === 'screen') stopCurrentStream({ updateDiscord: false });
    await refreshSessions();
    addActivity(enabled ? 'بدأ بث اصطناعي' : 'أوقف البث الاصطناعي', `${state.clients.find((client) => client.name === state.selectedAccount)?.nickname || state.selectedAccount} · ${target.channelName}`, 'success', state.selectedAccount);
    toast(enabled ? 'تم تشغيل البث الاصطناعي' : 'تم إيقاف البث الاصطناعي', 'success');
  } catch (error) { toast(error.message, 'error'); } finally { state.mediaBusy = false; updateQuickStateButtons(); }
}

function renderFullActivity(page = 0) { const filter = $('#activityAccountFilter')?.value || ''; const items = JSON.parse(localStorage.getItem('voice-activity') || '[]').filter((item) => !filter || item.account === filter); const size = 20; const pages = Math.max(1, Math.ceil(items.length / size)); state.activityPage = Math.max(0, Math.min(page, pages - 1)); const visible = items.slice(state.activityPage * size, (state.activityPage + 1) * size); $('#fullActivityList').innerHTML = visible.length ? visible.map((item) => `<div class="activity-row"><span class="activity-dot ${escapeHTML(item.tone || '')}"></span><div><strong>${escapeHTML(item.title)}</strong><small>${escapeHTML(item.detail)}</small></div><time>${escapeHTML(new Date(item.time).toLocaleString())}</time></div>`).join('') : '<div class="task-empty">No activity yet</div>'; $('#activityPageLabel').textContent = `${state.activityPage + 1} / ${pages}`; $('#activityPrevButton').disabled = state.activityPage === 0; $('#activityNextButton').disabled = state.activityPage >= pages - 1; }
function initActivity() { $('#activityExpandButton')?.addEventListener('click', () => { const filter = $('#activityAccountFilter'); filter.innerHTML = '<option value="">All accounts</option>' + state.clients.map((client) => `<option value="${escapeHTML(client.name)}">${escapeHTML(client.nickname || client.name)}</option>`).join(''); $('#activityModal').hidden = false; renderFullActivity(0); }); $('#activityAccountFilter')?.addEventListener('change', () => renderFullActivity(0)); const closeActivity = () => { $('#activityModal').hidden = true; }; $('#activityCloseButton')?.addEventListener('click', closeActivity); $('#activityCloseTopButton')?.addEventListener('click', closeActivity); $('#activityModal')?.addEventListener('click', (event) => { if (event.target.id === 'activityModal') closeActivity(); }); $('#activityPrevButton')?.addEventListener('click', () => renderFullActivity(state.activityPage - 1)); $('#activityNextButton')?.addEventListener('click', () => renderFullActivity(state.activityPage + 1)); }
function openLeaveAll() { const active = state.clients.filter((client) => client.voice); const list = $('#leaveAccountList'); list.innerHTML = active.length ? active.map((client) => `<label class="account-target"><input type="checkbox" value="${escapeHTML(client.name)}" data-leave-guild="${escapeHTML(client.voice.guildId)}" checked /><span class="target-avatar">${client.avatar ? `<img src="${escapeHTML(client.avatar)}" alt="" />` : escapeHTML((client.nickname || '?')[0])}</span><span class="target-copy"><strong>${escapeHTML(client.nickname || client.name)}</strong><small>${escapeHTML(client.voice.guildName || client.voice.guildId)} · ${escapeHTML(client.voice.channelName || client.voice.channelId)}</small></span></label>`).join('') : '<div class="task-empty">No connected account is currently in voice</div>'; $('#leaveModal').hidden = false; }
async function leaveAllSelected() { const selected = [...document.querySelectorAll('#leaveAccountList input:checked')].map((input) => ({ name: input.value, guildId: input.dataset.leaveGuild })); if (!selected.length) { toast('اختر حسابًا واحدًا على الأقل', 'error'); return; } const groups = new Map(); selected.forEach((item) => { if (!groups.has(item.guildId)) groups.set(item.guildId, []); groups.get(item.guildId).push(item.name); }); $('#leaveModal').hidden = true; try { for (const [guildId, accounts] of groups) await post('/api/voice/leave', { accounts, guildId });   addActivity('خروج جماعي', `${selected.length} حساب`, 'success'); toast(`تم إخراج ${selected.length} حساب`, 'success'); await refreshSessions(); } catch (error) { toast(error.message, 'error'); } }
function scheduleLiveRefresh() { clearTimeout(state.liveRefreshTimer); state.liveRefreshTimer = setTimeout(() => refreshSessions().catch(() => {}), 180); }
function connectLiveEvents() { if (!window.EventSource || state.liveEvents) return; const events = new EventSource('/api/events'); state.liveEvents = events; events.onmessage = (message) => { try { const event = JSON.parse(message.data); if (event.type === 'operation.completed' && event.summary?.failed) toast(`${event.operation}: ${event.summary.failed} failed`, 'error'); scheduleLiveRefresh(); } catch {} }; events.onerror = () => { events.close(); state.liveEvents = null; setTimeout(connectLiveEvents, 5000); }; }
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
function initNavigation() { document.querySelectorAll('[data-section]').forEach((button) => button.addEventListener('click', () => { const section = button.dataset.section; document.querySelectorAll('.side-nav-item').forEach((item) => item.classList.toggle('is-active', item === button)); const breadcrumb = document.querySelector('.breadcrumb strong'); if (breadcrumb) breadcrumb.textContent = section[0].toUpperCase() + section.slice(1); document.querySelectorAll('[data-panel]').forEach((panel) =>
 { const panels = panel.dataset.panel.split(/\s+/); panel.hidden = !panels.includes(section); }); })); document.querySelector('[data-section="dashboard"]')?.click(); }
function initCustomSelects() {
  document.querySelectorAll('.site-select, .automation-guild').forEach((select) => {
    if (select.dataset.customized) return;
    select.dataset.customized = 'true';
    const wrapper = document.createElement('div'); wrapper.className = `custom-select ${select.id === 'channelSelect' || select.id === 'automationChannel' ? 'room-select' : 'server-select'}`;
    select.parentNode.insertBefore(wrapper, select); wrapper.appendChild(select); select.hidden = true;
    const trigger = document.createElement('button'); trigger.type = 'button'; trigger.className = 'custom-select-trigger'; trigger.setAttribute('aria-haspopup', 'listbox');
    const menu = document.createElement('div'); menu.className = 'custom-select-menu'; menu.setAttribute('role', 'listbox'); wrapper.append(trigger, menu);
    const sync = () => { const selected = select.selectedOptions[0]; trigger.innerHTML = `<span>${escapeHTML(selected?.textContent || 'Select…')}</span><i>⌄</i>`; menu.innerHTML = [...select.options].map((option) => `<button type="button" role="option" data-value="${escapeHTML(option.value)}" ${option.disabled ? 'disabled' : ''} class="${option.value === select.value ? 'is-selected' : ''}">${escapeHTML(option.textContent)}</button>`).join(''); };
    trigger.addEventListener('click', () => { document.querySelectorAll('.custom-select.is-open').forEach((item) => { if (item !== wrapper) item.classList.remove('is-open'); }); wrapper.classList.toggle('is-open'); });
    menu.addEventListener('click', (event) => { const option = event.target.closest('[data-value]'); if (!option || option.disabled) return; select.value = option.dataset.value; select.dispatchEvent(new Event('change', { bubbles: true })); wrapper.classList.remove('is-open'); sync(); });
    new MutationObserver(sync).observe(select, { childList: true, subtree: true }); select.addEventListener('change', sync); sync();
  });
  document.addEventListener('click', (event) => { if (!event.target.closest('.custom-select')) document.querySelectorAll('.custom-select.is-open').forEach((item) => item.classList.remove('is-open')); });
}
function init() {
  initTheme(); initLanguage(); initNavigation(); initActivity(); initCustomSelects();
  $('#serverSelect')?.addEventListener('change', (event) => { state.selectedGuildId = event.target.value; state.selectedTarget = null; renderChannels(); }); $('#roomSearch')?.addEventListener('input', () => { state.selectedTarget = null; renderChannels(); });
  $('#connectButton').addEventListener('click', connect); $('#bulkConnectButton').addEventListener('click', bulkConnect); $('#disconnectButton').addEventListener('click', openDisconnect); $('#refreshButton').addEventListener('click', refreshChannels); $('#accountSelect').addEventListener('change', async (event) => { state.selectedAccount = event.target.value; await loadGuilds(); await loadAutomationCatalog(); }); $('#automationGuild').addEventListener('change', renderAutomationChannels); $('#automationChannel').addEventListener('change', renderTargetAccounts); $('#rotationRoomFilter').addEventListener('input', (event) => { state.rotationRoomFilter = event.target.value; state.rotationRoomPage = 0; renderRotationRooms(); }); $('#rotationPrevButton').addEventListener('click', () => { state.rotationRoomPage -= 1; renderRotationRooms(); }); $('#rotationNextButton').addEventListener('click', () => { state.rotationRoomPage += 1; renderRotationRooms(); }); $('#bulkJoinButton').addEventListener('click', bulkJoinSelected); $('#channelSelect').addEventListener('change', handleChannelChange); $('#joinButton').addEventListener('click', join); $('#joinAllButton').addEventListener('click', joinAll); $('#leaveButton').addEventListener('click', leave); $('#cameraButton')?.addEventListener('click', toggleCamera); $('#screenButton')?.addEventListener('click', toggleScreen); $('#startRotationButton').addEventListener('click', startRotation); $('#startCycleButton').addEventListener('click', startCycle); $('#stopMediaButton')?.addEventListener('click', () => stopCurrentStream()); $('#applyBulkStateButton')?.addEventListener('click', applyBulkState); $('#overviewFilter')?.addEventListener('input', (event) => { state.overviewFilter = event.target.value; refreshSessions(); }); $('#overviewSort')?.addEventListener('change', (event) => { state.overviewSort = event.target.value; refreshSessions(); }); document.querySelectorAll('.state-button').forEach((button) => button.addEventListener('click', () => applyState(button.dataset.state))); document.querySelectorAll('#statePicker input').forEach((input) => input.addEventListener('change', () => input.closest('.state-option')?.classList.toggle('is-selected', input.checked)));
  $('#operationClose').addEventListener('click', () => { $('#operationModal').hidden = true; $('.operation-loader')?.classList.remove('is-done', 'is-error'); }); $('#leaveAllButton')?.addEventListener('click', openLeaveAll); $('#confirmLeaveButton')?.addEventListener('click', leaveAllSelected); $('#cancelLeaveButton')?.addEventListener('click', () => { $('#leaveModal').hidden = true; }); $('#confirmDisconnectButton')?.addEventListener('click', disconnectSelected); $('#cancelDisconnectButton')?.addEventListener('click', () => { $('#disconnectModal').hidden = true; }); $('#disconnectModalClose')?.addEventListener('click', () => { $('#disconnectModal').hidden = true; }); window.addEventListener('beforeunload', () => stopCurrentStream({ updateDiscord: false }));
  document.addEventListener('change', (event) => { if (event.target.closest('#automationAccounts')) updateQuickStateButtons(); });
  loadClients().catch(() => {}); refreshSessions(); connectLiveEvents(); setInterval(refreshSessions, 15000);
}
init();
