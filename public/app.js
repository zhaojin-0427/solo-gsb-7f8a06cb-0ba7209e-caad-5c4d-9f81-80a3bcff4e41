'use strict';

/* 原生 JS，无任何框架 / 构建步骤 */

const state = {
  strategy: 'reader', // 'reader' | 'writer'
  data: null,         // 最近一次 /api/compare 返回
  expanded: new Set(),// 展开的树节点路径（跨重渲染 / 策略切换保持）
  onlyImpact: false,
  genSide: 'old',     // 'old' | 'new'：样本生成基于哪份 Schema
  genResult: null,    // 最近一次 /api/generate 成功结果
  ceResult: null,     // 最近一次 /api/counterexample 成功结果
  verifyResult: null, // 最近一次 /api/verify 成功结果
  verifyFilter: 'all',// 结果分类过滤：all | both | oldOnly | newOnly | bothFail
};

const $ = (id) => document.getElementById(id);

const LEVEL_LABEL = { breaking: '破坏', warning: '风险', safe: '兼容', info: '提示' };
const LEVEL_ORDER = ['breaking', 'warning', 'info', 'safe'];

/* ---------------- 输入区交互 ---------------- */

document.querySelectorAll('input[type="file"]').forEach((input) => {
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      $(input.dataset.target).value = reader.result;
      clearGenerated('Schema 已通过文件更新');
      clearVerify('Schema 已通过文件更新');
      clearCounterexample('Schema 已通过文件更新');
    };
    reader.readAsText(file);
    input.value = ''; // 允许重复选择同一文件
  });
});

document.querySelectorAll('[data-clear]').forEach((btn) => {
  btn.addEventListener('click', () => {
    $(btn.dataset.clear).value = '';
    clearGenerated('Schema 已清空');
    clearVerify('Schema 已清空');
    clearCounterexample('Schema 已清空');
  });
});

$('sampleBtn').addEventListener('click', async () => {
  try {
    const resp = await fetch('/api/sample');
    const sample = await resp.json();
    $('oldInput').value = JSON.stringify(JSON.parse(sample.old), null, 2);
    $('newInput').value = JSON.stringify(JSON.parse(sample.new), null, 2);
    hideError();
    clearGenerated('已载入比对示例 Schema');
    clearVerify('已载入比对示例 Schema');
    clearCounterexample('已载入比对示例 Schema');
  } catch (e) {
    showError('示例载入失败：' + e.message);
  }
});

// 任意手工编辑都会让已生成样本 / 已核验结论失效（它们都依赖当前 Schema）
['oldInput', 'newInput'].forEach((id) => {
  $(id).addEventListener('input', () => {
    clearGenerated('Schema 已修改');
    clearVerify('Schema 已修改');
    clearCounterexample('Schema 已修改');
  });
});

// 实例输入一变，旧核验结论立即过期
$('verifyInput').addEventListener('input', () => clearVerify('实例数据已修改'));

// Tab 键在 textarea 内插入两个空格，方便手写 JSON
document.querySelectorAll('textarea').forEach((ta) => {
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart;
      ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(ta.selectionEnd);
      ta.selectionStart = ta.selectionEnd = s + 2;
    }
  });
});

/* ---------------- 策略切换 ---------------- */

document.querySelectorAll('.seg[data-strategy]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const next = btn.dataset.strategy;
    if (next === state.strategy) return;
    state.strategy = next;
    document.querySelectorAll('.seg[data-strategy]').forEach((b) => {
      const active = b.dataset.strategy === next;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    // 已有结果时纯前端重渲染，不重新请求，保证切换稳定
    if (state.data) renderAll();
  });
});

$('onlyImpact').addEventListener('change', (e) => {
  state.onlyImpact = e.target.checked;
  if (state.data) renderTree();
});
$('expandAll').addEventListener('click', () => {
  if (!state.data) return;
  walkNodes(state.data.tree, (n) => n.children.length && state.expanded.add(n.path));
  renderTree();
});
$('collapseAll').addEventListener('click', () => {
  state.expanded.clear();
  // 根节点保持展开
  state.expanded.add('');
  renderTree();
});

/* ---------------- 比对请求 ---------------- */

$('compareBtn').addEventListener('click', runCompare);

