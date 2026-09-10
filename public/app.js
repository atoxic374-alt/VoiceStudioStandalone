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
  rotationRoomFilter: '', profilesPage: 0,
  rotationRoomPage: 0,
  rotationRoomSelection: new Set(),
  busy: new Set(),
  overviewFilter: '', overviewSort: 'account',
  lastOperation: null, authenticated: false, mediaBusy: false, tasks: [],
  refreshPromise: null, liveEvents: null, liveRefreshTimer: null, taskCountdownTimer: null,
  playingSessions: [], playingSessionsPromise: null,
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
function operationStart(url, body = {}) { const modal = $('#operationModal'); if (!modal) return; const key = Object.keys(operationNames).find((item) => url.includes(item)); $('#operationTitle').textContent = operationNames[key] || 'Processing'; $('#operationSubtitle').textContent = 'Processing in fast batches…'; $('#operationResult').textContent = 'Success: 0 · Failed: 0 · Retries: 0'; $('#operationClose').hidden = true; $('.operation-loader')?.classList.remove('is-done', 'is-error'); const names = Array.isArray(body.accounts) ? body.accounts.map((item) => typeof item === 'string' ? item : item.name).filter(Boolean) : (body.name ? [body.name] : []); const profiles = names.map((name) => state.clients.find((client) => client.name === name) || { name, nickname: name }).filter(Boolean); modal.dataset.accountNames = JSON.stringify(names); $('#operationAccounts').innerHTML = profiles.length ? profiles.map((profile) => `<div class="operation-account" data-operation-name="${escapeHTML(profile.name)}"><span>${profile.avatar ? `<img src="${escapeHTML(profile.avatar)}" alt="" />` : escapeHTML((profile.nickname || profile.name || '?')[0])}</span><strong>${escapeHTML(profile.nickname || profile.displayName || profile.username || profile.name)}</strong><small>${escapeHTML(profile.name)} · Waiting…</small></div>`).join('') : '<div class="operation-empty">Working on the selected accounts…</div>'; modal.hidden = false; }
function operationFinish(payload) { const modal = $('#operationModal'); if (!modal) return; const results = Array.isArray(payload?.results) ? payload.results : []; const calculated = { total: results.length, ok: results.filter((item) => item?.ok === true && !item?.skipped).length, skipped: results.filter((item) => item?.skipped).length, failed: results.filter((item) => item?.ok !== true && !item?.skipped).length, retries: results.reduce((sum, item) => sum + Number(item?.retries || 0), 0) }; const resultSummary = payload?.summary || calculated; const byName = new Map(results.filter((item) => item?.name).map((item) => [String(item.name), item])); $('#operationSubtitle').textContent = 'Completed'; $('#operationResult').textContent = `Success: ${resultSummary.ok || 0} · Failed: ${resultSummary.failed || 0} · Retries: ${resultSummary.retries || 0}${resultSummary.skipped ? ` · Skipped: ${resultSummary.skipped}` : ''}`; let rows = [...$('#operationAccounts').querySelectorAll('.operation-account')]; if (!rows.length && results.length) { $('#operationAccounts').innerHTML = results.map((result) => `<div class="operation-account" data-operation-name="${escapeHTML(result.name || '')}"><span>${result.avatar ? `<img src="${escapeHTML(result.avatar)}" alt="" />` : escapeHTML((result.name || '?')[0])}</span><strong>${escapeHTML(result.name || 'Account')}</strong><small></small></div>`).join(''); rows = [...$('#operationAccounts').querySelectorAll('.operation-account')]; } rows.forEach((row, index) => { const result = byName.get(row.dataset.operationName) || results[index]; if (result) { row.classList.remove('is-error','is-success'); row.classList.add(result.ok === true ? 'is-success' : 'is-error'); const avatar = row.querySelector(':scope > span'); if (avatar) avatar.innerHTML = result.avatar ? `<img src="${escapeHTML(result.avatar)}" alt="" />` : escapeHTML((result.name || '?')[0]); const name = row.querySelector('strong'); if (name) name.textContent = result.name || 'Account'; const detail = row.querySelector('small'); if (detail) detail.textContent = result.skipped ? 'Skipped · managed by rotation' : result.ok === true ? (result.retries ? `Success · retried ${result.retries}x` : 'Success') : (result.error || 'Failed'); } }); $('.operation-loader')?.classList.add(resultSummary.failed ? 'is-error' : 'is-done'); $('#operationClose').hidden = false; }
function operationFail(error) { const modal = $('#operationModal'); if (!modal) return; $('#operationSubtitle').textContent = 'Failed'; $('#operationResult').textContent = error.message || 'Request failed'; $('.operation-loader')?.classList.add('is-error'); $('#operationClose').hidden = false; }
const post = async (url, body) => { operationStart(url, body); try { const result = await api(url, { method: 'POST', body: JSON.stringify(body) }); operationFinish(result); return result; } catch (error) { operationFail(error); throw error; } };

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function accountNickname(name) { const client = state.clients.find((item) => item.name === name); return client?.nickname || client?.displayName || client?.username || name; }
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
  const button = ({ connect: '#connectButton', join: '#joinButton', joinAll: '#joinAllButton', leave: '#leaveButton' }[key]);
  if (button) $(button).disabled = busy;
}
function playingSelectedAccounts() { return [...document.querySelectorAll('#playingAccounts input[type="checkbox"]:checked')].map((input) => input.value); }
function updatePlayingSelection() { const count = playingSelectedAccounts().length; if ($('#playingSelectionCount')) $('#playingSelectionCount').textContent = String(count); renderPlayingChecklist(); savePlayingDraft(); }
function renderPlayingAccounts() { const root = $('#playingAccounts'); if (!root) return; const selected = new Set(playingSelectedAccounts()); const custom = new Map([...root.querySelectorAll('.playing-account-phrases')].map((area) => [area.dataset.account, { value: area.value, visible: area.classList.contains('is-visible') }])); const sessions = new Map((state.playingSessions || []).map((session) => [session.account, session])); const allowed = state.playingChannelAccounts || []; root.innerHTML = state.clients.length ? state.clients.map((client) => { const session = sessions.get(client.name); const compatible = !allowed.length || allowed.includes(client.name); const status = !compatible ? 'Cannot access room' : session?.active ? 'Running' : session ? 'Setup saved · Ready' : 'Connected · Not saved'; return `<div class="playing-account ${compatible ? '' : 'is-incompatible'}"><label><input type="checkbox" value="${escapeHTML(client.name)}" ${selected.has(client.name) && compatible ? 'checked' : ''} ${compatible ? '' : 'disabled'} /><span class="target-avatar">${client.avatar ? `<img src="${escapeHTML(client.avatar)}" alt="" />` : escapeHTML((client.name || '?')[0])}</span><span><strong>${escapeHTML(client.nickname || client.displayName || client.username || client.name)}</strong><small>${escapeHTML(client.name)} · <em>${escapeHTML(status)}</em></small></span></label><button class="playing-customize" type="button">${custom.get(client.name)?.visible ? 'Hide' : 'Customize'}</button><textarea class="playing-account-phrases ${custom.get(client.name)?.visible ? 'is-visible' : ''}" data-account="${escapeHTML(client.name)}" rows="2" placeholder="كلمات هذا الحساب (سطر لكل زر، اختياري)">${escapeHTML(custom.get(client.name)?.value || '')}</textarea></div>`; }).join('') : '<div class="task-empty">لا توجد حسابات متصلة</div>'; root.querySelectorAll('input[type="checkbox"]').forEach((input) => input.addEventListener('change', updatePlayingSelection)); root.querySelectorAll('.playing-customize').forEach((button) => button.addEventListener('click', () => { const area = button.parentElement.querySelector('.playing-account-phrases'); area.classList.toggle('is-visible'); button.textContent = area.classList.contains('is-visible') ? 'Hide' : 'Customize'; })); updatePlayingSelection(); }
function addPlayingStep(step = {}) { const root = $('#playingSteps'); const row = document.createElement('div'); row.className = 'playing-step'; row.draggable = true; row.innerHTML = `<span class="playing-step-number">${root.children.length + 1}</span><input class="playing-button-name" type="text" maxlength="80" placeholder="اسم الزر، مثال: دخول" value="${escapeHTML(step.button || '')}" /><input class="playing-phrase" type="text" maxlength="500" placeholder="كلمة أو بدائل بـ | (اختياري)" value="${escapeHTML(step.phrase || '')}" /><button class="playing-remove" type="button">×</button>`; row.querySelector('.playing-remove').addEventListener('click', () => { row.remove(); [...root.children].forEach((item, index) => { item.querySelector('.playing-step-number').textContent = index + 1; }); renderPlayingChecklist(); savePlayingDraft(); }); row.addEventListener('dragstart', () => row.classList.add('is-dragging')); row.addEventListener('dragend', () => row.classList.remove('is-dragging')); row.addEventListener('dragover', (event) => { event.preventDefault(); const dragging = root.querySelector('.is-dragging'); if (dragging && dragging !== row) root.insertBefore(dragging, row); [...root.children].forEach((item, index) => { item.querySelector('.playing-step-number').textContent = index + 1; }); }); root.appendChild(row); row.querySelectorAll('input').forEach((input) => input.addEventListener('input', () => { renderPlayingChecklist(); savePlayingDraft(); })); }
function playingSteps() { return [...document.querySelectorAll('.playing-step')].map((row) => ({ button: row.querySelector('.playing-button-name').value.trim(), phrase: row.querySelector('.playing-phrase').value.trim() })).filter((step) => step.button); }
function playingDraft() { return { scenarioName: $('#playingScenarioName')?.value || '', guildId: $('#playingGuildSelect')?.value || '', channelId: $('#playingChannelId')?.value || '', interval: $('#playingInterval')?.value || '5', accountDelay: $('#playingAccountDelay')?.value || '0', steps: playingSteps() }; }
function savePlayingDraft() { try { localStorage.setItem('playing-draft', JSON.stringify(playingDraft())); } catch {} }
function restorePlayingDraft() { try { const draft = JSON.parse(localStorage.getItem('playing-draft') || 'null'); if (draft) { if ($('#playingScenarioName')) $('#playingScenarioName').value = draft.scenarioName || ''; if ($('#playingInterval')) $('#playingInterval').value = draft.interval || '5'; if ($('#playingAccountDelay')) $('#playingAccountDelay').value = draft.accountDelay || '0'; const root = $('#playingSteps'); if (root && draft.steps?.length) { root.innerHTML = ''; draft.steps.forEach((step) => addPlayingStep(step)); } } const preview = JSON.parse(localStorage.getItem('playing-preview') || 'null'); if (preview?.length && $('#playingPreview')) renderPlayingPreview(preview); } catch {} }
function renderPlayingPreview(preview) { if ($('#playingPreview')) $('#playingPreview').innerHTML = preview.map((step) => `<div class="playing-preview-row"><b>${step.order}</b><strong>${escapeHTML(step.button)}</strong><span>${escapeHTML(step.phrase || 'بدون رسالة')}</span></div>`).join(''); }
function renderPlayingChecklist() { const selected = playingSelectedAccounts(); const guild = $('#playingGuildSelect')?.selectedOptions[0]?.textContent || ''; const room = $('#playingChannelSelect')?.selectedOptions[0]?.textContent || ''; const steps = playingSteps(); const checks = [{ ok: selected.length > 0, text: selected.length ? `${selected.length} account${selected.length === 1 ? '' : 's'} selected` : 'Select at least one account' }, { ok: !!$('#playingGuildSelect')?.value, text: guild || 'Select a server' }, { ok: !!$('#playingChannelId')?.value, text: room || 'Select a game room' }, { ok: steps.length > 0, text: steps.length ? `${steps.length} action${steps.length === 1 ? '' : 's'} ready` : 'Add one action' }]; const root = $('#playingChecklist'); if (root) root.innerHTML = checks.map((item) => `<span class="playing-check ${item.ok ? 'is-ok' : 'is-missing'}">${item.ok ? '✓' : '!' } ${escapeHTML(item.text)}</span>`).join(''); const summary = $('#playingSummary'); if (summary) summary.innerHTML = `<span>${state.clients.length} connected</span><span>${selected.length} selected</span><span>${escapeHTML(guild || 'No server')}</span><span>${escapeHTML(room || 'No room')}</span><span>${steps.length} actions</span>`; const ready = checks.every((item) => item.ok); return ready; }
function playingControlAccounts() { return [...document.querySelectorAll('#playingControlList input[type="checkbox"]:checked')].map((input) => input.value); }
function savePlayingRestartAccounts(accounts = playingControlAccounts()) { try { localStorage.setItem('playing-restart-accounts', JSON.stringify([...new Set(accounts)])); } catch {} if ($('#playingControlCount')) $('#playingControlCount').textContent = `${accounts.length} selected`; }
function renderPlayingControlList(sessions) { let saved = []; try { saved = JSON.parse(localStorage.getItem('playing-restart-accounts') || '[]'); } catch {} const selected = new Set(Array.isArray(saved) ? saved : []); const root = $('#playingControlList'); if (!root) return; root.innerHTML = sessions.length ? sessions.map((session) => `<label class="playing-control-item ${session.active ? 'is-active' : ''}"><input type="checkbox" value="${escapeHTML(session.account)}" ${selected.has(session.account) ? 'checked' : ''} /><span class="playing-control-state"></span><span><strong>${escapeHTML(session.account)}</strong><small>${escapeHTML(session.status || (session.active ? 'running' : 'stopped'))} · ${session.active ? 'Active' : 'Ready to restart'}</small></span></label>`).join('') : '<div class="task-empty">لا توجد جلسات محفوظة</div>'; root.querySelectorAll('input[type="checkbox"]').forEach((input) => input.addEventListener('change', () => savePlayingRestartAccounts())); savePlayingRestartAccounts([...root.querySelectorAll('input:checked')].map((input) => input.value)); }
function renderPlayingSessions() { const sessions = state.playingSessions || []; const active = sessions.filter((session) => session.active); $('#playingStatus').textContent = `${active.length} active`; $('#navPlayingCount').textContent = String(active.length); renderPlayingControlList(sessions); $('#playingSessions').innerHTML = sessions.length ? sessions.map((session) => `<div class="playing-session ${session.active ? 'is-active' : ''}"><div><strong>${escapeHTML(session.account)}</strong><small>${escapeHTML(session.scenarioName || 'Playing')} · ${escapeHTML(session.status || (session.active ? 'running' : 'saved'))} · ${session.steps?.length || 0} actions</small>${session.lastResult?.error ? `<small class="playing-last">${escapeHTML(session.lastResult.error)}${session.lastResult.noResponse ? ' · sent, app did not respond' : ''}</small>` : session.lastAction ? `<small class="playing-last">آخر زر: ${escapeHTML(session.lastAction.button)} · الكلمة: ${escapeHTML(session.lastAction.phrase || 'بدون رسالة')}${session.lastAction.noResponse ? ' · التطبيق لم يرد' : ''}</small>` : ''}</div><div class="playing-session-actions"><button class="ghost-button playing-edit-one" data-account="${escapeHTML(session.account)}" type="button">Edit</button><button class="ghost-button playing-stop-one" data-account="${escapeHTML(session.account)}" type="button">${session.active ? 'Stop' : 'Stopped'}</button><button class="ghost-button playing-add-one" data-account="${escapeHTML(session.account)}" type="button">Add selected</button><button class="ghost-button playing-remove-one" data-account="${escapeHTML(session.account)}" type="button">Remove</button></div></div>`).join('') : '<div class="task-empty">لا توجد جلسات محفوظة</div>'; document.querySelectorAll('.playing-edit-one').forEach((button) => button.addEventListener('click', () => editPlayingSession(button.dataset.account))); document.querySelectorAll('.playing-stop-one').forEach((button) => button.addEventListener('click', async () => { if (button.textContent === 'Stopped') return; button.disabled = true; try { await api('/api/playing/stop', { method: 'POST', body: JSON.stringify({ accounts: [button.dataset.account] }) }); await loadPlayingSessions(); } catch (error) { button.disabled = false; toast(error.message, 'error'); } })); document.querySelectorAll('.playing-add-one').forEach((button) => button.addEventListener('click', async () => { const selected = playingSelectedAccounts().filter((account) => account !== button.dataset.account && !(state.playingSessions || []).some((session) => session.account === account)); if (!selected.length) { toast('اختر حسابًا جديدًا غير مضاف إلى Playing أولًا', 'error'); return; } button.disabled = true; try { const result = await api('/api/playing/add-accounts', { method: 'POST', body: JSON.stringify({ sourceAccount: button.dataset.account, accounts: selected }) }); toast(`تمت إضافة ${result.added} حساب إلى جلسة Playing`, 'success'); await loadPlayingSessions(); } catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; } })); document.querySelectorAll('.playing-remove-one').forEach((button) => button.addEventListener('click', async () => { if (!window.confirm(`إزالة ${button.dataset.account} من السيناريو؟`)) return; try { await post('/api/playing/delete', { account: button.dataset.account }); await loadPlayingSessions(); } catch (error) { toast(error.message, 'error'); } })); }
async function editPlayingSession(account) { const session = (state.playingSessions || []).find((item) => item.account === account); if (!session) return; state.playingEditAccount = account; document.querySelector('[data-playing-tab="setup"]')?.click(); $('#playingEditBanner').hidden = false; $('#playingEditAccount').textContent = account; $('#playingScenarioName').value = session.scenarioName || ''; $('#playingInterval').value = Math.max(1.5, Number(session.intervalMs || 5000) / 1000); $('#playingSteps').innerHTML = ''; (session.steps || []).forEach((step) => addPlayingStep(step)); document.querySelectorAll('#playingAccounts input[type="checkbox"]').forEach((input) => { input.checked = input.value === account; }); updatePlayingSelection(); if (session.guildId && $('#playingGuildSelect')) { $('#playingGuildSelect').value = session.guildId; $('#playingGuildSelect').dispatchEvent(new Event('change', { bubbles: true })); await loadPlayingChannels(); } if ($('#playingChannelSelect')) { $('#playingChannelSelect').value = session.channelId; $('#playingChannelId').value = session.channelId; $('#playingChannelName').value = session.channelName || ''; $('#playingChannelSelect').dispatchEvent(new Event('change', { bubbles: true })); } renderPlayingChecklist(); savePlayingDraft(); toast(`تم فتح إعدادات ${account} للتعديل`, 'success'); }
function cancelPlayingEdit() { state.playingEditAccount = null; if ($('#playingEditBanner')) $('#playingEditBanner').hidden = true; $('#playingScenarioName').value = ''; $('#playingChannelId').value = ''; $('#playingChannelName').value = ''; $('#playingSteps').innerHTML = ''; addPlayingStep(); document.querySelectorAll('#playingAccounts input[type="checkbox"]').forEach((input) => { input.checked = false; }); renderPlayingChecklist(); savePlayingDraft(); }
async function loadPlayingSessions() { if (state.playingSessionsPromise) return state.playingSessionsPromise; state.playingSessionsPromise = (async () => { try { const data = await api('/api/playing/sessions'); state.playingSessions = data.sessions || []; renderPlayingSessions(); } catch (error) { console.warn('[playing]', error); } finally { state.playingSessionsPromise = null; } })(); return state.playingSessionsPromise; }
async function loadPlayingChannels(filter = '') { try { const guildSelect = $('#playingGuildSelect'); const roomSelect = $('#playingChannelSelect'); if (!guildSelect || !roomSelect) return; const data = await api(`/api/playing/channels${guildSelect.value ? `?guildId=${encodeURIComponent(guildSelect.value)}` : ''}`); if (!guildSelect.value) { state.playingChannelAccounts = []; guildSelect.innerHTML = data.guilds?.length ? `<option value="">Select a server</option>${data.guilds.map((guild) => `<option value="${escapeHTML(guild.id)}">${escapeHTML(guild.name)}</option>`).join('')}` : '<option value="">No servers available</option>'; const draft = JSON.parse(localStorage.getItem('playing-draft') || 'null'); if (draft?.guildId && [...guildSelect.options].some((option) => option.value === draft.guildId)) { guildSelect.value = draft.guildId; return loadPlayingChannels(filter); } roomSelect.innerHTML = '<option value="">Select a server first</option>'; roomSelect.disabled = true; $('#playingChannelSearch').disabled = true; renderPlayingAccounts(); return; } const query = String(filter || '').trim().toLowerCase(); const channels = (data.channels || []).filter((channel) => !query || channel.name.toLowerCase().includes(query)); state.playingChannels = channels; roomSelect.innerHTML = channels.length ? `<option value="">Select a game room</option>${channels.map((channel) => `<option value="${escapeHTML(channel.id)}" data-channel-name="${escapeHTML(channel.name)}">#${escapeHTML(channel.name)} · ${channel.accounts.length} account${channel.accounts.length === 1 ? '' : 's'}</option>`).join('')}` : '<option value="">No matching text rooms</option>'; roomSelect.disabled = false; $('#playingChannelSearch').disabled = false; const draft = JSON.parse(localStorage.getItem('playing-draft') || 'null'); const preferred = $('#playingChannelId').value || draft?.channelId || ''; roomSelect.value = [...roomSelect.options].some((option) => option.value === preferred) ? preferred : ''; if (roomSelect.value) { $('#playingChannelId').value = roomSelect.value; $('#playingChannelName').value = roomSelect.selectedOptions[0]?.dataset.channelName || ''; state.playingChannelAccounts = channels.find((channel) => channel.id === roomSelect.value)?.accounts || []; } renderPlayingAccounts(); } catch (error) { console.warn('[playing channels]', error); } }
async function savePlaying() { const accounts = playingSelectedAccounts(); const baseSteps = playingSteps(); if (!accounts.length) return toast('اختر حسابًا واحدًا على الأقل', 'error'); if (!baseSteps.length) return toast('أضف اسم زر واحدًا على الأقل', 'error'); const selectedChannel = $('#playingChannelSelect')?.selectedOptions[0]; const body = { scenarioName: $('#playingScenarioName')?.value.trim() || 'Playing scenario', guildId: $('#playingGuildSelect')?.value || '', channelId: $('#playingChannelSelect')?.value || $('#playingChannelId').value.trim(), channelName: selectedChannel?.dataset.channelName || $('#playingChannelName').value.trim(), intervalMs: Number($('#playingInterval').value || 5) * 1000 }; if (!body.channelId) return toast('اختر قناة اللعبة أولًا', 'error'); try { for (const account of accounts) { const customText = document.querySelector(`.playing-account-phrases[data-account="${CSS.escape(account)}"]`)?.value || ''; const custom = customText.trim() ? customText.split('\n') : null; const steps = baseSteps.map((step, index) => ({ button: step.button, phrase: custom && custom[index] !== undefined ? custom[index].trim() : step.phrase })); await api('/api/playing/save', { method: 'POST', body: JSON.stringify({ ...body, account, steps }) }); } feedback('#playingFeedback', `تم حفظ الإعداد لـ ${accounts.length} حساب`, 'success'); await loadPlayingSessions(); return true; } catch (error) { feedback('#playingFeedback', error.message, 'error'); return false; } }
async function startPlaying() { const accounts = playingSelectedAccounts(); if (!accounts.length) return toast('اختر الحسابات التي تريد تشغيلها', 'error'); const accountDelayMs = Math.max(0, Number($('#playingAccountDelay')?.value || 0) * 1000); try { const data = await api('/api/playing/start', { method: 'POST', body: JSON.stringify({ accounts, accountDelayMs }) }); const failed = (data.results || []).filter((item) => !item.ok); toast(failed.length ? `${data.results.length - failed.length} started · ${failed.length} failed: ${failed[0].error}` : 'تم تشغيل جلسات Playing بالتدرج المحدد', failed.length ? 'error' : 'success'); await loadPlayingSessions(); } catch (error) { toast(error.message, 'error'); } }
async function stopPlaying() { const accounts = playingSelectedAccounts(); if (!accounts.length) return toast('اختر الحسابات التي تريد إيقافها', 'error'); try { await api('/api/playing/stop', { method: 'POST', body: JSON.stringify({ accounts }) }); toast('تم إيقاف الجلسات المحددة', 'success'); await loadPlayingSessions(); } catch (error) { toast(error.message, 'error'); } }
async function stopPlayingSessions() { const accounts = playingControlAccounts(); if (!accounts.length) return toast('حدد جلسة واحدة على الأقل من قائمة الجلسات', 'error'); savePlayingRestartAccounts(accounts); try { await api('/api/playing/stop', { method: 'POST', body: JSON.stringify({ accounts }) }); toast(`تم إيقاف ${accounts.length} جلسة وحفظها داخل Restart`, 'success'); await loadPlayingSessions(); } catch (error) { toast(error.message, 'error'); } }
async function restartPlayingSessions() { let accounts = []; try { accounts = JSON.parse(localStorage.getItem('playing-restart-accounts') || '[]'); } catch {} if (!Array.isArray(accounts) || !accounts.length) return toast('لا توجد حسابات محفوظة داخل Restart', 'error'); try { const data = await api('/api/playing/start', { method: 'POST', body: JSON.stringify({ accounts }) }); const failed = (data.results || []).filter((item) => !item.ok); toast(failed.length ? `${data.results.length - failed.length} restarted · ${failed.length} failed` : `تمت إعادة تشغيل ${accounts.length} جلسة`, failed.length ? 'error' : 'success'); await loadPlayingSessions(); } catch (error) { toast(error.message, 'error'); } }
function renderPlayingEvents() { const events = state.playingEvents || []; const query = ($('#playingEventSearch')?.value || '').trim().toLowerCase(); const kind = $('#playingEventFilter')?.value || ''; const account = $('#playingEventAccount')?.value || ''; const accounts = [...new Set(events.map((event) => event.account).filter(Boolean))]; if ($('#playingEventAccount')) $('#playingEventAccount').innerHTML = '<option value="">All accounts</option>' + accounts.map((name) => '<option value="' + escapeHTML(name) + '">' + escapeHTML(name) + '</option>').join(''); if ($('#playingEventAccount')) $('#playingEventAccount').value = account; const visible = events.filter((event) => (!account || event.account === account) && (!kind || event.event === kind) && (!query || JSON.stringify(event).toLowerCase().includes(query))); const labels = { 'button.waiting': 'Waiting for button', 'button.found': 'Button found', 'button.click.started': 'Click started', 'button.click.completed': 'Click completed', 'button.click.failed': 'Click failed', 'button.click.no-response': 'Sent · no app response', 'phrase.send.started': 'Message sending', 'phrase.send.completed': 'Message sent', 'phrase.send.failed': 'Message failed', 'action.completed': 'Action completed', 'action.failed': 'Action failed' }; const grouped = new Map(); visible.forEach((event) => { const name = event.account || 'workspace'; if (!grouped.has(name)) grouped.set(name, []); grouped.get(name).push(event); }); $('#playingEvents').innerHTML = grouped.size ? [...grouped.entries()].map(([name, items]) => '<section class="playing-account-log"><header><strong>' + escapeHTML(name) + '</strong><span>' + items.length + ' events</span></header>' + items.map((event) => { const detail = event.result?.error || event.error || event.reason || event.label || (event.result?.button ? 'Button: ' + event.result.button : event.requested ? 'Requested: ' + event.requested : event.phrase ? 'Message: ' + event.phrase : ''); const found = event.available?.length || event.result?.available?.length ? 'Available: ' + (event.available || event.result.available).join(', ') : ''; return '<div class="playing-event"><span class="playing-event-kind">' + escapeHTML(labels[event.event] || event.event) + '</span><small>' + escapeHTML(detail) + (found ? ' · ' + escapeHTML(found) : '') + '</small><time>' + escapeHTML(new Date(event.time).toLocaleTimeString()) + '</time></div>'; }).join('') + '</section>').join('') : '<div class="task-empty">لا توجد نتائج مطابقة</div>'; }
async function loadPlayingEvents() { try { const data = await api('/api/playing/events'); state.playingEvents = data.events || []; renderPlayingEvents(); } catch (error) { console.warn('[playing events]', error); } }
async function previewPlaying() { const steps = playingSteps(); try { const data = await api('/api/playing/preview', { method: 'POST', body: JSON.stringify({ steps }) }); localStorage.setItem('playing-preview', JSON.stringify(data.preview)); renderPlayingPreview(data.preview); } catch (error) { toast(error.message, 'error'); } }
async function saveAndRunPlaying() { if (!renderPlayingChecklist()) { toast('أكمل قائمة التحقق أولًا', 'error'); return; } if (await savePlaying()) await startPlaying(); }
function initPlaying() { addPlayingStep(); restorePlayingDraft(); renderPlayingAccounts(); loadPlayingChannels(); const refreshChecklist = () => { renderPlayingChecklist(); savePlayingDraft(); }; $('#playingSummaryToggle')?.addEventListener('click', () => { const summary = $('#playingSummary'); const button = $('#playingSummaryToggle'); const expanded = button.getAttribute('aria-expanded') === 'true'; summary.hidden = expanded; button.setAttribute('aria-expanded', String(!expanded)); button.querySelector('span').textContent = expanded ? 'Show overview' : 'Hide overview'; }); $('#playingGuildSelect')?.addEventListener('change', () => { $('#playingChannelId').value = ''; $('#playingChannelName').value = ''; $('#playingChannelSearch').value = ''; state.playingChannelAccounts = []; loadPlayingChannels(); refreshChecklist(); }); $('#playingChannelSearch')?.addEventListener('input', (event) => loadPlayingChannels(event.target.value)); $('#playingChannelSelect')?.addEventListener('change', (event) => { $('#playingChannelId').value = event.target.value; $('#playingChannelName').value = event.target.selectedOptions[0]?.dataset.channelName || ''; state.playingChannelAccounts = state.playingChannels?.find((channel) => channel.id === event.target.value)?.accounts || []; renderPlayingAccounts(); refreshChecklist(); }); document.querySelectorAll('#playingScenarioName, #playingInterval, #playingAccountDelay').forEach((input) => input.addEventListener('input', refreshChecklist)); $('#playingEventSearch')?.addEventListener('input', renderPlayingEvents); $('#playingEventAccount')?.addEventListener('change', renderPlayingEvents); $('#playingEventFilter')?.addEventListener('change', renderPlayingEvents); document.querySelectorAll('[data-playing-tab]').forEach((button) => button.addEventListener('click', () => { const tab = button.dataset.playingTab; document.querySelectorAll('[data-playing-tab]').forEach((item) => { const active = item === button; item.classList.toggle('is-active', active); item.setAttribute('aria-selected', String(active)); }); document.querySelectorAll('[data-playing-pane]').forEach((pane) => { const active = pane.dataset.playingPane === tab; pane.classList.toggle('is-active', active); pane.toggleAttribute('hidden', !active); }); if (tab === 'activity') loadPlayingEvents(); })); $('#playingAddStep')?.addEventListener('click', () => addPlayingStep()); $('#playingSelectAll')?.addEventListener('click', () => { const boxes = [...document.querySelectorAll('#playingAccounts input:not(:disabled)')]; const all = boxes.length && boxes.every((box) => box.checked); boxes.forEach((box) => { box.checked = !all; }); updatePlayingSelection(); }); $('#playingSave')?.addEventListener('click', savePlaying); $('#playingSaveRun')?.addEventListener('click', saveAndRunPlaying); $('#playingCancelEdit')?.addEventListener('click', cancelPlayingEdit); $('#playingPreviewButton')?.addEventListener('click', previewPlaying); $('#playingPreviewToggle')?.addEventListener('click', () => { const preview = $('#playingPreview'); const button = $('#playingPreviewToggle'); const expanded = button.getAttribute('aria-expanded') === 'true'; preview.hidden = expanded; button.setAttribute('aria-expanded', String(!expanded)); button.textContent = expanded ? 'Show preview' : 'Hide preview'; }); $('#playingStart')?.addEventListener('click', startPlaying); $('#playingStop')?.addEventListener('click', stopPlayingSessions); $('#playingRestart')?.addEventListener('click', restartPlayingSessions); $('#playingEmergency')?.addEventListener('click', async () => { const active = (state.playingSessions || []).filter((session) => session.active).length; await api('/api/playing/emergency-stop', { method: 'POST', body: '{}' }); toast(`تم إيقاف ${active} جلسة فورًا`, 'success'); await loadPlayingSessions(); }); $('#playingRefreshEvents')?.addEventListener('click', loadPlayingEvents); document.querySelectorAll('[data-playing-pane]').forEach((pane, index) => { if (index > 0) pane.hidden = true; }); loadPlayingSessions(); renderPlayingChecklist(); }

async function loadClients(preferred = '') {
  const data = await api('/api/discord/clients');
  state.clients = data.clients || [];
  const select = $('#accountSelect');
  const current = preferred || state.selectedAccount;
  select.innerHTML = state.clients.length
    ? state.clients.map((client) => `<option value="${escapeHTML(client.name)}">${escapeHTML(client.nickname || client.displayName || client.username || client.name)}</option>`).join('')
    : '<option value="">اتصل بحساب أولًا</option>';
  state.selectedAccount = state.clients.some((client) => client.name === current) ? current : (state.clients[0]?.name || '');
  select.value = state.selectedAccount;
  $('#accountBadge').textContent = state.clients.length ? `${state.clients.length} connected` : 'No accounts'; $('#navAccountCount').textContent = String(state.clients.length);
  $('#connectionLabel').textContent = state.clients.length ? `${state.clients.length} حساب متصل` : 'جاهز للاتصال';
  renderProfiles(state.clients);
  renderPlayingAccounts();
  updatePlayingSelection();
  loadPlayingChannels();
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
  const pageSize = 20;
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
    wrapper.innerHTML = data.accounts.length ? data.accounts.map((account) => `<label class="account-target ${account.available ? '' : 'is-disabled'}"><input type="checkbox" value="${escapeHTML(account.name)}" ${account.available ? '' : 'disabled'} /><span class="target-avatar">${account.avatar ? `<img src="${escapeHTML(account.avatar)}" alt="" />` : escapeHTML((account.name || '?')[0])}</span><span class="target-copy"><strong>${escapeHTML(account.nickname || account.displayName || account.username || account.name)}</strong><small>${escapeHTML(account.name)} · ID: ${escapeHTML(account.id || '—')} · ${account.available ? (account.current ? `حاليًا في ${escapeHTML(account.current.channelName)} · ${account.current.selfMute ? 'Mute' : 'Unmute'}${account.current.selfDeaf ? ' · Deafen' : ''}${account.current.selfVideo ? ' · Video' : ''}${account.current.selfStream ? ' · Stream' : ''}` : 'جاهز للدخول') : escapeHTML(account.reason)}</small></span><span class="target-status">${account.available ? 'متاح' : 'مستبعد'}</span></label>`).join('') : '<div class="task-empty">لا توجد حسابات متصلة</div>';
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
  updateQuickStateButtons();
}
async function syncSelectedAccountVoice() {
  const client = state.clients.find((item) => item.name === state.selectedAccount);
  const voice = client?.voice;
  if (!voice?.guildId || !voice.channelId) {
    state.selectedTarget = null;
    updateChannelSummary();
    updateQuickStateButtons();
    return;
  }
  if (!state.groups.some((group) => group.guildId === voice.guildId)) await loadGuilds();
  state.selectedGuildId = voice.guildId;
  renderServers();
  renderChannels();
  const value = `${voice.guildId}::${voice.channelId}`;
  if ([...$('#channelSelect').options].some((option) => option.value === value)) {
    $('#channelSelect').value = value;
    handleChannelChange();
  } else {
    state.selectedTarget = { guildId: voice.guildId, channelId: voice.channelId, guildName: voice.guildName || voice.guildId, channelName: voice.channelName || voice.channelId };
    updateChannelSummary();
  }
  updateQuickStateButtons();
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
    const failureDetails = failed.length ? ` ${failed.map((item) => `${item.name || 'token'}: ${item.error || 'فشل الاتصال'}`).join(' | ')}` : '';
    feedback('#bulkFeedback', `اكتمل الاتصال: ${result.summary.ok} نجح، ${result.summary.failed} فشل.${failureDetails}`, failed.length ? 'error' : 'success');
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
  const pager = $('#profilesPager');
  const pageSize = 5;
  const pages = Math.max(1, Math.ceil(clients.length / pageSize));
  state.profilesPage = Math.min(state.profilesPage, pages - 1);
  if (!clients.length) { list.innerHTML = '<div class="task-empty">لا توجد حسابات متصلة</div>'; if (pager) pager.hidden = true; return; }
  const visibleClients = clients.slice(state.profilesPage * pageSize, (state.profilesPage + 1) * pageSize);
  list.innerHTML = visibleClients.map((client) => {
    const voice = client.voice;
    const avatar = client.avatar ? `<img src="${escapeHTML(client.avatar)}" alt="" />` : escapeHTML((client.nickname || client.name || '?')[0].toUpperCase());
    const rotation = state.tasks.find((task) => task.type === 'rotation' && task.accounts?.includes(client.name));
    const stateCycle = state.tasks.find((task) => task.type === 'cycle' && task.accounts?.includes(client.name));
    const rotationResult = rotation?.accountStatus?.[client.name] || rotation?.lastResults?.find((item) => item.name === client.name);
    const stateResult = stateCycle?.accountStatus?.[client.name] || stateCycle?.lastResults?.find((item) => item.name === client.name);
    const rotationAlert = rotationResult?.ok === false ? `<span class="rotation-error">Rotation error: ${escapeHTML(rotationResult.error || 'failed')}</span>` : '';
    const stateAlert = stateResult?.ok === false ? `<span class="rotation-error">State error: ${escapeHTML(stateResult.error || 'failed')}</span>` : '';
    const rotationInfo = rotation ? `${rotationAlert}<span class="task-timer room-timer"><b>R</b><span>Rooms · <strong data-profile-rotation-countdown="${escapeHTML(rotation.id)}">${escapeHTML(taskCountdownLabel(rotation))}</strong></span></span><button type="button" class="rotation-info-button" data-rotation-info="${escapeHTML(rotation.id)}">${Math.round((rotation.intervalMs || 0) / 60000)} min</button>` : '';
    const stateInfo = stateCycle ? `${stateAlert}<span class="task-timer state-timer"><b>S</b><span>States · <strong data-profile-state-countdown="${escapeHTML(stateCycle.id)}">${escapeHTML(taskCountdownLabel(stateCycle))}</strong></span></span><button type="button" class="rotation-info-button" data-state-info="${escapeHTML(stateCycle.id)}">${Math.round((stateCycle.intervalMs || 0) / 60000)} min</button>` : '';
    const taskInfo = `${rotationInfo}${stateInfo}`;
    const voiceText = voice ? `<span class="profile-voice-destination"><span class="profile-guild-icon">${voice.guildIcon ? `<img src="${escapeHTML(voice.guildIcon)}" alt="" />` : '◆'}</span><span><small>Voice: ${escapeHTML(voice.channelName || voice.channelId)}</small><small>Server: ${escapeHTML(voice.guildName || voice.guildId)}</small></span></span>${taskInfo}` : `${taskInfo || 'Not in a room'}`;
    const flags = voice ? `${voice.selfMute ? 'Mute' : 'Unmute'}${voice.selfDeaf ? ' · Deafen' : ''}${voice.selfVideo ? ' · Video' : ''}${voice.selfStream ? ' · Stream' : ''}` : 'Offline'; const health = client.health || {}; const healthText = health.state === 'healthy' ? 'Healthy' : health.state === 'degraded' ? `Degraded${health.lastError ? ` · ${health.lastError}` : ''}` : `Token changed${health.lastError ? ` · ${health.lastError}` : ''}`;
    return `<div class="profile-row"><span class="profile-row-avatar">${avatar}</span><div class="profile-row-main"><strong>${escapeHTML(client.nickname || client.displayName || client.username || client.name)}</strong><small>${escapeHTML(client.name)} · ID: ${escapeHTML(client.id || '—')} · <span class="health-${escapeHTML(health.state || 'unknown')}">${escapeHTML(healthText)}</span></small></div><div class="profile-row-voice"><span class="profile-online"></span><strong>${voiceText}</strong><small>${flags}</small></div><button class="profile-leave" type="button" data-profile-leave="${escapeHTML(client.name)}" data-profile-guild="${escapeHTML(voice?.guildId || '')}" ${voice ? '' : 'disabled'}>Leave</button></div>`;
  }).join('');
  list.querySelectorAll('[data-profile-leave]').forEach((button) => button.addEventListener('click', () => quickLeave(button.dataset.profileLeave, button.dataset.profileGuild)));
  list.querySelectorAll('[data-rotation-info]').forEach((button) => button.addEventListener('click', () => showRotationDetails(button.dataset.rotationInfo)));
  list.querySelectorAll('[data-state-info]').forEach((button) => button.addEventListener('click', () => showStateDetails(button.dataset.stateInfo)));
  if (pager) { pager.hidden = clients.length <= pageSize; $('#profilesPageLabel').textContent = `Page ${state.profilesPage + 1} / ${pages}`; $('#profilesPrevButton').disabled = state.profilesPage === 0; $('#profilesNextButton').disabled = state.profilesPage >= pages - 1; }
  updateQuickStateButtons();
}
function showRotationDetails(id) { const task = state.tasks.find((item) => item.id === id); if (!task) return; const rooms = (task.channels || []).join(' · '); toast(`Rotation · every ${Math.round((task.intervalMs || 0) / 60000)} min · ${task.accounts?.length || 0} accounts · ${rooms}`, 'success'); }
function showStateDetails(id) { const task = state.tasks.find((item) => item.id === id); if (!task) return; toast(`States · every ${Math.round((task.intervalMs || 0) / 60000)} min · ${task.accounts?.length || 0} accounts · ${task.states?.length || 0} states`, 'success'); }

function openDisconnect() {
  const list = $('#disconnectAccountList');
  if (!state.clients.length) { toast('لا توجد حسابات متصلة لفصلها', 'error'); return; }
  list.innerHTML = state.clients.map((client) => `<label class="account-target disconnect-target"><input type="checkbox" value="${escapeHTML(client.name)}" checked /><span class="target-avatar">${client.avatar ? `<img src="${escapeHTML(client.avatar)}" alt="" />` : escapeHTML((client.nickname || client.name || '?')[0])}</span><span class="target-copy"><strong>${escapeHTML(client.nickname || client.displayName || client.username || client.name)}</strong><small>${escapeHTML(client.name)} · ID: ${escapeHTML(client.id || '—')}</small></span><span class="target-status">Connected</span></label>`).join('');
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
    if (!result.summary?.ok) throw new Error(result.results?.find((item) => item.skipped)?.reason || result.results?.find((item) => !item.ok)?.error || 'تعذر تحديث الحالة');
    updateQuickStateButtons();
    const failed = result.summary.failed || 0;
    const skipped = result.summary.skipped || 0;
    const message = failed ? `${next.label}: ${result.summary.ok} succeeded, ${failed} failed` : skipped ? `${next.label}: ${skipped} skipped because of Room Rotation` : next.label;
    feedback('#stateFeedback', message, failed ? 'error' : 'success'); addActivity('تحديث حالة صوتية', `${state.clients.find((client) => client.name === state.selectedAccount)?.nickname || state.selectedAccount} · ${message}`, failed ? 'error' : 'success', state.selectedAccount); toast(message, failed ? 'error' : 'success'); await refreshSessions();
  } catch (error) { feedback('#stateFeedback', error.message, 'error'); toast(error.message, 'error'); } finally { buttons.forEach((button) => { button.disabled = false; button.classList.remove('is-pending'); }); updateQuickStateButtons(); }
}

function formatDuration(seconds) { return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }
function renderSessions(sessions = []) {
  const query = state.overviewFilter.trim().toLocaleLowerCase();
  const visibleSessions = sessions.map((session) => ({ ...session, displayName: accountNickname(session.name) })).filter((session) => !query || [session.name, session.guildName, session.channelName].some((value) => String(value || '').toLocaleLowerCase().includes(query))).sort((a,b) => { if (state.overviewSort === 'server') return String(a.guildName || '').localeCompare(String(b.guildName || '')); if (state.overviewSort === 'members') return Number(b.memberCount || 0) - Number(a.memberCount || 0); return String(a.name || '').localeCompare(String(b.name || '')); });
  $('#navSessionCount').textContent = String(sessions.length);
  const list = $('#sessionsList');
  const healthy = state.clients.filter((client) => client.health?.state === 'healthy').length; const degraded = state.clients.filter((client) => client.health?.state === 'degraded').length; const unknown = state.clients.length - healthy - degraded; $('#healthSummary').innerHTML = `<span class="health-pill healthy">${healthy} healthy</span><span class="health-pill degraded">${degraded} degraded</span><span class="health-pill">${unknown} unknown</span><span class="health-pill">${state.clients.length} total</span>`;
  if (!visibleSessions.length) {
    list.innerHTML = '<div class="empty-state"><span class="empty-pulse"></span><p>لا توجد جلسات نشطة الآن</p><small>عند الدخول إلى غرفة ستظهر تفاصيلها هنا.</small></div>';
    return;
  }
  list.innerHTML = visibleSessions.map((session) => `<div class="session-row"><span class="session-avatar">${session.guildIcon ? `<img src="${escapeHTML(session.guildIcon)}" alt="" />` : escapeHTML((session.guildName || '?')[0].toUpperCase())}</span><div class="session-info"><strong>${escapeHTML(session.displayName || session.name)}</strong><small>${escapeHTML(session.guildName || session.guildId)} · ${escapeHTML(session.channelName || session.channelId)} · ${Number(session.memberCount || 0)} متصل</small></div><div class="session-state">${session.selfMute ? 'Mute' : 'Unmute'}${session.selfDeaf ? ' · Deafen' : ''}${session.selfVideo ? ' · Video' : ''}${session.selfStream ? ' · Stream' : ''}</div><button class="session-leave" type="button" data-leave-name="${escapeHTML(session.name)}" data-leave-guild="${escapeHTML(session.guildId)}" title="خروج">×</button></div>`).join('');
  list.querySelectorAll('[data-leave-name]').forEach((button) => button.addEventListener('click', () => quickLeave(button.dataset.leaveName, button.dataset.leaveGuild)));
}
async function refreshSessions() {
  if (state.refreshPromise) return state.refreshPromise;
  state.refreshPromise = (async () => {
    try {
      const clients = await api('/api/discord/clients');
      state.clients = clients.clients || state.clients;
      renderProfiles(state.clients);
      renderPlayingAccounts();
      updatePlayingSelection();
      loadPlayingChannels();
      await syncSelectedAccountVoice();
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
    state.tasks = [...(rotations.rotations || []).map((task) => ({ ...task, type: 'rotation', title: 'تنقل بين القنوات' })), ...(cycles.cycles || []).map((task) => ({ ...task, type: 'cycle', title: 'تدوير الحالات' }))];
    renderTasks(state.tasks); renderProfiles(state.clients);
  } catch (error) { console.warn('[voice] tasks refresh failed', error); }
}
function taskTime(value) { if (!value) return 'غير متوفر'; try { return new Date(value).toLocaleString('ar-SA', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return 'غير متوفر'; } }
function taskStateLabel(state = {}) { return [['selfMute', 'Mute'], ['selfDeaf', 'Deafen'], ['selfVideo', 'Camera'], ['selfStream', 'Stream']].filter(([key]) => state[key]).map(([, label]) => label).join(' · ') || 'Voice on'; }
function taskChannelName(task, channelId) { return task.channels?.includes(channelId) ? `Room ${task.channels.indexOf(channelId) + 1} · ${channelId}` : (channelId || 'غير محدد'); }
function openTaskDetails(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  const modal = $('#taskDetailsModal');
  modal.dataset.taskId = taskId;
  modal.dataset.taskType = task.type;
  const cycleState = task.type === 'cycle' ? (task.states?.[task.currentIdx] || {}) : null;
  const currentRoom = task.type === 'rotation' ? task.channels?.[task.currentIdx % (task.channels?.length || 1)] : null;
  $('#taskDetailsTitle').textContent = task.title;
  $('#taskDetailsSubtitle').textContent = `${task.guildName || task.guildId} · ${task.accounts?.length || 0} حساب`;
  $('#taskDetailsSummary').innerHTML = `<div><span>السيرفر</span><strong>${escapeHTML(task.guildName || task.guildId || 'غير محدد')}</strong></div><div><span>بدأت</span><strong>${escapeHTML(taskTime(task.startedAt))}</strong></div><div><span>الفترة</span><strong>${escapeHTML(`${Math.round((task.intervalMs || 0) / 60000)} دقيقة`)}</strong></div><div><span>التنفيذ التالي</span><strong>${escapeHTML(taskTime(task.nextAt))}</strong></div><div><span>الحالة الحالية</span><strong>${escapeHTML(task.type === 'cycle' ? taskStateLabel(cycleState) : taskChannelName(task, currentRoom))}</strong></div><div><span>التسلسل</span><strong>${escapeHTML(task.type === 'rotation' ? (task.randomOrder ? 'عشوائي' : 'تسلسلي') : `${task.states?.length || 0} حالات`)}</strong></div>`;
  $('#taskDetailsCycle').innerHTML = task.type === 'cycle' ? `<div class="task-cycle-head"><div><span class="task-details-kicker">ROTATION CYCLE</span><strong>الحالات المختارة والجدول</strong></div><small>كل حالة تتنفذ حسب الفترة المحددة</small></div><div class="task-cycle-states">${(task.states || []).map((state, index) => { const count = task.states.length || 1; const distance = (index - ((task.currentIdx + 1) % count) + count) % count; const when = Number(task.nextAt || Date.now()) + distance * Number(task.intervalMs || 0); return `<div class="task-cycle-state ${index === task.currentIdx ? 'is-current' : ''}"><span class="task-cycle-index">${index + 1}</span><div><strong>${escapeHTML(taskStateLabel(state))}</strong><small>${index === task.currentIdx ? 'الحالة الحالية' : `التنفيذ المتوقع: ${taskTime(when)}`}</small></div><time>${escapeHTML(taskTime(when))}</time></div>`; }).join('')}</div>` : '';
  $('#taskDetailsAccounts').innerHTML = (task.accounts || []).map((name) => {
    const client = state.clients.find((item) => item.name === name);
    const voice = client?.voice;
    const result = (task.lastResults || []).find((item) => item.name === name);
    const liveState = voice ? taskStateLabel(voice) : 'ليس داخل روم';
    const detail = task.type === 'rotation' ? `${voice?.channelName || voice?.channelId || 'لا يوجد روم'} · الحالة: ${liveState}` : `الحالة الحالية: ${liveState} · الهدف: ${taskStateLabel(cycleState)}`;
    return `<div class="task-detail-account"><div class="task-detail-account-main"><span class="task-detail-avatar">${escapeHTML((name || '?')[0])}</span><div><strong>${escapeHTML(client?.nickname || client?.displayName || client?.username || name)}</strong><small>${escapeHTML(name)}</small></div></div><div class="task-detail-account-state"><span>${escapeHTML(detail)}</span><small class="${result?.ok === false ? 'is-error' : 'is-ok'}">${result?.ok === false ? escapeHTML(result.error || 'فشل آخر تنفيذ') : 'آخر تنفيذ ناجح أو قيد المتابعة'}</small></div></div>`;
  }).join('') || '<div class="task-empty">لا توجد حسابات في هذه المهمة</div>';
  modal.hidden = false;
}
async function openTaskAccounts(taskId) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) return;
  const modal = $('#taskAccountsModal');
  const list = $('#taskAccountsList');
  modal.dataset.taskId = taskId;
  modal.dataset.taskType = task.type;
  list.innerHTML = '<div class="task-empty">جاري فحص الحسابات المتاحة…</div>';
  modal.hidden = false;
  try {
    const data = await api(`/api/voice/task/candidates?type=${encodeURIComponent(task.type)}&id=${encodeURIComponent(taskId)}`);
    const candidates = data.candidates || [];
    list.innerHTML = candidates.length ? candidates.map((item) => {
      const client = state.clients.find((entry) => entry.name === item.name);
      const label = client?.nickname || item.name;
      return `<label class="task-add-account ${item.available ? '' : 'is-disabled'}"><input type="checkbox" value="${escapeHTML(item.name)}" ${item.available ? '' : 'disabled'} /><span class="task-add-account-copy"><strong>${escapeHTML(label)}</strong><small>${escapeHTML(item.available ? item.name : item.reason || 'غير متاح')}</small></span></label>`;
    }).join('') : '<div class="task-empty">لا توجد حسابات متاحة خارج هذه الجلسة</div>';
  } catch (error) {
    list.innerHTML = `<div class="task-empty">${escapeHTML(error.message || 'تعذر فحص الحسابات')}</div>`;
  }
}
async function confirmTaskAccounts() {
  const modal = $('#taskAccountsModal');
  const accounts = [...modal.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
  if (!accounts.length) { toast('اختر حسابًا واحدًا على الأقل', 'error'); return; }
  const button = $('#taskAccountsConfirm'); button.disabled = true;
  try {
    const result = await post('/api/voice/task/add-accounts', { id: modal.dataset.taskId, type: modal.dataset.taskType, accounts });
    modal.hidden = true;
    toast(result.message || `تمت إضافة ${accounts.length} حساب`, 'success');
    addActivity('إضافة حسابات إلى مهمة', `${accounts.length} حساب`, 'success');
    await loadTasks();
    openTaskDetails(modal.dataset.taskId);
  } catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = false; }
}
function taskRemaining(task) { return Math.max(0, Math.ceil((Number(task.nextAt || 0) - Date.now()) / 1000)); }
function taskCountdownLabel(task) { const seconds = taskRemaining(task); return formatDuration(seconds); }
function taskLiveSummary(task) { const results = task.accounts || []; const statuses = results.map((name) => task.accountStatus?.[name] || (task.lastResults || []).find((item) => item.name === name)); const failed = statuses.filter((item) => item?.ok === false).length; const passed = statuses.filter((item) => item?.ok === true).length; return `${passed}/${results.length} نجح · ${failed} خطأ` ; }
function renderTasks(tasks) {
  const list = $('#tasksList');
  if (!list) return;
  if (!tasks.length) { list.innerHTML = '<div class="task-empty">لا توجد مهام قيد التشغيل</div>'; return; }
  list.innerHTML = tasks.map((task) => { const names = (task.accounts || []).map((name) => accountNickname(name)).join('، '); const failed = (task.accounts || []).filter((name) => (task.accountStatus?.[name] || (task.lastResults || []).find((item) => item.name === name))?.ok === false).length; return `<div class="task-row ${failed ? 'has-task-errors' : ''}"><div class="task-row-copy"><strong>${escapeHTML(task.title)} ${failed ? `<em class="task-error-badge">${failed} خطأ</em>` : ''}</strong><small>${escapeHTML(names || `${task.accounts?.length || 0} حساب`)} · كل ${Math.round((task.intervalMs || 0) / 60000)} دقيقة · <span data-task-countdown="${escapeHTML(task.id)}">${escapeHTML(taskCountdownLabel(task))}</span> · <span data-task-summary="${escapeHTML(task.id)}">${escapeHTML(taskLiveSummary(task))}</span></small></div><button type="button" class="task-details-button" data-task-details="${escapeHTML(task.id)}">عرض التفاصيل</button><button type="button" class="task-add-button" data-task-add="${escapeHTML(task.id)}">إضافة حسابات</button><button type="button" class="task-stop" data-task-type="${task.type}" data-task-id="${escapeHTML(task.id)}">إيقاف</button></div>`; }).join('');
  list.querySelectorAll('[data-task-details]').forEach((button) => button.addEventListener('click', () => openTaskDetails(button.dataset.taskDetails)));
  list.querySelectorAll('[data-task-add]').forEach((button) => button.addEventListener('click', () => openTaskAccounts(button.dataset.taskAdd)));
  list.querySelectorAll('.task-stop').forEach((button) => button.addEventListener('click', () => stopTask(button.dataset.taskType, button.dataset.taskId)));
}
function refreshTaskCountdowns() { state.tasks.forEach((task) => { const countdown = document.querySelector(`[data-task-countdown="${CSS.escape(task.id)}"]`); if (countdown) countdown.textContent = taskCountdownLabel(task); const selector = task.type === 'cycle' ? '[data-profile-state-countdown]' : '[data-profile-rotation-countdown]'; document.querySelectorAll(`${selector}[data-profile-${task.type === 'cycle' ? 'state' : 'rotation'}-countdown="${CSS.escape(task.id)}"]`).forEach((item) => { item.textContent = taskCountdownLabel(task); }); const summary = document.querySelector(`[data-task-summary="${CSS.escape(task.id)}"]`); if (summary) summary.textContent = taskLiveSummary(task); }); }
$('#taskDetailsClose')?.addEventListener('click', () => { $('#taskDetailsModal').hidden = true; });
$('#taskDetailsModal')?.addEventListener('click', (event) => { if (event.target.id === 'taskDetailsModal') event.currentTarget.hidden = true; });
$('#taskAddAccountsButton')?.addEventListener('click', () => { const taskId = $('#taskDetailsModal').dataset.taskId; if (taskId) openTaskAccounts(taskId); });
$('#taskAccountsClose')?.addEventListener('click', () => { $('#taskAccountsModal').hidden = true; });
$('#taskAccountsCancel')?.addEventListener('click', () => { $('#taskAccountsModal').hidden = true; });
$('#taskAccountsConfirm')?.addEventListener('click', confirmTaskAccounts);
$('#taskAccountsModal')?.addEventListener('click', (event) => { if (event.target.id === 'taskAccountsModal') event.currentTarget.hidden = true; });
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
async function applyBulkState() { const accounts = selectedAutomationAccounts(); const guildId = $('#automationGuild')?.value || ''; const kind = $('#bulkStateTemplate')?.value || 'unmute'; const stateMap = { unmute: { selfMute: false, selfDeaf: false, selfVideo: false, selfStream: false }, mute: { selfMute: true, selfDeaf: false, selfVideo: false, selfStream: false }, deaf: { selfMute: true, selfDeaf: true, selfVideo: false, selfStream: false }, cam: { selfMute: false, selfDeaf: false, selfVideo: true, selfStream: false }, stream: { selfMute: false, selfDeaf: false, selfVideo: false, selfStream: true } }; if (!accounts.length || !guildId) { toast('اختر الحسابات والسيرفر أولًا من Automation', 'error'); return; } try { const result = await post('/api/voice/state', { accounts, guildId, ...stateMap[kind] }); const failed = result.summary?.failed || 0; const skipped = result.summary?.skipped || 0; toast(`${result.summary?.ok || 0} succeeded · ${skipped} skipped${failed ? ` · ${failed} failed` : ''}`, failed ? 'error' : 'success'); await refreshSessions(); } catch (error) { toast(error.message, 'error'); } }
async function startRotation() {
  if (!state.clients.length) { toast('اتصل بحساب واحد على الأقل أولًا', 'error'); return; }
  const accounts = selectedAutomationAccounts();
  const guildId = $('#automationGuild').value;
  const channelIds = selectedRotationChannels();
  if (accounts.length < 1) { toast('اختر حسابًا واحدًا على الأقل للمهمة', 'error'); return; }
  if (!guildId) { toast('اختر السيرفر الذي ستعمل عليه المهمة', 'error'); return; }
  if (channelIds.length < 2) { toast('حدد رومتين على الأقل للتنقل بينهما', 'error'); return; }
  const guild = state.allGroups.find((group) => group.guildId === guildId);
  const intervalMs = Math.max(1, Number($('#rotationMinutes').value || 5)) * 60000;
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
  const intervalMs = Math.max(1, Number($('#stateCycleMinutes').value || 5)) * 60000;
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
function clearActivity() { if (!JSON.parse(localStorage.getItem('voice-activity') || '[]').length) return; if (!window.confirm('Clear the full activity log?')) return; localStorage.removeItem('voice-activity'); const list = $('#activityList'); if (list) list.innerHTML = '<div class="activity-row"><span class="activity-dot"></span><div><strong>Workspace ready</strong><small>بانتظار أول اتصال</small></div><time>الآن</time></div>'; if (!$('#activityModal').hidden) renderFullActivity(0); toast('Activity log cleared', 'success'); }
function initActivity() { $('#activityExpandButton')?.addEventListener('click', () => { const filter = $('#activityAccountFilter'); filter.innerHTML = '<option value="">All accounts</option>' + state.clients.map((client) => `<option value="${escapeHTML(client.name)}">${escapeHTML(client.nickname || client.displayName || client.username || client.name)}</option>`).join(''); $('#activityModal').hidden = false; renderFullActivity(0); }); $('#activityAccountFilter')?.addEventListener('change', () => renderFullActivity(0)); $('#activityClearButton')?.addEventListener('click', clearActivity); $('#activityClearModalButton')?.addEventListener('click', clearActivity); const closeActivity = () => { $('#activityModal').hidden = true; }; $('#activityCloseButton')?.addEventListener('click', closeActivity); $('#activityCloseTopButton')?.addEventListener('click', closeActivity); $('#activityModal')?.addEventListener('click', (event) => { if (event.target.id === 'activityModal') closeActivity(); }); $('#activityPrevButton')?.addEventListener('click', () => renderFullActivity(state.activityPage - 1)); $('#activityNextButton')?.addEventListener('click', () => renderFullActivity(state.activityPage + 1)); }
function openLeaveAll() { const active = state.clients.filter((client) => client.voice); const list = $('#leaveAccountList'); list.innerHTML = active.length ? active.map((client) => `<label class="account-target"><input type="checkbox" value="${escapeHTML(client.name)}" data-leave-guild="${escapeHTML(client.voice.guildId)}" checked /><span class="target-avatar">${client.avatar ? `<img src="${escapeHTML(client.avatar)}" alt="" />` : escapeHTML((client.nickname || '?')[0])}</span><span class="target-copy"><strong>${escapeHTML(client.nickname || client.displayName || client.username || client.name)}</strong><small>${escapeHTML(client.name)} · ${escapeHTML(client.voice.guildName || client.voice.guildId)} · ${escapeHTML(client.voice.channelName || client.voice.channelId)}</small></span></label>`).join('') : '<div class="task-empty">No connected account is currently in voice</div>'; $('#leaveModal').hidden = false; }
async function leaveAllSelected() { const selected = [...document.querySelectorAll('#leaveAccountList input:checked')].map((input) => ({ name: input.value, guildId: input.dataset.leaveGuild })); if (!selected.length) { toast('اختر حسابًا واحدًا على الأقل', 'error'); return; } const groups = new Map(); selected.forEach((item) => { if (!groups.has(item.guildId)) groups.set(item.guildId, []); groups.get(item.guildId).push(item.name); }); $('#leaveModal').hidden = true; try { for (const [guildId, accounts] of groups) await post('/api/voice/leave', { accounts, guildId });   addActivity('خروج جماعي', `${selected.length} حساب`, 'success'); toast(`تم إخراج ${selected.length} حساب`, 'success'); await refreshSessions(); } catch (error) { toast(error.message, 'error'); } }
function scheduleLiveRefresh() { clearTimeout(state.liveRefreshTimer); state.liveRefreshTimer = setTimeout(() => refreshSessions().catch(() => {}), 180); }
function connectLiveEvents() { if (!window.EventSource || state.liveEvents) return; const events = new EventSource('/api/events'); state.liveEvents = events; events.onmessage = (message) => { try { const event = JSON.parse(message.data); if (event.type === 'task.account.updated') { const task = state.tasks.find((item) => item.id === event.id); if (task && event.result) { task.accountStatus = { ...(task.accountStatus || {}), [event.result.name]: event.result }; task.lastResults = [...(task.lastResults || []).filter((item) => item.name !== event.result.name), event.result]; task.nextAt = event.nextAt || task.nextAt; task.currentIdx = event.currentIdx ?? task.currentIdx; renderTasks(state.tasks); if (!$('#taskDetailsModal')?.hidden && $('#taskDetailsTitle')?.textContent) openTaskDetails(task.id); } } if (event.type === 'task.completed') { const task = state.tasks.find((item) => item.id === event.id); if (task) { task.nextAt = event.nextAt || task.nextAt; task.currentIdx = event.currentIdx ?? task.currentIdx; renderTasks(state.tasks); } } if (event.type === 'operation.completed' && event.summary?.failed) toast(`${event.operation}: ${event.summary.failed} failed`, 'error'); if (event.type?.startsWith('playing.')) { loadPlayingSessions(); if (document.querySelector('[data-playing-pane="activity"]')?.classList.contains('is-active')) loadPlayingEvents(); } scheduleLiveRefresh(); } catch {} }; events.onerror = () => { events.close(); state.liveEvents = null; setTimeout(connectLiveEvents, 5000); }; }
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
  initTheme(); initLanguage(); initNavigation(); initActivity(); initPlaying(); initCustomSelects();
  $('#profilesPrevButton')?.addEventListener('click', () => { state.profilesPage -= 1; renderProfiles(state.clients); });
  $('#profilesNextButton')?.addEventListener('click', () => { state.profilesPage += 1; renderProfiles(state.clients); });
  $('#serverSelect')?.addEventListener('change', (event) => { state.selectedGuildId = event.target.value; state.selectedTarget = null; renderChannels(); }); $('#roomSearch')?.addEventListener('input', () => { state.selectedTarget = null; renderChannels(); });
  $('#connectButton').addEventListener('click', connect); $('#bulkConnectButton').addEventListener('click', bulkConnect); $('#disconnectButton').addEventListener('click', openDisconnect); $('#accountSelect').addEventListener('change', async (event) => { state.selectedAccount = event.target.value; await loadGuilds(); await loadAutomationCatalog(); }); $('#automationGuild').addEventListener('change', renderAutomationChannels); $('#automationChannel').addEventListener('change', renderTargetAccounts); $('#rotationRoomFilter').addEventListener('input', (event) => { state.rotationRoomFilter = event.target.value; state.rotationRoomPage = 0; renderRotationRooms(); }); $('#rotationPrevButton').addEventListener('click', () => { state.rotationRoomPage -= 1; renderRotationRooms(); }); $('#rotationNextButton').addEventListener('click', () => { state.rotationRoomPage += 1; renderRotationRooms(); }); $('#bulkJoinButton').addEventListener('click', bulkJoinSelected); $('#channelSelect').addEventListener('change', handleChannelChange); $('#joinButton').addEventListener('click', join); $('#joinAllButton').addEventListener('click', joinAll); $('#leaveButton').addEventListener('click', leave); $('#cameraButton')?.addEventListener('click', toggleCamera); $('#screenButton')?.addEventListener('click', toggleScreen); $('#startRotationButton').addEventListener('click', startRotation); $('#startCycleButton').addEventListener('click', startCycle); $('#stopMediaButton')?.addEventListener('click', () => stopCurrentStream()); $('#applyBulkStateButton')?.addEventListener('click', applyBulkState); $('#overviewFilter')?.addEventListener('input', (event) => { state.overviewFilter = event.target.value; refreshSessions(); }); $('#overviewSort')?.addEventListener('change', (event) => { state.overviewSort = event.target.value; refreshSessions(); }); document.querySelectorAll('.state-button').forEach((button) => button.addEventListener('click', () => applyState(button.dataset.state))); document.querySelectorAll('#statePicker input').forEach((input) => input.addEventListener('change', () => input.closest('.state-option')?.classList.toggle('is-selected', input.checked)));
  $('#operationClose').addEventListener('click', () => { $('#operationModal').hidden = true; $('.operation-loader')?.classList.remove('is-done', 'is-error'); }); $('#leaveAllButton')?.addEventListener('click', openLeaveAll); $('#confirmLeaveButton')?.addEventListener('click', leaveAllSelected); $('#cancelLeaveButton')?.addEventListener('click', () => { $('#leaveModal').hidden = true; }); $('#confirmDisconnectButton')?.addEventListener('click', disconnectSelected); $('#cancelDisconnectButton')?.addEventListener('click', () => { $('#disconnectModal').hidden = true; }); $('#disconnectModalClose')?.addEventListener('click', () => { $('#disconnectModal').hidden = true; }); window.addEventListener('beforeunload', () => stopCurrentStream({ updateDiscord: false }));
  document.addEventListener('change', (event) => { if (event.target.closest('#automationAccounts')) updateQuickStateButtons(); });
  loadClients().then(() => renderPlayingAccounts()).catch(() => {}); refreshSessions(); loadTasks(); loadPlayingSessions(); connectLiveEvents(); state.taskCountdownTimer = setInterval(refreshTaskCountdowns, 1000); setInterval(refreshSessions, 15000); setInterval(loadTasks, 15000); setInterval(loadPlayingSessions, 15000);
}
init();
