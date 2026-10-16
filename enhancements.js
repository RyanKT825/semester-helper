/* 学期助手：未完成事项整理与本机图片课表识别。 */
(() => {
  const oldDayItems = dayItems;
  const oldWeekItems = weekItems;
  const oldEditItem = editItem;
  const oldDeleteFromDay = deleteFromDay;
  const oldToggleItem = toggleItem;
  const fixedPlan = x => x.fixed || x.category === '课程';
  let imageUrl = null;
  let toastTimer = null;

  toast = function (message) {
    const node = document.getElementById('toast');
    clearTimeout(toastTimer);
    node.textContent = message;
    node.style.display = 'block';
    node.onclick = null;
    node.style.cursor = '';
    toastTimer = setTimeout(() => { node.style.display = 'none'; node.onclick = null; }, 6500);
  }
  function beforeChange() { undoData = JSON.stringify(db); return undoData; }
  function finishChange(snapshot, message) {
    if (JSON.stringify(db) === snapshot) return toast('没有可处理的未完成事项');
    const prior = snapshot;
    undoData = prior;
    save();
    const after = JSON.stringify(db);
    render(); toast(message + ' · 点此撤销');
    const node = document.getElementById('toast');
    node.style.cursor = 'pointer';
    node.onclick = () => {
      if (undoData !== prior || JSON.stringify(db) !== after) return toast('之后已有新修改，无法撤销');
      db = JSON.parse(prior); undoData = null;
      save(); render(); toast('已撤销');
    };
  }

  dayItems = function (date) {
    return oldDayItems(date).map(x => x.kind === 'event' && fixedPlan(x) ? {...x, fixed:true} : x);
  };
  weekItems = function () {
    return oldWeekItems().map(x => x.kind !== 'task' && fixedPlan(x) ? {...x, fixed:true} : x);
  };
  drawToday = function () {
    document.getElementById('dayPicker').value = dayKey;
    document.getElementById('dayLabel').textContent = new Date(dayKey + 'T12:00:00').toLocaleDateString('zh-CN', {year:'numeric',month:'long',day:'numeric',weekday:'long'});
    const xs = dayItems(dayKey);
    const done = xs.filter(x => x.done).length;
    const rate = xs.length ? Math.round(done / xs.length * 100) : 0;
    document.getElementById('completion').textContent = rate + '%';
    document.getElementById('completionBar').style.width = rate + '%';
    document.getElementById('todayList').innerHTML = xs.length ? xs.map(x => {
      const ops = x.fixed ? '<span class="meta">固定课</span>' :
        `<button class="smallbtn" onclick="editItem('${x.kind}','${x.id}')">编辑</button>` +
        (!x.done ? `<button class="smallbtn" onclick="moveDayItem('${x.kind}','${x.id}','tomorrow')">顺延</button><button class="smallbtn" onclick="moveDayItem('${x.kind}','${x.id}','library')">退回</button>` : '') +
        `<button class="smallbtn" onclick="deleteFromDay('${x.kind}','${x.id}')">${x.kind === 'task' ? '移出' : '删除'}</button>`;
      return itemHtml({...x,title:x.title || x.name}, ops);
    }).join('') : '<div class="empty">这一天还没有安排。</div>';
  };
  function moveCore(kind, idv, action) {
    if (kind === 'course') return false;
    if (kind === 'task') {
      const t = db.tasks.find(x => x.id === idv);
      if (!t || t.done || t.scheduledDate !== dayKey) return false;
      t.scheduledDate = action === 'tomorrow' ? dateAdd(dayKey, 1) : null;
      if (action === 'library') t.time = '';
      return true;
    }
    const arr = kind === 'event' ? db.weekly : (db.daily[dayKey] || []);
    const at = arr.findIndex(x => x.id === idv);
    if (at < 0 || arr[at].done || fixedPlan(arr[at])) return false;
    const item = arr.splice(at, 1)[0];
    if (action === 'library') {
      const taskId = db.tasks.some(x => x.id === item.id) ? id() : item.id;
      db.tasks.push({id:taskId,title:item.title,category:item.category || '',duration:Number(item.duration) || 0,
        priority:item.priority || '',deadline:item.deadline || '',time:'',scheduledDate:null,done:false});
    } else {
      item.date = dateAdd(dayKey, 1);
      if (kind === 'event') {
        item.weekStart = monday(item.date);
        db.weekly.push(item);
      } else {
        (db.daily[item.date] = db.daily[item.date] || []).push(item);
      }
    }
    return true;
  }
  moveDayItem = function (kind, idv, action) {
    const snapshot = beforeChange();
    if (!moveCore(kind, idv, action)) return toast('已完成事项或固定课程不能移动');
    finishChange(snapshot, action === 'tomorrow' ? '已顺延到次日' : '已退回任务库');
  };
  resolveUnfinished = function (action) {
    const xs = dayItems(dayKey).filter(x => !x.done && !x.fixed);
    if (!xs.length) return toast('没有可处理的未完成事项');
    if (!confirm(`将 ${xs.length} 条未完成事项${action === 'tomorrow' ? '顺延到次日' : '退回任务库'}？固定课程和已完成记录会保留。`)) return;
    const snapshot = beforeChange();
    let count = 0;
    xs.forEach(x => { if (moveCore(x.kind, x.id, action)) count++; });
    finishChange(snapshot, `已处理 ${count} 条`);
  };
  resetToday = function () {
    const xs = dayItems(dayKey).filter(x => !x.done && !x.fixed);
    if (!xs.length) return toast('这一天没有可重置事项');
    if (!confirm(`重置所选日期的 ${xs.length} 条未完成事项？任务退回任务库，临时安排清除；固定课程、已完成记录、项目和节点保留。`)) return;
    const snapshot = beforeChange();
    db.daily[dayKey] = (db.daily[dayKey] || []).filter(x => x.done || fixedPlan(x));
    db.weekly = db.weekly.filter(x => x.date !== dayKey || x.done || fixedPlan(x));
    db.tasks.forEach(x => { if (x.scheduledDate === dayKey && !x.done) { x.scheduledDate = null; x.time = ''; } });
    finishChange(snapshot, '已重置所选日期');
  };
  clearTodayTemp = function () { resetToday(); };
  clearWeek = function () {
    const start = monday(dayKey), end = dateAdd(start, 7);
    if (!confirm('清空本周未完成的临时安排，并把已安排的未完成任务退回任务库？课程、已完成记录、项目和节点保留。')) return;
    const snapshot = beforeChange();
    db.weekly = db.weekly.filter(x => x.date < start || x.date >= end || x.done || fixedPlan(x));
    for (let d = start; d < end; d = dateAdd(d, 1)) db.daily[d] = (db.daily[d] || []).filter(x => x.done || fixedPlan(x));
    db.tasks.forEach(x => { if (x.scheduledDate >= start && x.scheduledDate < end && !x.done) { x.scheduledDate = null; x.time = ''; } });
    finishChange(snapshot, '本周临时计划已清空');
  };
  deleteFromDay = function (kind, idv) {
    if (kind === 'task') return moveDayItem(kind, idv, 'library');
    const item = kind === 'event' ? db.weekly.find(x => x.id === idv) : db.daily[dayKey]?.find(x => x.id === idv);
    if (item && fixedPlan(item)) return toast('固定课程不能从此处删除');
    if (item && item.done) return toast('已完成记录不能删除');
    oldDeleteFromDay(kind, idv);
  };
  toggleItem = function (idv) {
    const task = db.tasks.find(x => x.id === idv);
    if (!task) return oldToggleItem(idv);
    task.done = !task.done;
    if (task.done) {
      task.completedAt = dayKey;
      db.history[dayKey] = db.history[dayKey] || [];
      if (!db.history[dayKey].some(x => x.id === task.id && x.done))
        db.history[dayKey].push({id:task.id,title:task.title,done:true,kind:'task'});
    }
    save(); render();
  };
  editItem = function (type, idv) {
    if (type === 'task') return openTaskEditor(idv);
    return oldEditItem(type, idv);
  };
  openTaskEditor = function (idv) {
    const t = db.tasks.find(x => x.id === idv);
    if (!t) return;
    document.getElementById('dialog').innerHTML = `<div class="row spread"><h2>编辑任务</h2><button class="iconbtn" onclick="closeModal()">×</button></div>
      <form onsubmit="saveTaskEditor(event,'${t.id}')"><div class="fields">
      <label class="field">名称<input id="task-title" required value="${esc(t.title)}"></label>
      <label class="field">分类<input id="task-category" value="${esc(t.category || '')}"></label>
      <label class="field">预计分钟<input id="task-duration" type="number" min="0" value="${t.duration || ''}"></label>
      <label class="field">优先级<select id="task-priority">${['','高','中','低'].map(v => `<option value="${v}" ${t.priority === v ? 'selected' : ''}>${v || '普通'}</option>`).join('')}</select></label>
      <label class="field">截止日期<input id="task-deadline" type="date" value="${t.deadline || ''}"></label>
      <label class="field">安排日期（留空则在任务库）<input id="task-date" type="date" value="${t.scheduledDate || ''}"></label>
      <label class="field">开始时间<input id="task-time" type="time" value="${t.time || ''}"></label>
      </div><div class="row" style="margin-top:15px"><button class="btn primary">保存</button><button type="button" class="btn" onclick="closeModal()">取消</button></div></form>`;
    document.getElementById('modal').classList.add('show');
  };
  saveTaskEditor = function (event, idv) {
    event.preventDefault();
    const t = db.tasks.find(x => x.id === idv);
    if (!t) return;
    const val = name => document.getElementById('task-' + name).value;
    Object.assign(t, {title:val('title').trim(),category:val('category').trim(),duration:Number(val('duration')) || 0,
      priority:val('priority'),deadline:val('deadline'),scheduledDate:val('date') || null,time:val('time')});
    save(); closeModal(); render(); toast('任务已保存');
  };
  chooseTaskDate = function (idv) {
    const t = db.tasks.find(x => x.id === idv);
    if (!t) return;
    document.getElementById('dialog').innerHTML = `<div class="row spread"><h2>安排任务</h2><button class="iconbtn" onclick="closeModal()">×</button></div>
      <p>${esc(t.title)}</p><form onsubmit="event.preventDefault();setTaskDate('${t.id}',document.getElementById('choose-date').value)">
      <label class="field">日期<input type="date" id="choose-date" required value="${iso(new Date())}"></label>
      <div class="row" style="margin-top:14px"><button class="btn primary">安排</button><button type="button" class="btn" onclick="closeModal()">取消</button></div></form>`;
    document.getElementById('modal').classList.add('show');
  };
  setTaskDate = function (idv, date) {
    const t = db.tasks.find(x => x.id === idv);
    if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    t.scheduledDate = date; save(); closeModal(); render(); toast('已安排到 ' + date);
  };
  drawTasks = function () {
    const xs = db.tasks.filter(x => !x.scheduledDate && !x.done);
    document.getElementById('taskList').innerHTML = xs.length ? xs.map(x => itemHtml(x,
      `<button class="smallbtn" onclick="scheduleTask('${x.id}',0)">今天</button><button class="smallbtn" onclick="scheduleTask('${x.id}',1)">明天</button><button class="smallbtn" onclick="chooseTaskDate('${x.id}')">指定日期</button><button class="smallbtn" onclick="editItem('task','${x.id}')">编辑</button><button class="smallbtn" onclick="deleteTask('${x.id}')">删除</button>`)).join('')
      : '<div class="empty">任务库空空的，记录一个待办吧。</div>';
  };
  scheduleTask = function (idv, offset) {
    const t = db.tasks.find(x => x.id === idv);
    if (!t || t.done) return;
    t.scheduledDate = dateAdd(iso(new Date()), offset);
    save(); render(); toast('已安排到 ' + t.scheduledDate);
  };

  function loadOcrScript() {
    if (window.Tesseract) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.0.5/dist/tesseract.min.js';
      script.onload = resolve; script.onerror = () => reject(Error('OCR 组件下载失败，请联网重试'));
      document.head.appendChild(script);
    });
  }
  openPhotoImport = function () {
    document.getElementById('dialog').innerHTML = `<div class="row spread"><h2>从图片更新本周课表</h2><button class="iconbtn" onclick="closeModal()">×</button></div>
      <p class="sub">选择与示例相似的七列课表截图。识别在浏览器中进行，首次需联网下载中文识别组件；请逐条核对课程、日期、时间后再导入。</p>
      <label class="field">目标周的周一<input id="photo-week" type="date" value="${monday(dayKey)}"></label>
      <input id="photo-file" type="file" accept="image/*" style="margin-top:10px" onchange="previewPhoto(this)">
      <img id="photo-preview" alt="课表截图预览" style="display:none;width:100%;max-height:260px;object-fit:contain;margin:10px 0;border-radius:10px">
      <div class="row"><button class="btn primary" id="photo-recognize" onclick="recognizePhoto()">识别图片</button><button class="btn" onclick="addPhotoRow()">手动加一条</button></div>
      <div id="photo-status" class="sub" style="margin:10px 0"></div><div id="photo-rows" class="list"></div>
      <div id="photo-actions" class="row" style="display:none;margin-top:14px"><button class="btn primary" onclick="applyPhotoImport('merge')">合并到该周</button><button class="btn" onclick="applyPhotoImport('replace')">替换该周未完成课程</button></div>`;
    document.getElementById('modal').classList.add('show');
  };
  previewPhoto = function (input) {
    const file = input.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('请选择图片文件');
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = URL.createObjectURL(file);
    const image = document.getElementById('photo-preview');
    image.src = imageUrl; image.style.display = 'block';
    document.getElementById('photo-rows').innerHTML = '';
    document.getElementById('photo-actions').style.display = 'none';
  };
  function photoRows(tsv, width, height) {
    const words = tsv.split(/\r?\n/).slice(1).map(line => line.split('\t')).filter(v => v.length >= 12 && v[0] === '5' && Number(v[10]) >= 18 && v.slice(11).join('\t').trim())
      .map(v => ({text:v.slice(11).join('\t').trim(),x:Number(v[6]) + Number(v[8])/2,y:Number(v[7]) + Number(v[9])/2}));
    const centers = [.16,.29,.42,.55,.68,.81,.94];
    const bands = [[.19,.31],[.32,.44],[.45,.58],[.59,.72],[.73,.85]];
    const starts = ['08:20','10:20','14:00','16:00','18:40'];
    const ends = ['10:00','12:00','15:40','17:40','20:20'];
    const found = [];
    for (let day = 1; day <= 7; day++) for (let slot = 0; slot < bands.length; slot++) {
      const cell = words.filter(w => Math.abs(w.x/width - centers[day-1]) < .055 && w.y/height >= bands[slot][0] && w.y/height <= bands[slot][1])
        .sort((a,b) => a.y-b.y || a.x-b.x).map(w => w.text);
      const text = cell.join('').replace(/^[\s\-—|]+|[\s\-—|]+$/g,'');
      if (text.length < 2) continue;
      found.push({day,time:starts[slot],endTime:ends[slot],title:text,location:''});
    }
    return found;
  }
  function addRow(row = {}) {
    const root = document.getElementById('photo-rows');
    const element = document.createElement('div');
    element.className = 'card photo-row';
    element.innerHTML = `<div class="row spread"><label><input class="photo-use" type="checkbox" checked style="width:auto"> 导入此项</label><button class="smallbtn" type="button" onclick="this.closest('.photo-row').remove()">移除</button></div>
      <div class="fields" style="margin-top:8px"><label class="field">星期<select class="photo-day">${DAYS.map((x,i) => `<option value="${i+1}" ${row.day === i+1 ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label class="field">开始时间<input class="photo-time" type="time" value="${row.time || '08:20'}"></label>
      <label class="field">结束时间<input class="photo-end" type="time" value="${row.endTime || '10:00'}"></label></div>
      <label class="field">课程名称<input class="photo-title" value="${esc(row.title || '')}" placeholder="请核对识别结果"></label>
      <label class="field">地点（可选）<input class="photo-location" value="${esc(row.location || '')}"></label>`;
    root.appendChild(element);
    document.getElementById('photo-actions').style.display = 'flex';
  }
  addPhotoRow = function () { addRow(); };
  recognizePhoto = async function () {
    const file = document.getElementById('photo-file').files?.[0];
    if (!file) return toast('先选择课表截图');
    const button = document.getElementById('photo-recognize');
    const status = document.getElementById('photo-status');
    button.disabled = true; status.textContent = '正在加载中文识别组件…';
    let worker;
    try {
      await loadOcrScript();
      status.textContent = '正在识别图片，手机上可能需要一两分钟…';
      worker = await Tesseract.createWorker('chi_sim+eng');
      const result = await worker.recognize(file, {}, {tsv:true,text:true});
      const img = document.getElementById('photo-preview');
      if (!img.complete) await new Promise(resolve => { img.onload = resolve; img.onerror = resolve; });
      const rows = photoRows(result.data.tsv || '', img.naturalWidth, img.naturalHeight);
      document.getElementById('photo-rows').innerHTML = '';
      rows.forEach(addRow);
      status.textContent = rows.length ? `识别到 ${rows.length} 条候选课程。图片分栏和文字可能识别有误，请修改、删除或补充后再导入。` : '未识别到课程。可手动添加，或改用 JSON 导入。';
    } catch (error) {
      status.textContent = '识别失败：' + error.message + '。可手动添加或改用 JSON 导入。';
    } finally {
      if (worker) await worker.terminate();
      button.disabled = false;
    }
  };
  applyPhotoImport = function (mode) {
    try {
    const input = document.getElementById('photo-week').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input) || monday(input) !== input) return toast('目标日期必须是周一');
    const rows = [...document.querySelectorAll('.photo-row')].filter(x => x.querySelector('.photo-use').checked);
    if (!rows.length) return toast('请至少勾选一条课程');
    const items = rows.map((node,i) => {
      const val = cls => node.querySelector('.' + cls).value.trim();
      const day = Number(val('photo-day')), time = val('photo-time'), title = val('photo-title');
      if (!title || !time || !val('photo-end')) throw Error(`第 ${i+1} 条缺少名称或时间`);
      const signature = `${input}|${day}|${time}|${title}`;
      let hash = 2166136261;
      for (const c of signature) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
      return {id:'photo_'+(hash>>>0).toString(36),title,day,date:dateAdd(input,day-1),time,startTime:time,
        endTime:val('photo-end'),location:val('photo-location'),category:'课程'};
    });
      normalizeImport({schemaVersion:1,type:'weekly',weekStart:input,items});
      if (mode === 'replace' && !confirm(`只替换 ${input} 当周未完成的课程？实验、活动、任务和已完成记录都会保留。请确认识别结果已核对。`)) return;
      const snapshot = beforeChange();
      if (mode === 'replace') db.weekly = db.weekly.filter(x => x.weekStart !== input || x.category !== '课程' || x.done);
      const signature = x => `${x.date}|${x.startTime || x.time || ''}|${x.title}`;
      const seen = new Set(db.weekly.map(signature));
      let count = 0;
      items.forEach(item => { if (!seen.has(signature(item))) { db.weekly.push({...item,weekStart:input}); seen.add(signature(item)); count++; } });
      closeModal();
      finishChange(snapshot, `${mode === 'replace' ? '已更新' : '已合并'}该周课程 ${count} 条`);
    } catch (error) { toast('请检查识别结果：' + error.message); }
  };
})();