async function runCompare() {
  hideError();
  const oldSchema = $('oldInput').value;
  const newSchema = $('newInput').value;

  try {
    const resp = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldSchema, newSchema, strategy: state.strategy }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      showError(data.error || '比对失败');
      return;
    }
    state.data = data;
    if (data.activeStrategy && data.activeStrategy !== state.strategy) {
      state.strategy = data.activeStrategy;
    }
    initExpansion();
    $('resultSection').hidden = false;
    renderAll();
  } catch (e) {
    showError('请求失败：' + e.message);
  }
}

function showError(msg) {
  const box = $('errorBox');
  box.textContent = msg;
  box.hidden = false;
}
function hideError() {
  $('errorBox').hidden = true;
}

/* ---------------- 渲染总入口 ---------------- */

function renderAll() {
  renderSummary();
  renderTree();
  renderPlan();
}

/* ---------------- 概览 ---------------- */

function renderSummary() {
  const { summary, plans } = state.data;
  const side = state.strategy;
  const c = plans[side].counts;
  const other = side === 'reader' ? 'writer' : 'reader';
  const otherLabel = other === 'reader' ? '读取方' : '写入方';
  const sideLabel = side === 'reader' ? '读取方兼容（旧消费方读新数据）' : '写入方兼容（旧生产方写新校验）';

  $('summary').innerHTML =
    `<span class="strategy-now">当前策略：${sideLabel}</span>` +
    pill('breaking', `${LEVEL_LABEL.breaking} × ${c.breaking}`) +
    pill('warning', `${LEVEL_LABEL.warning} × ${c.warning}`) +
    pill('info', `${LEVEL_LABEL.info} × ${c.info}`) +
    pill('safe', `${LEVEL_LABEL.safe} × ${c.safe}`) +
    `<span class="sep"></span>` +
    `<span title="切换策略即可查看另一视角">共发现 ${summary.total} 处变化 · 另一视角（${otherLabel}策略）下破坏 ${plans[other].counts.breaking} 处</span>`;
}

function pill(level, text) {
  return `<span class="pill ${level}">${text}</span>`;
}

/* ---------------- 路径树 ---------------- */

function walkNodes(node, fn) {
  fn(node);
  node.children.forEach((ch) => walkNodes(ch, fn));
}

/** 首次结果：默认展开根及含破坏/风险的节点所在路径 */
function initExpansion() {
  state.expanded = new Set(['']);
  const side = state.strategy;
  const openIfImpact = (node, ancestorHit) => {
    const hit = ancestorHit || node.own[side] === 'breaking' || node.own[side] === 'warning';
    if (hit && node.children.length) state.expanded.add(node.path);
    node.children.forEach((ch) => openIfImpact(ch, hit));
  };
  openIfImpact(state.data.tree, false);
}

function renderTree() {
  const rootEl = $('tree');
  rootEl.innerHTML = '';
  const side = state.strategy;
  // 统一包一层 <ul>，保证根节点与子节点缩进/连线结构一致
  const ul = document.createElement('ul');
  ul.appendChild(renderNode(state.data.tree, side, true));
  rootEl.appendChild(ul);
}

function nodeHasImpact(node, side) {
  if (node.findings.some((f) => f[side] !== 'safe')) return true;
  return node.children.some((ch) => nodeHasImpact(ch, side));
}

