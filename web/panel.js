'use strict';

const $ = (id) => document.getElementById(id);
const views = ['routes', 'setup', 'events'];
const state = {
  view: 'routes', online: false, status: null, entries: [],
  groupOptions: [], setupConfig: null, excludeDirty: false,
  detailDomain: null, detailNodeDirty: false,
};
let refreshing;
let loadingSetup;
let lastRows;
let lastEvents;
let toastTimer;

function setText(id, value) {
  const element = $(id);
  const next = String(value ?? '');
  if (element.textContent !== next) element.textContent = next;
}

function setDisabled(id, disabled) {
  const element = $(id);
  element.disabled = Boolean(disabled || element.dataset.busy);
}

function note(id, message, tone = 'neutral') {
  setText(id, message);
  $(id).dataset.tone = tone;
  $(id).hidden = !message;
}

function notify(message, tone = 'good', area = null) {
  const dialog = area?.closest('dialog') || document.querySelector('dialog[open]');
  if (dialog?.open) {
    let report = dialog.querySelector('.dialog-message');
    if (!report) {
      report = document.createElement('p');
      report.className = 'dialog-message';
      report.setAttribute('role', 'status');
      dialog.querySelector('.dialog-body').prepend(report);
    }
    report.dataset.tone = tone;
    report.textContent = message;
    return;
  }
  note('toast', message, tone);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500);
}

async function request(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(method === 'GET' ? 13000 : 180000),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || ('请求失败（HTTP ' + response.status + '）'));
  }
  return response;
}

async function api(path, method, body) {
  return (await request(path, method, body)).json();
}

async function act(button, work, errorLabel) {
  if (button.dataset.busy) return;
  button.dataset.busy = 'true';
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  const dialog = button.closest('dialog');
  dialog?.querySelector('.dialog-message')?.remove();
  try {
    await work();
  } catch (err) {
    notify(errorLabel + '：' + err.message, 'bad', button);
  } finally {
    delete button.dataset.busy;
    button.removeAttribute('aria-busy');
    button.disabled = false;
    renderControls();
  }
}

function chinaDirectStatus(s) {
  const loaded = s.chinaRules || [];
  if (!s.directChina) return loaded.length ? '大陆直连规则仍在运行。重写脚本并重新应用订阅后关闭。' : '';
  if (loaded.length === 2) return '识别到的中国大陆域名和 IP 走直连。';
  if (loaded.length === 1) {
    const kind = loaded[0] === 'domain' ? '域名' : 'IP';
    return '大陆直连当前仅按' + kind + '识别。补齐 Clash 的 GEO 数据后可重新写入脚本。';
  }
  return '大陆直连规则未加载。确认 Clash 的 GEO 数据可用后，重写脚本并重新应用订阅。';
}

