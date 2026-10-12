/* 学期助手：原生 fetch + Supabase Auth/REST，无第三方运行库。 */
(() => {
  'use strict';
  const URL = 'https://ukdemzhiatgcrbmstyjv.supabase.co';
  const PUBLIC_KEY = 'sb_publishable_4hax2b3VARTLTtJqN5dAyQ_tOf_7Y2w';
  const STORE = 'semester-helper-cloud-v1';
  const AUTH = 'semester-helper-auth-v1';
  const BACKUP = 'semester-helper-before-sync-v1';
  const LEGACY = 'semester-helper-v1';
  const clone = value => JSON.parse(JSON.stringify(value));
  // Postgres jsonb 会调整对象键的顺序，比较内容时必须忽略键顺序。
  const stable = value => JSON.stringify(value, function (_key, v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]]));
    }
    return v;
  });
  const same = (a, b) => stable(a) === stable(b);
  let state, stamp = null, session = null, bridge, busy = false, authBusy = false;
  let remote, needsChoice = false, timer, status = '本地模式 · 登录后可同步', generation = 0;
  let ready = false, storageBroken = false;

  function validateData(d) {
    const date = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
      Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
    const safeId = s => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(s);
    const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    const record = x => {
      if (!x || typeof x !== 'object' || Array.isArray(x) || !safeId(x.id)) throw Error('事项 ID 无效，请使用英文、数字、短横线或下划线');
      for (const k of ['date', 'deadline', 'scheduledDate', 'weekStart', 'completedAt']) {
        if (x[k] && !date(x[k])) throw Error('事项日期无效：' + k);
      }
      for (const k of ['time', 'startTime', 'endTime']) {
        if (x[k] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(x[k])) throw Error('时间格式应为 HH:mm');
      }
      for (const k of ['title','name','category','location','priority','note']) {
        if (x[k] != null && typeof x[k] !== 'string') throw Error('文字字段无效：' + k);
      }
      if (x.duration != null && !number(x.duration)) throw Error('预计时长无效');
      if (x.done != null && typeof x.done !== 'boolean') throw Error('完成状态应为 true 或 false');
      if (x.weeks != null && (!Array.isArray(x.weeks) || x.weeks.some(w => !Number.isInteger(w) || w < 1 || w > 52))) throw Error('课程周次无效');
    };
    if (!d || d.schemaVersion !== 1 || !d.term || !date(d.term.startDate) ||
      !Number.isInteger(d.term.weeks) || d.term.weeks < 1 || d.term.weeks > 52) throw Error('学期数据格式无效');
    for (const k of ['courses','weekly','tasks','projects','projectLogs','milestones']) {
      if (!Array.isArray(d[k])) throw Error('数据缺少 ' + k);
      d[k].forEach(record);
    }
    if (d.courses.some(c => !Number.isInteger(c.day) || c.day < 1 || c.day > 7)) throw Error('课程星期无效');
    for (const k of ['daily','history']) {
      if (!d[k] || typeof d[k] !== 'object' || Array.isArray(d[k])) throw Error('数据缺少 ' + k);
      Object.entries(d[k]).forEach(([day, rows]) => {
        if (!date(day) || !Array.isArray(rows)) throw Error('每日记录格式无效');
        rows.forEach(record);
      });
    }
    if (!d.lab || ['total','booked','completed','reports'].some(k => !number(d.lab[k]))) throw Error('实验数据无效');
    return d;
  }

  function read() {
    try {
      stamp = localStorage.getItem(STORE);
      state = stamp ? JSON.parse(stamp) : {owner: null, revision: null, base: null, data: null, dirty: false};
      session = JSON.parse(localStorage.getItem(AUTH) || 'null');
      const data = state.data || JSON.parse(localStorage.getItem(LEGACY) || 'null');
      if (data) validateData(data);
      return data;
    } catch (e) {
      storageBroken = true;
      alert('本地数据读取失败，已暂停保存，避免覆盖原记录。请先下载原始数据或联系协助。\n' + e.message);
      return null;
    }
  }

  function write(next) {
    if (storageBroken) throw Error('本地存储不可用，未保存');
    if (localStorage.getItem(STORE) !== stamp) throw Error('另一个标签页已更新数据，请刷新此页面后再操作');
    const raw = JSON.stringify(next);
    localStorage.setItem(STORE, raw); // 数据和同步版本一次写入，失败时保留旧状态。
    state = next;
    stamp = raw;
  }

  function save(data) {
    try {
      validateData(data);
      const next = {...state, data: clone(data), dirty: !same(data, state.base)};
      write(next);
      if (ready) {
        setStatus(needsChoice ? '两份计划等待选择 · 本机修改已保存' : session ? '已保存在本机 · 等待同步' : '已保存在本机 · 未登录');
        schedule();
      }
    } catch (e) {
      // 保留未能写入的版本，用户可通过“下载当前备份”导出内存中的计划。
      setStatus('保存失败：' + e.message + '；请立即下载当前备份');
      alert('保存失败：' + e.message + '。请先下载当前备份。');
      throw e;
    }
  }

  function backup(data, reason) {
    localStorage.setItem(BACKUP, JSON.stringify({app:'semester-helper',schemaVersion:1,
      exportedAt:new Date().toISOString(), reason, data}));
  }

  function setStatus(message) {
    status = message;
    const badge = document.getElementById('cloudBadge');
    if (badge) badge.textContent = message;
    const text = document.getElementById('cloudStatus');
    if (text) text.textContent = message;
  }

  function errorText(e) {
    if (e.status === 401 || e.status === 400 && /refresh|token/i.test(e.message)) return '登录已过期，请退出后重新登录；本机计划已保留';
    if (e.status === 404 || /PGRST202|PGRST205|42P01/.test(e.code || '')) return '云端尚未初始化：请先运行 supabase-setup.sql';
    if (/Invalid login credentials/i.test(e.message)) return '邮箱或密码不正确，请使用 Authentication → Users 中创建的账号';
    if (/Email not confirmed/i.test(e.message)) return '邮箱尚未确认，请在 Supabase 用户管理中确认账号';
    if (e.name === 'AbortError' || e instanceof TypeError) return '网络连接失败，修改保存在本机，联网后重试';
    return e.message || '连接失败，请重试';
  }

  async function request(path, {method = 'GET', body, token} = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(URL + path, {
        method, signal: controller.signal, cache:'no-store',
        headers: {apikey:PUBLIC_KEY, 'Content-Type':'application/json', ...(token ? {Authorization:'Bearer ' + token} : {})},
        ...(body !== undefined ? {body:JSON.stringify(body)} : {})
      });
      const raw = await response.text();
      let value;
      try { value = raw ? JSON.parse(raw) : null; } catch { throw Error('云服务返回了无法识别的内容'); }
      if (!response.ok) {
        const e = Error(value?.msg || value?.error_description || value?.message || '请求失败');
        e.status = response.status; e.code = value?.code; throw e;
      }
      return value;
    } finally { clearTimeout(timeout); }
  }

  function saveSession(value) {
    if (!value?.access_token || !value?.refresh_token || !value?.user?.id) throw Error('登录响应无效');
    const next = {access_token:value.access_token, refresh_token:value.refresh_token,
      expires_at:value.expires_at || Math.floor(Date.now()/1000) + value.expires_in,
      user:{id:value.user.id,email:value.user.email}};
    localStorage.setItem(AUTH, JSON.stringify(next));
    session = next;
  }

  async function token() {
    // 同一浏览器多个标签页共享最新的续期令牌。
    const saved = JSON.parse(localStorage.getItem(AUTH) || 'null');
    if (!saved || saved.user.id !== session?.user.id) throw Error('登录状态已改变，请刷新页面');
    session = saved;
    if (session.expires_at * 1000 < Date.now() + 60000) {
      const value = await request('/auth/v1/token?grant_type=refresh_token', {
        method:'POST', body:{refresh_token:session.refresh_token}
      });
      saveSession(value);
    }
    return session.access_token;
  }

  function summary(data) {
    if (!data) return '还没有云端计划';
    return `课程 ${data.courses.length} · 任务 ${data.tasks.length} · 临时事项 ${data.weekly.length + Object.values(data.daily).reduce((n,a)=>n+a.length,0)} · 打卡 ${data.projectLogs.length} · 节点 ${data.milestones.length}`;
  }

  function showChoice(row) {
    remote = row; needsChoice = true;
    setStatus(state.revision === null ? '首次连接：请在设置中选择数据来源' : '两端都有修改：请在设置中处理冲突');
    draw();
  }

  function install(row, reason) {
    validateData(row.data);
    backup(state.data, reason);
    write({...state, data:clone(row.data), base:clone(row.data), revision:row.revision,
      owner:session.user.id, dirty:false, pending:null});
    bridge.setData(clone(state.data));
    needsChoice = false; remote = undefined;
    setStatus('已同步 · ' + new Date().toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'}));
    draw();
  }

  function acknowledge(row) {
    write({...state, base:clone(row.data), revision:row.revision, owner:session.user.id,
      dirty:!same(state.data, row.data), pending:null});
  }

  async function getRemote(access) {
    const rows = await request('/rest/v1/semester_sync?select=data,revision,updated_at&user_id=eq.' + encodeURIComponent(session.user.id), {token:access});
    if (!Array.isArray(rows) || rows.length > 1) throw Error('云端响应格式无效');
    const row = rows[0] || null;
    if (row) {
      validateData(row.data);
      if (!Number.isSafeInteger(row.revision) || row.revision < 1) throw Error('云端版本号无效');
    }
    return row;
  }

  async function push(access) {
    const started = generation;
    const snapshot = clone(state.data), expected = state.revision || 0;
    write({...state, pending:{data:snapshot, expected}});
    const result = await request('/rest/v1/rpc/semester_save', {method:'POST',token:access,
      body:{p_data:snapshot,p_expected_revision:expected}});
    if (started !== generation) throw Error('登录状态已改变，上传结果将在下次登录时核对');
    if (!Number.isSafeInteger(result?.revision) || result.revision !== expected + 1) throw Error('云端写入响应无效');
    // 请求期间可能又编辑了数据：只确认上传的快照，继续保留新修改。
    acknowledge({data:snapshot,revision:result.revision});
  }

  async function cycle(force = false) {
    if (!session || storageBroken || !ready || busy || authBusy || needsChoice) return;
    if (!navigator.onLine) { setStatus('离线 · 修改保存在本机'); return; }
    if (!force && document.visibilityState === 'hidden') return;
    if (bridge.isEditing()) { setStatus('正在编辑 · 完成后同步'); return; }
    busy = true;
    const started = generation;
    const run = async () => {
      // 别的标签在等待锁时可能已修改本地状态；让 storage 事件完成刷新。
      if (localStorage.getItem(STORE) !== stamp) throw Error('另一个标签页已更新数据，请刷新后同步');
      const access = await token();
      if (started !== generation) return;
      if (state.owner && state.owner !== session.user.id) throw Error('本机数据属于另一账号，请使用原账号登录');
      setStatus('正在同步…');
      const row = await getRemote(access);
      if (started !== generation) return;
      if (bridge.isEditing()) { setStatus('正在编辑 · 完成后同步'); return; }
      if (state.revision === null) { showChoice(row); return; }
      // 上次请求可能已在云端成功，但响应丢失；识别快照后恢复确认状态。
      if (row && state.pending && same(row.data,state.pending.data) && row.revision === state.pending.expected + 1) acknowledge(row);
      if (row && same(row.data,state.data)) {
        acknowledge(row);
      } else if (!state.dirty && row) {
        install(row, '拉取云端前');
      } else if ((row?.revision || 0) !== state.revision) {
        showChoice(row); return;
      } else if (state.dirty) {
        await push(access);
      }
      setStatus(state.dirty ? '新修改已保存在本机 · 等待同步' : '已同步 · ' + new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}));
    };
    try {
      if (navigator.locks) await navigator.locks.request('semester-cloud-sync', run);
      else await run();
    } catch (e) {
      setStatus(e.status === 409 ? '云端刚有更新，正在重新检查…' : errorText(e));
      if (e.status === 409) schedule(100);
    } finally { busy = false; draw(); }
  }

  function schedule(delay = 900) {
    clearTimeout(timer);
    timer = setTimeout(() => cycle(), delay);
  }

  async function login(event) {
    event.preventDefault();
    if (busy || authBusy) return;
    authBusy = true;
    const email = document.getElementById('cloudEmail').value.trim();
    const passwordInput = document.getElementById('cloudPassword');
    const password = passwordInput.value;
    passwordInput.value = '';
    setStatus('正在登录…');
    document.getElementById('cloudLogin').disabled = true;
    try {
      const value = await request('/auth/v1/token?grant_type=password', {method:'POST',body:{email,password}});
      if (state.owner && state.owner !== value.user?.id) throw Error('本机计划已绑定另一账号，请使用原账号登录');
      saveSession(value); generation++;
      setStatus('登录成功 · 正在检查云端');
    } catch (e) { setStatus(errorText(e)); }
    finally { authBusy = false; draw(); }
    if (session) await cycle(true);
  }

  async function logout() {
    if (busy || authBusy) { setStatus('正在处理同步，请稍后退出'); return; }
    // 本机待上传数据保留，下一次同账号登录继续同步。
    authBusy = true;
    const old = session;
    localStorage.removeItem(AUTH); session = null; generation++;
    needsChoice = false; remote = undefined; clearTimeout(timer);
    setStatus('已退出 · 本机计划保留'); draw();
    try { if (old) await request('/auth/v1/logout?scope=local', {method:'POST',token:old.access_token}); }
    catch { /* 本机令牌已删除；离线时服务器会话按过期时间失效。 */ }
    finally { authBusy = false; draw(); }
  }

  async function choose(which) {
    if (busy || authBusy || !needsChoice) return;
    if (which === 'remote' && !remote) return;
    const message = which === 'local' ?
      '将以本机整份计划作为云端版本。云端原版本会先保存在本机备份中；其他设备联网后会接收此版本。继续？' :
      '将使用云端整份计划。本机原版本会保存在切换前备份中。继续？';
    if (!confirm(message)) return;
    busy = true;
    const started = generation;
    const selected = remote;
    try {
      const run = async () => {
        const access = await token();
        if (started !== generation) return;
        const latest = await getRemote(access);
        if (started !== generation) return;
        if ((selected?.revision || 0) !== (latest?.revision || 0)) { showChoice(latest); return; }
        if (which === 'remote') {
          install(latest, '选择云端版本前');
        } else {
          backup(latest?.data || state.data, latest ? '选择本机版本前的云端备份' : '首次上传前');
          write({...state,owner:session.user.id,revision:latest?.revision || 0,base:latest?.data || null,dirty:true});
          await push(access);
          needsChoice = false; remote = undefined;
          setStatus(state.dirty ? '新修改等待同步' : '已同步 · 本机计划已上传');
        }
      };
      if (navigator.locks) await navigator.locks.request('semester-cloud-sync',run); else await run();
    } catch (e) {
      needsChoice = false;
      setStatus(errorText(e)); schedule();
    } finally { busy = false; draw(); }
  }

  function downloadData(data, name) {
    const body = {app:'semester-helper',schemaVersion:1,exportedAt:new Date().toISOString(),data};
    const url = window.URL.createObjectURL(new Blob([JSON.stringify(body,null,2)],{type:'application/json'}));
    const a = document.createElement('a'); a.href = url; a.download = name + '.json'; a.click();
    setTimeout(() => window.URL.revokeObjectURL(url), 1000);
  }

  function downloadPrevious() {
    const raw = localStorage.getItem(BACKUP);
    if (!raw) { setStatus('还没有切换前备份'); return; }
    downloadData(JSON.parse(raw).data, '学期助手-切换前备份');
  }

  function draw() {
    const card = document.getElementById('cloudCard');
    if (!card || authBusy && !session) return;
    // 保留正在输入的登录邮箱和密码。
    const email = document.getElementById('cloudEmail')?.value || '';
    const password = document.getElementById('cloudPassword')?.value || '';
    card.innerHTML = '<h3>电脑与手机同步</h3><p id="cloudStatus" class="notice" role="status"></p>' + (session ?
      '<p id="cloudUser" class="sub"></p><div class="row"><button class="btn primary" id="cloudNow">立即同步</button><button class="btn" id="cloudLogout">退出登录</button></div>' :
      '<form id="cloudForm"><div class="fields"><label class="field">学习账号邮箱<input id="cloudEmail" type="email" autocomplete="username" required></label><label class="field">学习账号密码<input id="cloudPassword" type="password" autocomplete="current-password" required></label></div><button class="btn primary" id="cloudLogin" style="margin-top:10px">登录并同步</button><p class="sub">请先在 Supabase 的 Authentication → Users 创建学习账号。电脑和手机使用同一账号。</p></form>') +
      '<div id="cloudChoice" hidden class="notice warn" style="margin-top:12px"></div><div class="row" style="margin-top:12px"><button class="btn" id="cloudBackup">下载当前备份</button><button class="btn" id="cloudPrevious">下载切换前备份</button></div><p class="sub">登录后联网自动同步；离线修改先保存在本机。两端同时修改时会暂停并提示选择版本，不会自动覆盖。</p>';
    document.getElementById('cloudStatus').textContent = status;
    if (session) {
      document.getElementById('cloudUser').textContent = '已登录：' + session.user.email;
      document.getElementById('cloudNow').onclick = () => { if (needsChoice) draw(); else cycle(true); };
      document.getElementById('cloudLogout').onclick = logout;
      document.getElementById('cloudNow').disabled = busy;
      document.getElementById('cloudLogout').disabled = busy || authBusy;
    } else {
      document.getElementById('cloudEmail').value = email;
      document.getElementById('cloudPassword').value = password;
      document.getElementById('cloudForm').onsubmit = login;
    }
    if (needsChoice) {
      const choice = document.getElementById('cloudChoice'); choice.hidden = false;
      choice.innerHTML = '<b>请选择要继续使用的整份计划</b><p>本机：<span id="localSummary"></span></p><p>云端：<span id="remoteSummary"></span></p><p>两份计划不会自动合并。建议先分别下载备份，再选择版本。</p><div class="row"><button class="btn" id="useLocal">使用本机并上传</button><button class="btn" id="useRemote">使用云端</button><button class="btn" id="downloadRemote">下载云端备份</button></div>';
      document.getElementById('localSummary').textContent = summary(state.data);
      document.getElementById('remoteSummary').textContent = summary(remote?.data);
      document.getElementById('useLocal').onclick = () => choose('local');
      document.getElementById('useRemote').onclick = () => choose('remote');
      document.getElementById('useLocal').disabled = busy;
      document.getElementById('useRemote').disabled = busy || !remote;
      document.getElementById('downloadRemote').disabled = !remote;
      document.getElementById('downloadRemote').onclick = () => downloadData(remote.data,'学期助手-云端备份');
    }
    document.getElementById('cloudBackup').onclick = () => downloadData(bridge.getData(),'学期助手-本机备份');
    document.getElementById('cloudPrevious').onclick = downloadPrevious;
  }

  function init(adapter) {
    bridge = adapter; ready = true; draw();
    if (storageBroken) { setStatus('本地数据读取失败，保存与同步已暂停'); return; }
    if (session) schedule(0);
    window.addEventListener('online', () => schedule(0));
    window.addEventListener('offline', () => setStatus('离线 · 修改保存在本机'));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(0); });
    document.addEventListener('focusout', () => schedule());
    window.addEventListener('storage', event => {
      if (event.key === AUTH) {
        const next = JSON.parse(event.newValue || 'null');
        if (next?.user?.id !== session?.user?.id) generation++;
        session = next; needsChoice = false; draw(); schedule();
      } else if (event.key === STORE && !busy) {
        if (bridge.isEditing()) { setStatus('另一标签页有修改，请结束编辑并刷新；继续编辑前请备份'); return; }
        try {
          const next = JSON.parse(event.newValue); validateData(next.data);
          state = next; stamp = event.newValue; bridge.setData(clone(state.data)); draw(); schedule();
        } catch { setStatus('另一标签页数据更新失败，请下载当前备份'); }
      }
    });
    setInterval(() => cycle(), 20000);
  }

  window.CloudSync = {read,save,init,validateData};
})();