function renderNode(node, side, isRoot) {
  const li = document.createElement('li');
  li.className = 'tree-node';

  if (state.onlyImpact && !nodeHasImpact(node, side)) {
    li.style.display = 'none';
    return li;
  }

  const hasChildren = node.children.length > 0;
  const isOpen = isRoot || state.expanded.has(node.path);

  const row = document.createElement('div');
  row.className = 'node-row' + (hasChildren ? ' clickable' : '');

  const toggle = document.createElement('span');
  toggle.className = 'toggle';
  toggle.textContent = hasChildren ? (isOpen ? '▼' : '▶') : '';
  row.appendChild(toggle);

  const name = document.createElement('span');
  name.className = 'node-name ' + (node.kind === 'keyword' ? 'keyword' : node.kind === 'index' ? 'index' : '');
  name.textContent = node.name;
  // 悬停显示规范 JSON Pointer（含 ~0/~1 转义），与差异 / 清单路径一致
  if (node.path) name.title = node.path;
  row.appendChild(name);

  // 自身 finding 的当前策略级别徽章；无自身 finding 时显示子树最差（灰色小字）
  const ownLevels = unique(node.findings.map((f) => f[side]));
  if (ownLevels.length) {
    LEVEL_ORDER.forEach((lv) => {
      if (ownLevels.includes(lv) && (!state.onlyImpact || lv !== 'safe')) {
        row.appendChild(makeBadge(lv, LEVEL_LABEL[lv]));
      }
    });
  } else if (node.worst[side] && (!state.onlyImpact || node.worst[side] !== 'safe')) {
    const b = makeBadge(node.worst[side], '子树:' + LEVEL_LABEL[node.worst[side]]);
    b.classList.add('muted');
    row.appendChild(b);
  }

  li.appendChild(row);

  // 自身 findings
  const fBox = document.createElement('div');
  fBox.className = 'finding-list';
  let visibleFinding = 0;
  for (const f of node.findings) {
    if (state.onlyImpact && f[side] === 'safe') continue;
    fBox.appendChild(renderFinding(f, side));
    visibleFinding++;
  }
  if (visibleFinding) li.appendChild(fBox);

  // 子节点
  if (hasChildren) {
    const ul = document.createElement('ul');
    if (!isOpen) ul.style.display = 'none';
    node.children.forEach((ch) => ul.appendChild(renderNode(ch, side, false)));
    li.appendChild(ul);
  }

  if (hasChildren) {
    row.addEventListener('click', () => {
      if (state.expanded.has(node.path)) state.expanded.delete(node.path);
      else state.expanded.add(node.path);
      renderTree();
    });
  }

  return li;
}

function renderFinding(f, side) {
  const meta = state.data.kindMeta[f.kind] || { title: f.kind };
  const div = document.createElement('div');
  div.className = `finding ${f[side]}`;

  const title = document.createElement('div');
  title.className = 'finding-title';
  title.innerHTML =
    `<span>${escapeHtml(meta.title)}</span>` +
    `<span class="finding-side">读取方:${LEVEL_LABEL[f.reader]} / 写入方:${LEVEL_LABEL[f.writer]}</span>`;
  div.appendChild(title);

  const detail = document.createElement('div');
  detail.className = 'finding-detail';
  detail.textContent = f.detail;
  div.appendChild(detail);

  if (f.oldValue !== undefined || f.newValue !== undefined) {
    const vals = document.createElement('div');
    vals.className = 'finding-values';
    vals.innerHTML =
      (f.oldValue !== undefined ? `<span class="old">旧: ${escapeHtml(f.oldValue)}</span>` : '') +
      (f.oldValue !== undefined && f.newValue !== undefined ? ' &nbsp;→&nbsp; ' : '') +
      (f.newValue !== undefined ? `<span class="new">新: ${escapeHtml(f.newValue)}</span>` : '');
    div.appendChild(vals);
  }

  if (f.ref && f.ref.length) {
    const refs = document.createElement('div');
    refs.className = 'finding-ref';
    refs.textContent = '🔗 ' + f.ref.join('  ');
    div.appendChild(refs);
  }

  return div;
}

function makeBadge(level, text) {
  const b = document.createElement('span');
  b.className = 'badge ' + level;
  b.textContent = text;
  return b;
}

/* ---------------- 迁移清单 ---------------- */