function presentation(s) {
  if (!s) return ['neutral', '正在连接面板', '正在读取本机服务状态。'];
  if (!state.online) return ['bad', '本机面板连接中断', '请确认 Clash AutoRoute 正在运行，再刷新状态。'];
  if (!s.controllerOk) return ['bad', '等待 Clash 内核', '先打开 Clash Verge Rev 并应用当前订阅，再刷新状态。'];
  if (!s.scriptFileInstalled && s.scriptActive) {
    return ['warn', '移除后待重新应用', '内核还在使用之前的扩展脚本。请在 Clash Verge Rev 重新应用当前订阅。'];
  }
  if (!s.scriptFileInstalled) return ['warn', '等待接入 Clash Verge', '在接入设置中选择目标代理组，写入全局扩展脚本。'];
  if (!s.scriptActive || !s.scriptMatches) {
    return ['warn', '脚本已写入，待应用', '回到 Clash Verge Rev 重新应用当前订阅，再点「检查接入状态」。'];
  }
  if (s.scriptGroup && s.scriptGroup !== s.targetGroup) {
    return ['warn', '目标代理组有变更', '请在接入设置中为新代理组写入脚本，然后重新应用当前订阅。'];
  }
  if (s.mode !== 'rule') {
    return ['warn', '等待规则模式', '请确认 Clash Verge Rev 的代理模式为「规则」，然后刷新状态。'];
  }
  if (!s.fallbackRuleActive) {
    return ['warn', '兜底规则未接入', '请检查订阅扩展里的最后兜底规则，重新应用订阅后再检查。'];
  }
  if (s.ruleError) return ['bad', '规则集同步失败', s.ruleError + '。服务会自动重试。'];
  if (s.ruleSyncing) return ['neutral', '正在同步规则集', '同步完成后面板会自动更新状态。'];
  if (s.paused) return ['warn', '自动分配已暂停', '走到兜底的新域名使用原出口。已下发的规则继续匹配。'];
  if (s.fallbackNow !== 'AutoRoute-Hook') {
    const headline = s.fallbackNow ? 'Clash 目前选用原兜底出口。' : '还未读到 Clash 兜底组当前选择。';
    return ['warn', '等待自动分配接管', headline + '请刷新状态，或等待 Clash 完成下一次健康检查。'];
  }
  if (!s.nodes.some((node) => node.name === 'DIRECT')) {
    return ['good', '自动分配就绪', '直连尚未加入测速。请确认节点端口有空余，并重写扩展脚本、重新应用订阅。'];
  }
  const direct = chinaDirectStatus(s);
  return ['good', '自动分配就绪', direct || '访问一个会落到原兜底规则的新网站，测速成功后就能在下面看到域名和出口。'];
}

function checkedStep(id, textId, label, tone, index) {
  $(id).dataset.tone = tone;
  setText(id, tone === 'good' ? '✓' : index);
  setText(textId, label);
}

function renderStatus() {
  const s = state.status;
  const [tone, title, description] = presentation(s);
  $('route-light').dataset.tone = tone;
  setText('route-state', title);
  setText('route-note', description);
  $('route-next').firstChild.nodeValue = tone === 'good' ? '查看接入设置 ' : '前往接入设置 ';
  note('setup-status', title, tone);
  if (!s) {
    if (state.offline) setText('route-state', '等待本机服务');
    return;
  }
  const coreTone = !state.online ? 'neutral' : !s.controllerOk ? 'bad' : s.mode === 'rule' ? 'good' : 'warn';
  const core = !state.online ? '状态未知' : !s.controllerOk ? '未连接' : s.mode === 'rule' ? '规则模式' : '待确认规则模式';
  checkedStep('core-step', 'core-state', core, coreTone, '1');
  let script = s.scriptFileInstalled ? '已写入，待应用' : '未写入';
  if (s.scriptMatches) script = '已加载';
  if (!s.scriptFileInstalled && s.scriptActive) script = '待卸载';
  if (s.scriptFileInstalled && !s.controllerOk) script = '已写入，待检查';
  if (!state.online) script = '未同步';
  const scriptTone = !state.online || !s.controllerOk ? 'neutral' : s.scriptMatches ? 'good' : 'warn';
  checkedStep('script-step', 'script-state', script, scriptTone, '2');
  checkedStep('hook-step', 'hook-state', tone === 'good' ? '已开启' : s.paused && state.online ? '已暂停' : '待就绪', tone, '3');
  note('install-state', script, scriptTone);
  setText('pause', s.paused ? '恢复自动分配' : '暂停自动分配');

  setText('total', s.counts.total);
  setText('total-note', '自动 ' + s.counts.auto + ' / 已锁定 ' + s.counts.locked);
  setText('group', s.targetGroup || '未选择');
  $('group').title = s.targetGroup || '';
  const visibleGroup = s.scriptGroup && s.scriptGroup !== s.targetGroup ? '已写入 ' + s.scriptGroup : '';
  const candidates = s.nodes.length + ' 个测速候选' + (s.nodes.some((node) => node.name === 'DIRECT') ? '，含直连' : '');
  setText('group-note', visibleGroup || (s.controllerOk && s.scriptMatches ? candidates : '等待脚本生效'));
  if (s.fallbackTarget) setText('fallback', s.fallbackTarget);
  else setText('fallback', '待接入');
  $('fallback').title = s.fallbackTarget || '';
  setText('hooked', s.stats.hooked);
  setText('hooked-note', '新分配 ' + s.stats.assigned + ' / 回退 ' + s.stats.fallback);
  setText('export-count', s.counts.lockedForExport);
  $('lock-all').title = s.counts.lockable ? '可锁定 ' + s.counts.lockable + ' 条自动记录' : '暂无可锁定的自动记录';
  if (!$('autostart').dataset.busy) $('autostart').checked = s.autostart;
}

function outletName(name) {
  return name === 'DIRECT' ? 'DIRECT（直连）' : name;
}

function selectOptions(element, items, placeholder, selected = element.value) {
  const key = JSON.stringify([items, placeholder]);
  if (element.dataset.options !== key) {
    const options = placeholder === null ? [] : [new Option(placeholder, '')];
    for (const item of items) {
      const option = new Option(item.label || outletName(item.name), item.name);
      option.disabled = Boolean(item.disabled);
      options.push(option);
    }
    element.replaceChildren(...options);
    element.dataset.options = key;
  }
  const match = Array.from(element.options).some((option) => option.value === selected && !option.disabled);
  if (element.value !== selected || !match) element.value = match ? selected : '';
}

function entryEditable() {
  const s = state.status;
  return Boolean(state.online && s?.controllerOk && s.scriptMatches && s.nodes.length);
}

function renderControls() {
  const s = state.status;
  const canEdit = entryEditable();
  setDisabled('pause', !state.online || !s || (!s.scriptActive && !s.paused));
  setDisabled('open-add', !canEdit);
  $('open-add').title = canEdit ? '' : '接入 Clash Verge 后可手动添加域名';
  for (const id of ['open-export', 'save-export', 'download']) setDisabled(id, !state.online);
  setDisabled('lock-all', !canEdit || !s?.counts.lockable);
  setDisabled('target-group', Boolean(loadingSetup) || !state.groupOptions.length);
  const selection = state.groupOptions.find((g) => g.name === $('target-group').value);
  setDisabled('install', !state.online || !selection || selection.disabled || Boolean(loadingSetup) || $('uninstall').dataset.busy);
  setDisabled('reload-groups', Boolean(loadingSetup));
  setDisabled('exclude', !state.online || !state.setupConfig);
  setDisabled('save-exclude', !state.online || !state.setupConfig);
  setDisabled('autostart', !state.online);
  setDisabled('uninstall', !state.online || !s?.scriptFileInstalled || $('install').dataset.busy);
  setDisabled('add-node', !canEdit);
  setDisabled('add-submit', !canEdit || !$('add-node').value);
  updateDetailControls();
}

function render() {
  renderStatus();
  const names = new Set(state.status?.nodes.map((node) => node.name) || []);
  for (const entry of state.entries) names.add(entry.node);
  selectOptions($('filter-node'), [...names].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((name) => ({ name })), '全部出口');
  if ($('add-dialog').open) selectOptions($('add-node'), state.status?.nodes || [], '选择出口');
  if (state.view === 'routes') renderEntries();
  if (state.view === 'events') renderEvents();
  renderDetail();
  renderControls();
}

function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const [status, entries] = await Promise.all([api('/api/status'), api('/api/entries')]);
      state.online = true;
      state.offline = false;
      state.status = status;
      state.entries = entries;
      note('connection-alert', '');
    } catch {
      state.online = false;
      state.offline = true;
      note('connection-alert', state.status
        ? '本机服务暂时无法连接，下方记录来自上次同步。'
        : '本机服务暂时无法连接。请启动 Clash AutoRoute，然后刷新状态。');
    }
    render();
  })().finally(() => { refreshing = null; });
  return refreshing;
}