function renderPlan() {
  const plan = state.data.plans[state.strategy];
  $('planTitle').textContent =
    (state.strategy === 'reader' ? '读取方兼容' : '写入方兼容') + ' · 有序迁移清单';
  $('planHint').textContent =
    state.strategy === 'reader'
      ? 'Expand-Contract：先让所有读取方容忍新结构，再切换写入方，最后清理旧逻辑。步骤按可上线顺序排列。'
      : 'Expand-Contract：先让写入方在旧校验下双发 / 收敛产出，再升级读取方与校验，最后停止旧产出。步骤按可上线顺序排列。';

  const list = $('planList');
  list.innerHTML = '';

  if (!plan.items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-note';
    empty.textContent = '当前策略下没有需要执行的迁移步骤（所有变化均兼容）。';
    list.appendChild(empty);
    return;
  }

  const phases = [1, 2, 3];
  let stepNo = 0;

  for (const phase of phases) {
    const items = plan.items.filter((it) => it.phase === phase);
    if (!items.length) continue;

    const box = document.createElement('li');
    box.className = 'phase';

    const title = document.createElement('div');
    title.className = 'phase-title';
    title.textContent = plan.phaseTitles[phase] + `（${items.length} 步）`;
    box.appendChild(title);

    const body = document.createElement('ol');
    body.className = 'phase-body';
    body.start = stepNo + 1;

    for (const it of items) {
      stepNo++;
      const li = document.createElement('li');
      li.className = 'step ' + it.level;

      const num = document.createElement('span');
      num.className = 'step-num';
      num.textContent = stepNo;

      const content = document.createElement('div');
      content.className = 'step-body';

      const meta = document.createElement('div');
      meta.className = 'step-meta';
      const kindTitle = (state.data.kindMeta[it.kind] || {}).title || it.kind;
      meta.textContent = `[${LEVEL_LABEL[it.level]}] ${kindTitle}`;
      if (it.path) {
        // 显示真实字段名定位；title 保留规范 JSON Pointer
        const loc = document.createElement('span');
        loc.className = 'step-path';
        loc.textContent = ' · ' + humanPointer(it.path);
        loc.title = it.path;
        meta.appendChild(loc);
      }

      const text = document.createElement('div');
      text.textContent = it.text;

      content.appendChild(meta);
      content.appendChild(text);
      li.appendChild(num);
      li.appendChild(content);
      body.appendChild(li);
    }

    box.appendChild(body);
    list.appendChild(box);
  }
}

/* ---------------- 小工具 ---------------- */

function unique(arr) {
  return [...new Set(arr)];
}

/** RFC 6901 解码单个路径片段：~1 → /，~0 → ~（顺序不可颠倒） */
function decodePointerToken(token) {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * 规范 JSON Pointer → 人类可读定位（还原真实字段名），与树节点 / 清单口径一致：
 *   /properties/a~1b/properties/child → "a/b" › "child"
 * 仅用于展示；规范 Pointer 仍作为节点身份、展开状态与排序的唯一键。
 */
function humanPointer(pointer) {
  if (!pointer) return '根节点';
  const tokens = pointer.split('/').slice(1);
  const parts = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'properties' && i + 1 < tokens.length) {
      parts.push('"' + decodePointerToken(tokens[i + 1]) + '"');
      i++;
    } else if (/^\d+$/.test(tokens[i])) {
      parts.push('[' + tokens[i] + ']');
    } else {
      parts.push(decodePointerToken(tokens[i]));
    }
  }
  return parts.join(' › ') || '根节点';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------------- 有效样本生成 ---------------- */

document.querySelectorAll('input[name="genSide"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    state.genSide = radio.value;
    // 已显示的样本属于另一版 Schema，切换后清空，避免误以为对应当前选择
    clearGenerated('已切换为' + (radio.value === 'old' ? '旧' : '新') + ' Schema');
  });
});

/* ---------------- 存量实例迁移核验 ---------------- */

const VERIFY_CATEGORY_META = {
  both:     { label: '新旧均通过', level: 'safe', hint: '升级后依然合法' },
  oldOnly:  { label: '仅旧版通过', level: 'breaking', hint: '升级后会被新版拒收，需要迁移' },
  newOnly:  { label: '仅新版通过', level: 'warning', hint: '旧版已不认可、新版放行的数据' },
  bothFail: { label: '两版均失败', level: 'info', hint: '本来就不合规的存量脏数据' },
};

$('verifySampleBtn').addEventListener('click', async () => {
  try {
    const resp = await fetch('/api/sample');
    const sample = await resp.json();
    $('oldInput').value = JSON.stringify(JSON.parse(sample.verifyOld), null, 2);
    $('newInput').value = JSON.stringify(JSON.parse(sample.verifyNew), null, 2);
    $('verifyInput').value = JSON.stringify(JSON.parse(sample.verifyInstances), null, 2);
    hideError();
    hideGenError();
    clearGenerated('已载入核验示例 Schema');
    // 示例同时替换了 Schema 与实例，直接清掉旧结论（不弹提示，本次请求自带新数据）
    state.verifyResult = null;
    $('verifyResult').hidden = true;
    hideVerifyError();
    state.ceResult = null;
    $('ceResult').hidden = true;
    hideCeError();
    updateVerifyCount();
  } catch (e) {
    showVerifyError('核验示例载入失败：' + e.message);
  }
});