async function refreshAfterAction() {
  if (refreshing) await refreshing;
  await refresh();
  if (state.view === 'routes') renderEntries(true);
}

function showView(focus = false) {
  const hash = location.hash.slice(1);
  const view = views.includes(hash) ? hash : 'routes';
  state.view = view;
  for (const section of views) $(section).hidden = section !== view;
  for (const link of document.querySelectorAll('nav a')) {
    if (link.hash === '#' + view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (view === 'setup') loadSetup();
  render();
  if (focus) {
    $(view + '-title').focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
}

function escapeText(value) {
  const chars = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, (char) => chars[char]);
}

function relativeTime(timestamp) {
  if (!timestamp) return '暂无活跃记录';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' 小时前';
  return Math.floor(seconds / 86400) + ' 天前';
}

function entryTag(entry) {
  if (entry.excluded) return { tone: 'neutral', label: '已排除' };
  if (state.status?.controllerOk && state.status.scriptActive && !entry.valid) return { tone: 'bad', label: '节点失效' };
  if (entry.state === 'locked') return { tone: 'lock', label: '已锁定' };
  return { tone: 'good', label: '自动' };
}

function entryRow(entry) {
  const domain = escapeText(entry.domain);
  const node = escapeText(outletName(entry.node));
  const tag = entryTag(entry);
  const locked = entry.state === 'locked';
  const hits = Number.isFinite(entry.hits) ? entry.hits : 0;
  const noteText = entry.excluded || !entry.valid ? '保存的出口' : '命中 ' + hits + ' 次';
  const delay = Number.isFinite(entry.delay)
    ? entry.delay + ' <span>ms</span>'
    : '<span>' + (entry.testedAt ? '未测通' : '未测速') + '</span>';
  const lockDisabled = !state.online || (!locked && (!entry.valid || entry.excluded));
  return '<tr role="row" data-domain="' + domain + '">'
    + '<td role="cell"><span class="domain">' + domain + '</span><span class="row-note">' + relativeTime(entry.lastSeen) + '</span></td>'
    + '<td role="cell" data-label="出口">' + node + '<span class="row-note">' + noteText + '</span></td>'
    + '<td role="cell" class="latency" data-label="最近延迟">' + delay + '</td>'
    + '<td role="cell"><span class="tag" data-tone="' + tag.tone + '">' + tag.label + '</span></td>'
    + '<td role="cell" class="end"><div class="row-actions">'
    + '<button class="secondary" data-entry-action="lock" type="button"' + (lockDisabled ? ' disabled' : '') + '>'
    + (locked ? '解锁' : '锁定') + '</button><button class="secondary" data-entry-action="detail" type="button">详情</button>'
    + '</div></td></tr>';
}

function renderEntries(force = false) {
  const table = $('entries');
  if (!force && table.querySelector('[aria-busy="true"]')) return;
  const search = $('search').value.trim().toLowerCase();
  const filter = $('filter-state').value;
  const node = $('filter-node').value;
  const filtered = Boolean(search || filter || node);
  const visible = state.entries.filter((entry) => {
    if (node && entry.node !== node) return false;
    if (search && !entry.domain.toLowerCase().includes(search) && !outletName(entry.node).toLowerCase().includes(search)) return false;
    if (filter === 'excluded') return entry.excluded;
    if (filter === 'invalid') return entryTag(entry).label === '节点失效';
    return !filter || entry.state === filter;
  }).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0) || a.domain.localeCompare(b.domain));
  setText('visible-count', state.status ? visible.length + ' 条记录' : '—');
  $('table-region').hidden = !visible.length;
  $('empty').hidden = Boolean(visible.length);
  $('clear-filters').hidden = !filtered;
  if (!visible.length) {
    if (filtered) {
      setText('empty-title', '没有符合条件的域名');
      setText('empty-note', '试试清除筛选，或搜索主域名的一部分。');
    } else if (!entryEditable()) {
      setText('empty-title', state.offline ? '等待本机服务' : '尚无域名记录');
      setText('empty-note', '完成接入后，访问一个会走原兜底规则的网站。');
    } else {
      setText('empty-title', '等待第一条分配');
      setText('empty-note', '通过 Clash 访问一个未被原有规则覆盖的网站，或手动添加域名并锁定出口。');
    }
  }

  const html = visible.map(entryRow).join('');
  if (html === lastRows) return;
  const focused = table.contains(document.activeElement) ? document.activeElement : null;
  const domain = focused?.closest('tr')?.dataset.domain;
  const action = focused?.dataset.entryAction;
  table.innerHTML = html;
  lastRows = html;
  if (domain && action) {
    const row = Array.from(table.rows).find((tr) => tr.dataset.domain === domain);
    (row?.querySelector('[data-entry-action="' + action + '"]:not(:disabled)') || $('search')).focus({ preventScroll: true });
  }
}