$('verifyClearBtn').addEventListener('click', () => {
  $('verifyInput').value = '';
  updateVerifyCount();
  clearVerify('实例数据已清空');
});

$('verifyInput').addEventListener('input', updateVerifyCount);

$('verifyBtn').addEventListener('click', runVerify);

async function runVerify() {
  hideVerifyError();
  const btn = $('verifyBtn');
  btn.disabled = true;
  try {
    const resp = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        oldSchema: $('oldInput').value,
        newSchema: $('newInput').value,
        instances: $('verifyInput').value,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      state.verifyResult = null;
      $('verifyResult').hidden = true;
      showVerifyError(data.error || '核验失败');
      return;
    }
    state.verifyResult = data;
    // 有「仅旧版通过」时默认聚焦该分类，帮助用户立刻找到会被拒收的数据
    state.verifyFilter = data.summary.oldOnly > 0 ? 'oldOnly' : 'all';
    updateVerifyCount();
    renderVerify();
  } catch (e) {
    showVerifyError('请求失败：' + e.message);
  } finally {
    btn.disabled = false;
  }
}

/** 文本框旁显示条数预览（合法 JSON 数组时），不弹任何错误 */
function updateVerifyCount() {
  const el = $('verifyCount');
  const text = $('verifyInput').value.trim();
  if (!text) { el.textContent = ''; return; }
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) {
      el.textContent = v.length === 0 ? '空数组' : `共 ${v.length} 条实例（上限 100 条）`;
    } else {
      el.textContent = '';
    }
  } catch (e) {
    el.textContent = '';
  }
}

function renderVerify() {
  const { summary, items } = state.verifyResult;
  $('verifyResult').hidden = false;

  // 汇总条
  const sumEl = $('verifySummary');
  sumEl.innerHTML =
    `<span class="verify-total">共核验 ${summary.total} 条</span>` +
    Object.entries(VERIFY_CATEGORY_META).map(([key, meta]) =>
      `<span class="verify-pill ${meta.level}" title="${escapeHtml(meta.hint)}">${meta.label} × ${summary[key]}</span>`
    ).join('') +
    `<span class="verify-tip">仅旧版通过的实例升级后会被新版拒收，请优先处理</span>`;

  // 分类过滤
  const filterEl = $('verifyFilter');
  const filters = [
    { key: 'all', label: `全部（${summary.total}）` },
    ...Object.keys(VERIFY_CATEGORY_META).map((key) => ({
      key,
      label: `${VERIFY_CATEGORY_META[key].label}（${summary[key]}）`,
    })),
  ];
  filterEl.innerHTML = '';
  for (const f of filters) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'verify-chip' + (state.verifyFilter === f.key ? ' active' : '');
    chip.textContent = f.label;
    chip.addEventListener('click', () => {
      state.verifyFilter = f.key;
      renderVerify();
    });
    filterEl.appendChild(chip);
  }

  // 逐条结论（顺序与输入一致）
  const listEl = $('verifyList');
  listEl.innerHTML = '';
  const shown = items.filter((it) => state.verifyFilter === 'all' || it.category === state.verifyFilter);

  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-note';
    empty.textContent = state.verifyFilter === 'all' ? '没有核验结果。' : '该分类下没有实例。';
    listEl.appendChild(empty);
    return;
  }

  for (const it of shown) listEl.appendChild(renderVerifyItem(it));
}

function renderVerifyItem(it) {
  const meta = VERIFY_CATEGORY_META[it.category];

  const card = document.createElement('div');
  card.className = `verify-item ${it.category}`;

  const head = document.createElement('div');
  head.className = 'verify-item-head';
  head.innerHTML =
    `<span class="verify-index">#${it.index + 1}</span>` +
    `<span class="badge ${meta.level}">${meta.label}</span>` +
    `<span class="verify-item-hint">${escapeHtml(meta.hint)}</span>`;
  card.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'verify-sides';
  grid.appendChild(renderSideResult('旧', it.old));
  grid.appendChild(renderSideResult('新', it.new));
  card.appendChild(grid);

  // 实例原文（折叠，便于核对脏数据）
  let instanceText;
  try {
    const arr = JSON.parse($('verifyInput').value);
    instanceText = JSON.stringify(arr[it.index], null, 2);
  } catch (e) {
    instanceText = '（原始实例无法回显）';
  }
  const det = document.createElement('details');
  det.className = 'verify-instance';
  const sum = document.createElement('summary');
  sum.textContent = '查看该条实例 JSON';
  det.appendChild(sum);
  const pre = document.createElement('pre');
  pre.textContent = instanceText;
  det.appendChild(pre);
  card.appendChild(det);

  return card;
}