function renderEvents() {
  const types = {
    assign: ['新分配', 'good'], switch: ['更换出口', 'good'], fail: ['测速失败', 'warn'], manual: ['指定出口', 'lock'],
    lock: ['锁定', 'lock'], unlock: ['解锁', 'neutral'], stale: ['出口失效', 'warn'], delete: ['删除', 'neutral'],
    pause: ['暂停', 'warn'], resume: ['恢复', 'good'], script: ['扩展脚本', 'neutral'],
    config: ['设置', 'neutral'], export: ['导出', 'neutral'], expire: ['清理', 'neutral'],
  };
  const events = state.status?.events || [];
  const html = events.map((event) => {
    const [label, tone] = types[event.type] || ['事件', 'neutral'];
    const stamp = new Date(event.t);
    return '<li><time datetime="' + stamp.toISOString() + '">'
      + stamp.toLocaleTimeString('zh-CN', { hour12: false }) + '</time><span class="tag" data-tone="' + tone + '">'
      + label + '</span><span>' + escapeText(event.msg) + '</span></li>';
  }).join('');
  if (html !== lastEvents) {
    $('event-list').innerHTML = html;
    lastEvents = html;
  }
  $('event-empty').hidden = Boolean(events.length);
  setText('event-count', events.length + ' 条');
}

async function loadSetup() {
  if (loadingSetup) return loadingSetup;
  const previouslySelected = $('target-group').value;
  loadingSetup = (async () => {
    const [groups, config, script] = await Promise.allSettled([
      api('/api/groups'), api('/api/config'), api('/api/verge-script'),
    ]);

    if (config.status === 'fulfilled') {
      state.setupConfig = config.value;
      if (!state.excludeDirty) $('exclude').value = (config.value.exclude || []).join(', ');
    }
    if (script.status === 'fulfilled') {
      setText('script-path', script.value.file);
      setText('script-preview', script.value.block);
    } else {
      setText('script-path', '读取脚本失败：' + script.reason.message);
    }
    if (groups.status === 'fulfilled') {
      const range = state.setupConfig?.listenerRange ?? Infinity;
      state.groupOptions = groups.value.map((group) => {
        const usable = group.candidateCount > 0 && group.candidateCount <= range;
        const label = usable ? group.name + '（' + group.candidateCount + ' 个候选）'
          : group.name + (group.candidateCount ? '（可用端口不足）' : '（无可用显式成员）');
        return { ...group, label, disabled: !usable };
      });
      const saved = state.setupConfig?.targetGroup || '';
      selectOptions($('target-group'), state.groupOptions, '选择代理组', previouslySelected || saved);
      const available = state.groupOptions.filter((group) => !group.disabled).length;
      note('group-help', available ? available + ' 个代理组可用于自动分配。'
        : '没有可选代理组。请在 Clash 中应用含显式代理成员的订阅后重新读取。', available ? 'neutral' : 'warn');
    } else {
      state.groupOptions = [];
      selectOptions($('target-group'), [], '未读取到代理组');
      note('group-help', '读取失败：' + groups.reason.message, 'bad');
    }
  })().finally(() => {
    loadingSetup = null;
    renderControls();
  });
  renderControls();
  return loadingSetup;
}