function renderSideResult(sideLabel, side) {
  const box = document.createElement('div');
  box.className = 'verify-side ' + (side.valid ? 'valid' : 'invalid');

  const title = document.createElement('div');
  title.className = 'verify-side-title';
  title.innerHTML =
    `<span class="verify-side-name">${sideLabel}版 Schema</span>` +
    (side.valid
      ? '<span class="verify-side-ok">✓ 通过</span>'
      : `<span class="verify-side-bad">✗ 失败（${side.errors.length} 条错误）</span>`);
  box.appendChild(title);

  if (!side.valid) {
    const ul = document.createElement('ul');
    ul.className = 'verify-errors';
    for (const er of side.errors) {
      const li = document.createElement('li');
      const loc = document.createElement('span');
      loc.className = 'verify-ptr';
      loc.textContent = er.instancePath || '（根节点）';
      loc.title = '实例 JSON Pointer';
      const msg = document.createElement('span');
      msg.className = 'verify-msg';
      msg.textContent = er.message;
      li.appendChild(loc);
      li.appendChild(msg);
      if (er.schemaPath) {
        const sp = document.createElement('span');
        sp.className = 'verify-schema-ptr';
        sp.textContent = 'schema' + (er.schemaPath || '#');
        sp.title = 'Schema JSON Pointer（关键字位置）';
        li.appendChild(sp);
      }
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
  return box;
}

/** 任一输入（Schema / 实例）变化后清除过期核验结论 */
function clearVerify(reason) {
  if (!state.verifyResult && $('verifyResult').hidden && $('verifyErrorBox').hidden) return;
  state.verifyResult = null;
  $('verifyResult').hidden = true;
  $('verifyList').innerHTML = '';
  if (reason) showVerifyError(reason + '，之前的核验结论已清空。', true);
}

function showVerifyError(msg, muted) {
  const box = $('verifyErrorBox');
  box.textContent = msg;
  box.classList.toggle('muted-note', !!muted);
  box.hidden = false;
}
function hideVerifyError() {
  $('verifyErrorBox').hidden = true;
  $('verifyErrorBox').classList.remove('muted-note');
}

$('genSampleBtn').addEventListener('click', async () => {
  try {
    const resp = await fetch('/api/sample');
    const sample = await resp.json();
    const targetId = state.genSide === 'old' ? 'oldInput' : 'newInput';
    $(targetId).value = JSON.stringify(JSON.parse(sample.gen), null, 2);
    hideGenError();
    clearGenerated('已将生成示例载入' + (state.genSide === 'old' ? '旧' : '新') + ' Schema 输入框');
    clearVerify('已将生成示例载入' + (state.genSide === 'old' ? '旧' : '新') + ' Schema 输入框');
    clearCounterexample('已将生成示例载入' + (state.genSide === 'old' ? '旧' : '新') + ' Schema 输入框');
  } catch (e) {
    showGenError('示例载入失败：' + e.message);
  }
});

$('genBtn').addEventListener('click', runGenerate);

async function runGenerate() {
  hideGenError();
  const btn = $('genBtn');
  btn.disabled = true;
  try {
    const resp = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        oldSchema: $('oldInput').value,
        newSchema: $('newInput').value,
        side: state.genSide,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      state.genResult = null;
      $('genResult').hidden = true;
      showGenError(renderGenError(data));
      return;
    }
    state.genResult = data;
    $('genErrorBox').hidden = true;
    $('genMeta').textContent =
      (data.side === 'old' ? '基于旧 Schema' : '基于新 Schema') +
      ' · 已通过 Ajv（draft-07）复验';
    $('genOutput').textContent = data.instanceText;
    $('genResult').hidden = false;
  } catch (e) {
    showGenError('请求失败：' + e.message);
  } finally {
    btn.disabled = false;
  }
}

/** 把后端错误渲染为含路径定位的可读文本 */
function renderGenError(data) {
  let msg = data.error || '样本生成失败';
  if (Array.isArray(data.problems) && data.problems.length) {
    msg += '\n\n不支持的关键字明细：\n' + data.problems.map((p, i) => {
      const where = p.schemaPath ? humanPointer(p.schemaPath) : '根节点';
      return `${i + 1}. ${p.label}｜位置：${where}｜${p.message}`;
    }).join('\n');
  }
  if (data.schemaPath) {
    msg += `\n\nSchema 路径：${data.schemaPath}` + (humanPointer(data.schemaPath) !== '根节点' ? `（${humanPointer(data.schemaPath)}）` : '');
  }
  if (data.instancePath) {
    msg += `\n实例路径：${data.instancePath}（${humanPointer(data.instancePath)}）`;
  }
  return msg;
}

/** Schema 被编辑 / 替换 / 清空时，旧样本立即失效 */
function clearGenerated(reason) {
  if (!state.genResult && $('genResult').hidden && $('genErrorBox').hidden) return;
  state.genResult = null;
  $('genResult').hidden = true;
  $('genOutput').textContent = '';
  if (reason) showGenError(reason + '，之前生成的样本已清空。', true);
}

function showGenError(msg, muted) {
  const box = $('genErrorBox');
  box.textContent = msg;
  box.classList.toggle('muted-note', !!muted);
  box.hidden = false;
}
function hideGenError() {
  $('genErrorBox').hidden = true;
  $('genErrorBox').classList.remove('muted-note');
}

/** 复制文本到剪贴板（含非安全上下文兜底），按按钮反馈结果 */
async function copyText(text, btn) {
  const done = (ok) => {
    const old = btn.textContent;
    btn.textContent = ok ? '已复制 ✓' : '复制失败';
    setTimeout(() => { btn.textContent = old; }, 1600);
  };
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      done(true);
    } else {
      // 非 https 环境（如 http://局域网 IP）下的兜底
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      done(document.execCommand('copy'));
      document.body.removeChild(ta);
    }
  } catch (e) {
    done(false);
  }
}