function openDialog(id) {
  $('toast').hidden = true;
  const dialog = $(id);
  dialog.querySelector('.dialog-message')?.remove();
  dialog.showModal();
}

function selectedEntry() {
  return state.entries.find((entry) => entry.domain === state.detailDomain);
}

function updateDetailControls() {
  if (!$('detail-dialog').open) return;
  const entry = selectedEntry();
  const canEdit = entryEditable() && Boolean(entry && !entry.excluded);
  setDisabled('detail-node', !canEdit);
  setDisabled('save-node', !canEdit || !$('detail-node').value || $('detail-node').value === entry?.node);
  setDisabled('retest', !canEdit);
  setDisabled('delete', !state.online || !entry);
  setDisabled('detail-lock', !state.online || !entry || (entry.state !== 'locked' && (!entry.valid || entry.excluded)));
}

function renderDetail() {
  if (!$('detail-dialog').open) return;
  const entry = selectedEntry();
  if (!entry) {
    setText('detail-note', '这条域名记录已删除。');
    $('delay-list').replaceChildren();
    $('node-form').hidden = true;
    return;
  }
  $('node-form').hidden = false;
  const label = entryTag(entry).label;
  setText('detail-title', entry.domain);
  setText('detail-note', (entry.excluded || !entry.valid ? '保存的出口 ' : '当前出口 ') + outletName(entry.node) + ' / ' + label);
  setText('detail-lock', entry.state === 'locked' ? '解锁出口' : '锁定出口');
  const selected = state.detailNodeDirty ? $('detail-node').value : entry.node;
  selectOptions($('detail-node'), state.status?.nodes || [], '选择出口', selected);
  const delays = Object.entries(entry.delays || {})
    .sort((a, b) => (a[1] ?? Infinity) - (b[1] ?? Infinity));
  const probe = entry.sampleHost || entry.domain;
  if (delays.length) {
    const lastTest = new Date(entry.testedAt).toLocaleString('zh-CN', { hour12: false });
    setText('probe-note', '测试主机 ' + probe + ' / ' + lastTest);
  } else {
    setText('probe-note', '点击「重新测速」比较各出口和直连的延迟。');
  }

  const html = delays.map(([node, delay]) => {
    const current = node === entry.node;
    return '<li' + (current ? ' class="current"' : '') + '><span>' + escapeText(outletName(node))
      + (current ? ' <small>已选</small>' : '') + '</span><span class="latency">'
      + (Number.isFinite(delay) ? delay + ' <span>ms</span>' : '<span>未测通</span>') + '</span></li>';
  }).join('');
  if ($('delay-list').dataset.values !== html) {
    $('delay-list').innerHTML = html;
    $('delay-list').dataset.values = html;
  }
}

function endpoint(domain, action = '') {
  return '/api/entries/' + encodeURIComponent(domain) + (action ? '/' + action : '');
}

async function changeLock(entry, button) {
  if (!entry) return;
  const unlocking = entry.state === 'locked';
  await act(button, async () => {
    await api(endpoint(entry.domain, unlocking ? 'unlock' : 'lock'), 'POST');
    await refreshAfterAction();
    notify((unlocking ? '已解锁 ' : '已锁定 ') + entry.domain);
  }, unlocking ? '解锁失败' : '锁定失败');
}

async function checkConnection(button, inSetup = false) {
  await act(button, async () => {
    const status = await api('/api/refresh', 'POST');
    await refreshAfterAction();
    if (inSetup) {
      const [tone, title, detail] = presentation(status);
      note('check-feedback', title + '。' + detail, tone);
      if (!state.groupOptions.length && status.controllerOk) await loadSetup();
    } else {
      const [tone, title] = presentation(status);
      notify(title, tone);
    }
  }, '检查失败');
}

$('refresh').addEventListener('click', () => checkConnection($('refresh'), state.view === 'setup'));
$('check-setup').addEventListener('click', () => checkConnection($('check-setup'), true));
$('reload-groups').addEventListener('click', loadSetup);
$('target-group').addEventListener('change', () => {
  note('install-feedback', '');
  note('check-feedback', '');
  renderControls();
});
$('install').addEventListener('click', (event) => act(event.currentTarget, async () => {
  const targetGroup = $('target-group').value;
  await api('/api/verge-script/install', 'POST', { targetGroup });
  note('install-feedback', '已写入并备份原脚本。接下来完成第 3 步。', 'good');
  note('check-feedback', '');
  await Promise.all([loadSetup(), refreshAfterAction()]);
}, '写入脚本失败'));
$('uninstall').addEventListener('click', (event) => {
  if (!window.confirm('移除 AutoRoute 的全局扩展脚本？请在完成后重新应用当前订阅。')) return;
  act(event.currentTarget, async () => {
    await api('/api/verge-script/uninstall', 'POST');
    await Promise.all([loadSetup(), refreshAfterAction()]);
    note('install-feedback', '');
    note('check-feedback', '脚本已移除，请在 Clash Verge Rev 重新应用当前配置。', 'warn');
    notify('扩展脚本已移除');
  }, '移除脚本失败');
});
$('exclude').addEventListener('input', () => { state.excludeDirty = true; });
$('exclude-form').addEventListener('submit', (event) => {
  event.preventDefault();
  act($('save-exclude'), async () => {
    const original = $('exclude').value;
    const exclude = original.split(/[,，\n]+/).map((value) => value.trim()).filter(Boolean);
    const config = await api('/api/config', 'POST', { exclude });
    state.setupConfig = config;
    if ($('exclude').value === original) {
      state.excludeDirty = false;
      $('exclude').value = config.exclude.join(', ');
    }
    await refreshAfterAction();
    notify('已保存排除列表');
  }, '保存排除列表失败');
});
$('autostart').addEventListener('change', (event) => {
  const box = event.currentTarget;
  const enable = box.checked;
  act(box, async () => {
    try {
      await api('/api/autostart', 'POST', { enable });
    } finally {
      await refreshAfterAction();
      box.checked = Boolean(state.status?.autostart);
    }
    notify(enable ? '已开启开机自启' : '已关闭开机自启');
  }, '修改开机自启失败');
});
$('pause').addEventListener('click', (event) => act(event.currentTarget, async () => {
  const paused = Boolean(state.status?.paused);
  await api(paused ? '/api/resume' : '/api/pause', 'POST');
  await refreshAfterAction();
  notify(paused ? '已恢复自动分配' : '已暂停自动分配');
}, '修改自动分配状态失败'));