$('copyGenBtn').addEventListener('click', () => {
  if (!state.genResult) return;
  copyText(state.genResult.instanceText, $('copyGenBtn'));
});

/* ---------------- 兼容性反例搜索 ---------------- */

const CE_NOTE_LABEL = {
  old: '旧版',
  new: '新版',
};
/** 与后端一致的候选上限（仅用于未找到时的文案） */
const MAX_CE_CANDIDATES = 500;

$('ceBtn').addEventListener('click', runCounterexample);

async function runCounterexample() {
  hideCeError();
  const btn = $('ceBtn');
  btn.disabled = true;
  btn.textContent = '搜索中…';
  try {
    const resp = await fetch('/api/counterexample', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        oldSchema: $('oldInput').value,
        newSchema: $('newInput').value,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      state.ceResult = null;
      $('ceResult').hidden = true;
      showCeError(data.error || '反例搜索失败');
      return;
    }
    state.ceResult = data;
    renderCounterexample();
  } catch (e) {
    showCeError('请求失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '搜索兼容性反例';
  }
}

function renderCounterexample() {
  const data = state.ceResult;
  const box = $('ceResult');
  box.innerHTML = '';
  box.hidden = false;

  if (data.found) {
    box.appendChild(renderCeFound(data));
  } else {
    box.appendChild(renderCeNotFound(data));
  }
  if (data.notes && data.notes.length) box.appendChild(renderCeNotes(data.notes));
}

function renderCeFound(data) {
  const wrap = document.createElement('div');
  wrap.className = 'ce-found';

  const status = document.createElement('div');
  status.className = 'ce-status';
  status.textContent = '✗ 找到兼容性反例：该实例旧版接收、新版拒绝';
  wrap.appendChild(status);

  const summary = document.createElement('div');
  summary.className = 'ce-summary';
  summary.textContent = data.summary;
  wrap.appendChild(summary);

  const head = document.createElement('div');
  head.className = 'ce-instance-head';
  const title = document.createElement('span');
  title.className = 'ce-instance-title';
  title.textContent = '可复制的实例 JSON（可直接拿去复现升级破坏）';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn tiny';
  copyBtn.type = 'button';
  copyBtn.textContent = '复制 JSON';
  copyBtn.addEventListener('click', () => copyText(data.instanceText, copyBtn));
  head.appendChild(title);
  head.appendChild(copyBtn);
  wrap.appendChild(head);

  const pre = document.createElement('pre');
  pre.className = 'ce-output';
  pre.textContent = data.instanceText;
  wrap.appendChild(pre);

  if (data.newErrors && data.newErrors.length) {
    const errsTitle = document.createElement('div');
    errsTitle.className = 'ce-newerrors-title';
    errsTitle.textContent = '新版失败路径（Ajv draft-07 复验）：';
    wrap.appendChild(errsTitle);

    const ul = document.createElement('ul');
    ul.className = 'verify-errors';
    for (const er of data.newErrors) {
      const li = document.createElement('li');
      const loc = document.createElement('span');
      loc.className = 'verify-ptr';
      loc.textContent = er.instancePath || '（根节点）';
      loc.title = '实例 JSON Pointer';
      const msg = document.createElement('span');
      msg.className = 'verify-msg';
      msg.textContent = er.message;
      li.appendChild(loc);
      li.appendChild(msg);
      if (er.schemaPath) {
        const sp = document.createElement('span');
        sp.className = 'verify-schema-ptr';
        sp.textContent = 'schema' + er.schemaPath;
        sp.title = 'Schema JSON Pointer（关键字位置）';
        li.appendChild(sp);
      }
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
  }

  return wrap;
}

function renderCeNotFound(data) {
  const wrap = document.createElement('div');
  wrap.className = 'ce-notfound';

  const status = document.createElement('div');
  status.className = 'ce-status';
  status.textContent = '未找到反例（不等于兼容）';
  wrap.appendChild(status);

  const summary = document.createElement('div');
  summary.className = 'ce-summary';
  summary.textContent = data.summary;
  wrap.appendChild(summary);

  const meta = document.createElement('div');
  meta.className = 'ce-summary';
  meta.textContent =
    `已复验旧版合法候选 ${data.candidatesChecked} 个（枚举尝试 ${data.candidatesAttempted} 个）；` +
    (data.truncated
      ? `达到 ${MAX_CE_CANDIDATES} 个旧版合法候选的检查上限后停止，候选空间未穷尽。`
      : '支持范围内的候选空间已穷尽。');
  wrap.appendChild(meta);

  return wrap;
}

function renderCeNotes(notes) {
  const frag = document.createDocumentFragment();
  const title = document.createElement('div');
  title.className = 'ce-notes-title';
  title.textContent = '搜索限制与范围外断言（对应候选空间未被枚举，不能据此宣称兼容）：';
  frag.appendChild(title);

  const ul = document.createElement('ul');
  ul.className = 'ce-notes';
  for (const note of notes) {
    const li = document.createElement('li');

    const tag = document.createElement('span');
    tag.className = 'ce-side-tag ' + note.side;
    tag.textContent = CE_NOTE_LABEL[note.side] || note.side;
    li.appendChild(tag);

    if (note.keyword) {
      const kw = document.createElement('span');
      kw.className = 'ce-note-kw';
      kw.textContent = note.label || note.keyword;
      li.appendChild(kw);
    }

    if (note.schemaPath) {
      const sp = document.createElement('span');
      sp.className = 'ce-note-path';
      sp.textContent = '#' + note.schemaPath;
      sp.title = humanPointer(note.schemaPath);
      li.appendChild(sp);
    }

    const msg = document.createElement('span');
    msg.className = 'ce-note-msg';
    msg.textContent = note.message;
    li.appendChild(msg);

    ul.appendChild(li);
  }
  frag.appendChild(ul);
  return frag;
}

/** 任一 Schema 改变后，之前的反例立即失效 */
function clearCounterexample(reason) {
  if (!state.ceResult && $('ceResult').hidden && $('ceErrorBox').hidden) return;
  state.ceResult = null;
  $('ceResult').hidden = true;
  $('ceResult').innerHTML = '';
  if (reason) showCeError(reason + '，之前的反例搜索结果已清空。', true);
}

function showCeError(msg, muted) {
  const box = $('ceErrorBox');
  box.textContent = msg;
  box.classList.toggle('muted-note', !!muted);
  box.hidden = false;
}
function hideCeError() {
  $('ceErrorBox').hidden = true;
  $('ceErrorBox').classList.remove('muted-note');
}