$('search').addEventListener('input', () => renderEntries(true));
for (const id of ['filter-state', 'filter-node']) $(id).addEventListener('change', () => renderEntries(true));
$('clear-filters').addEventListener('click', () => {
  for (const id of ['search', 'filter-state', 'filter-node']) $(id).value = '';
  renderEntries(true);
  $('search').focus();
});
$('entries').addEventListener('click', (event) => {
  const button = event.target.closest('[data-entry-action]');
  if (!button) return;
  const domain = button.closest('tr').dataset.domain;
  const entry = state.entries.find((item) => item.domain === domain);
  if (!entry) return;
  if (button.dataset.entryAction === 'lock') {
    changeLock(entry, button);
  } else {
    state.detailDomain = entry.domain;
    state.detailNodeDirty = false;
    setText('detail-title', entry.domain);
    openDialog('detail-dialog');
    renderDetail();
    renderControls();
  }
});
$('open-add').addEventListener('click', () => {
  selectOptions($('add-node'), state.status?.nodes || [], '选择出口', '');
  openDialog('add-dialog');
  $('add-domain').focus();
  renderControls();
});
$('add-node').addEventListener('change', renderControls);
$('add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  act($('add-submit'), async () => {
    const domain = $('add-domain').value.trim();
    const node = $('add-node').value;
    const entry = await api('/api/entries', 'POST', { domain, node, lock: true });
    $('add-dialog').close();
    $('add-form').reset();
    await refreshAfterAction();
    notify('已添加并锁定 ' + entry.domain);
  }, '添加域名失败');
});
$('detail-node').addEventListener('change', () => {
  state.detailNodeDirty = true;
  updateDetailControls();
});
$('node-form').addEventListener('submit', (event) => {
  event.preventDefault();
  act($('save-node'), async () => {
    const domain = state.detailDomain;
    const node = $('detail-node').value;
    await api(endpoint(domain, 'node'), 'POST', { node, lock: true });
    state.detailNodeDirty = false;
    await refreshAfterAction();
    notify('已切换并锁定到 ' + node);
  }, '切换出口失败');
});
$('detail-lock').addEventListener('click', (event) => changeLock(selectedEntry(), event.currentTarget));
$('retest').addEventListener('click', (event) => {
  const button = event.currentTarget;
  const domain = state.detailDomain;
  act(button, async () => {
    button.textContent = '测速中…';
    try {
      const entry = await api(endpoint(domain, 'retest'), 'POST');
      await refreshAfterAction();
      const reachable = Object.values(entry.delays || {}).some((delay) => Number.isFinite(delay));
      notify(reachable ? '测速结果已更新' : '候选出口均未测通，保留原出口。', reachable ? 'good' : 'bad', button);
    } finally {
      button.textContent = '重新测速';
    }
  }, '重新测速失败');
});
$('delete').addEventListener('click', (event) => {
  const domain = state.detailDomain;
  if (!window.confirm('删除 ' + domain + ' 的 AutoRoute 记录？下次满足分配条件时会重新测速。')) return;
  act(event.currentTarget, async () => {
    await api(endpoint(domain), 'DELETE');
    $('detail-dialog').close();
    await refreshAfterAction();
    notify('已删除 ' + domain);
  }, '删除记录失败');
});

$('open-export').addEventListener('click', () => {
  note('export-feedback', '');
  openDialog('export-dialog');
  renderControls();
});
$('lock-all').addEventListener('click', (event) => {
  const count = state.status?.counts.lockable || 0;
  if (!count || !window.confirm('锁定 ' + count + ' 条可用自动记录？这些记录将进入导出范围。')) return;
  act(event.currentTarget, async () => {
    const result = await api('/api/lock-all', 'POST');
    await refreshAfterAction();
    note('export-feedback', '已锁定 ' + result.locked + ' 条记录。', 'good');
  }, '批量锁定失败');
});
$('save-export').addEventListener('click', (event) => act(event.currentTarget, async () => {
  const result = await api('/api/export/save', 'POST');
  const skipped = result.counts.skipped ? '，跳过 ' + result.counts.skipped + ' 条锁定记录' : '';
  const counts = '原有 ' + result.counts.original + ' 条，锁定 ' + result.counts.locked + ' 条' + skipped + '。';
  note('export-feedback', counts + '已保存到 ' + result.path, 'good');
}, '导出失败'));
$('download').addEventListener('click', (event) => act(event.currentTarget, async () => {
  const response = await request('/api/export');
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = 'autoroute-rules.yaml';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  const skipped = Number(response.headers.get('X-Autoroute-Skipped'));
  const message = '已下载规则' + (skipped ? '，跳过 ' + skipped + ' 条锁定记录' : '') + '。';
  note('export-feedback', message, 'good');
}, '下载规则失败'));

for (const close of document.querySelectorAll('[data-close]')) {
  close.addEventListener('click', () => close.closest('dialog').close());
}
addEventListener('hashchange', () => showView(true));
showView();
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
