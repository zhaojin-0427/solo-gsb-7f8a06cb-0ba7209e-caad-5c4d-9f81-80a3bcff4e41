'use strict';

/**
 * counterexample.js —— 兼容性反例搜索
 *
 * 依据当前旧、新两份 draft-07 Schema，自动构造并搜索一条
 * 「旧版接收、新版拒绝」的 JSON 实例，让用户不提供存量数据也能直接复现升级破坏。
 *
 * 做法：
 *   1. 旧、新 Schema 各由一个独立 Ajv 实例编译（互不污染 $id / 缓存）；
 *   2. 沿旧 Schema 做受限枚举，惰性产出候选实例——不只生成「默认最小样本」，
 *      而是按 基线 → 逐位置单变异（OFAT，轮询保证每个可选字段 / 数组长度 /
 *      枚举后续取值 / 边界值都被遍历到）→ 多位置组合 的顺序产出；
 *   3. 每个候选都先用旧版校验器完整复验，通过后再用新版校验器完整复验，
 *      第一个「旧通过 / 新失败」的候选即为反例；
 *   4. 最多检查 MAX_OLD_VALID（500）个旧版合法候选；超出或遇范围外断言时
 *      只如实报告搜索限制与对应 Schema 路径，绝不据此宣称兼容。
 *
 * 枚举支持的断言范围（与样本生成器一致）：
 *   文档内本地 $ref、布尔 Schema、单一 type、对象 properties / required、
 *   const / enum、数组单一 items / minItems、字符串 minLength、整数上下界；
 *   additionalProperties 的布尔形式按语义遵守（旧版允许额外字段时枚举一个
 *   额外属性槽，以覆盖新版改为 false / 删除属性的破坏）。
 * 其余断言（pattern、format、组合关键字、类型数组、元组 items、number 上的
 * minimum/maximum 等）无法可靠枚举：不放弃搜索（候选仍以真实 Schema 经
 * 双版 Ajv 复验，找到的反例始终可靠），但在新旧两侧分别记录「范围外断言」
 * 及其 Schema 路径；未找到反例时这些限制一并展示。
 */

const Ajv = require('ajv');
const { isLocalRef, resolvePointer, encodeToken } = require('./refs');
const { precheckLocalRefs, normalizeErrors } = require('./verify');

/** 最多对多少个「旧版合法候选」做新版复验（题面上限） */
const MAX_OLD_VALID = 500;
/** 构造候选总数硬上限（含旧版复验未通过、去重前的产出），防止枚举爆炸 */
const MAX_BUILT = 4000;
/** 单个 enum 节点最多按顺序枚举多少个取值，超出记录搜索限制 */
const MAX_ENUM_VALUES = 100;
/** minItems 超过该值时不展开数组（仅记录限制），避免万级位置槽 */
const MAX_ITEMS_SLOTS = 200;
/** 额外属性槽尝试的代表取值数（旧版 additionalProperties 为 schema 时由 Ajv 复验筛除） */
const EXTRA_VALUES = [null, 0, '', false];
/** 新版失败原因最多回传多少条（allErrors 全量计算，仅截断展示） */
const MAX_NEW_ERRORS = 20;

/** 「该位置缺席」哨兵：可选字段缺席、数组尾元素缺席（长度取 minItems） */
const ABSENT = Symbol('absent');

class CounterexampleError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CounterexampleError';
    this.code = code || 'counterexample_error';
  }
}

/** 注解 / 结构性关键字：不约束实例内容，扫描与枚举都忽略 */
const IGNORE_KEYS = new Set([
  '$id', '$schema', '$comment', '$defs', 'definitions',
  'title', 'description', 'default', 'examples',
  'readOnly', 'writeOnly', 'deprecated',
  'contentEncoding', 'contentMediaType',
]);

/** 枚举可建模的断言关键字 */
const SUPPORTED_KEYS = new Set([
  '$ref', 'type', 'const', 'enum',
  'properties', 'required', 'additionalProperties',
  'items', 'minItems', 'minLength', 'minimum', 'maximum',
]);

/** 范围外断言关键字的中文名（扫描报告用） */
const KW_LABEL = {
  multipleOf: 'multipleOf（倍数约束）',
  exclusiveMinimum: 'exclusiveMinimum（排他下限）',
  exclusiveMaximum: 'exclusiveMaximum（排他上限）',
  maxLength: 'maxLength（最大长度）',
  pattern: 'pattern（正则模式）',
  format: 'format（格式）',
  maxItems: 'maxItems（最大元素数）',
  uniqueItems: 'uniqueItems（元素唯一性）',
  contains: 'contains（包含元素）',
  minProperties: 'minProperties（最少属性数）',
  maxProperties: 'maxProperties（最多属性数）',
  patternProperties: 'patternProperties（按模式匹配属性）',
  dependencies: 'dependencies（属性依赖）',
  propertyNames: 'propertyNames（属性名约束）',
  allOf: 'allOf（全满足组合）',
  anyOf: 'anyOf（任一满足组合）',
  oneOf: 'oneOf（择一满足组合）',
  not: 'not（取反）',
  if: 'if（条件分支）',
  then: 'then（条件分支）',
  else: 'else（条件分支）',
};

/* ------------------------------ 入口 ------------------------------ */

/**
 * 搜索兼容性反例。
 * @param {object} oldRoot 旧 Schema（已 JSON.parse）
 * @param {object} newRoot 新 Schema（已 JSON.parse）
 */
function findCounterexample(oldRoot, newRoot) {
  // 0) 外部引用在编译前拦截（不配置任何远程加载器）
  precheckLocalRefs(oldRoot);
  precheckLocalRefs(newRoot);

  // 1) 旧、新各用独立 Ajv 实例编译
  const oldValidate = compileSchema(createAjv(), oldRoot, '旧');
  const newValidate = compileSchema(createAjv(), newRoot, '新');

  // 2) 扫描新旧两侧「范围外断言」及其 Schema 路径（按路径去重）
  const oldCtx = makeCtx(oldRoot, '旧');
  const newCtx = makeCtx(newRoot, '新');
  scanLimitations(oldRoot, '', oldCtx);
  scanLimitations(newRoot, '', newCtx);

  // 旧根恒 false：不存在任何旧版合法实例，无从搜起
  if (oldRoot === false) {
    oldCtx.addNote('', '旧 Schema 根节点恒为 false，任何实例都无法通过旧版校验，不存在「旧版接收」的候选。');
  }

  // 3) 受限枚举 + 双版完整复验
  let checked = 0;       // 旧版复验通过、并已用新版复验的候选数
  let built = 0;         // 枚举器产出（去重前）候选数
  let truncated = false; // 是否在遍历完候选空间前触顶
  const seen = new Set();

  if (oldRoot !== false) {
    // ancestorRefs 为「当前展开分支」上的 $ref 目标集合（不可变、按分支传递，
    // 惰性生成器暂停 / 恢复时不会被兄弟槽污染）
    const gen = planValue(oldRoot, '', oldCtx, new Set());
    for (const instance of gen) {
      built++;
      if (built > MAX_BUILT) {
        truncated = true;
        oldCtx.addNote('', `候选组合过多，构造 ${MAX_BUILT} 个候选后停止，未覆盖全部组合。`);
        break;
      }

      let key;
      try { key = JSON.stringify(instance); } catch (e) { continue; }
      if (seen.has(key)) continue;
      seen.add(key);

      // 每个候选：先旧版完整复验
      if (!oldValidate(instance)) continue;
      checked++;

      // 旧版合法候选：再用新版完整复验
      if (!newValidate(instance)) {
        const allErrors = normalizeErrors(newValidate.errors || [], instance);
        return {
          found: true,
          instance,
          instanceText: JSON.stringify(instance, null, 2),
          checked,
          built,
          truncated: false,
          newErrors: allErrors.slice(0, MAX_NEW_ERRORS),
          newErrorCount: allErrors.length,
          newErrorsTruncated: allErrors.length > MAX_NEW_ERRORS,
          limitations: { old: oldCtx.limitations, new: newCtx.limitations },
          notes: { old: oldCtx.notes, new: newCtx.notes },
          candidateLimit: MAX_OLD_VALID,
        };
      }

      if (checked >= MAX_OLD_VALID) {
        truncated = true;
        oldCtx.addNote('', `已检查满 ${MAX_OLD_VALID} 个旧版合法候选，剩余候选未继续检查。`);
        break;
      }
    }
  }

  // 4) 未找到：只陈述事实与搜索边界，绝不下「兼容」结论
  return {
    found: false,
    checked,
    built,
    truncated,
    limitations: { old: oldCtx.limitations, new: newCtx.limitations },
    notes: { old: oldCtx.notes, new: newCtx.notes },
    candidateLimit: MAX_OLD_VALID,
  };
}

function makeCtx(root, side) {
  return {
    root,
    side,
    limitations: [],
    _limitSeen: new Set(),
    notes: [],
    _noteSeen: new Set(),
    addLimit(schemaPath, keyword, message) {
      const k = schemaPath + '␟' + keyword;
      if (this._limitSeen.has(k)) return;
      this._limitSeen.add(k);
      this.limitations.push({ schemaPath, keyword, message });
    },
    addNote(schemaPath, message) {
      const k = schemaPath + '␟' + message;
      if (this._noteSeen.has(k)) return;
      this._noteSeen.add(k);
      this.notes.push({ schemaPath, message });
    },
  };
}

function createAjv() {
  return new Ajv({
    allErrors: true,
    strict: false,
    logger: { log() {}, warn() {}, error() {}, debug() {} },
  });
}

function compileSchema(ajvInstance, root, label) {
  try {
    return ajvInstance.compile(root);
  } catch (e) {
    throw new CounterexampleError(
      `${label} Schema 编译失败（Ajv draft-07），无法搜索反例：${e.message}`,
      'invalid_schema'
    );
  }
}

/* ------------------------------ 范围外断言扫描 ------------------------------ */

/**
 * 全树扫描枚举范围外的断言：只沿「Schema 可达位置」递归（经本地 $ref 解析到
 * 目标定义，按目标路径去重），不进入 enum/const 等实例值。
 * 范围外断言不阻断搜索（候选仍以真实 Schema 经 Ajv 双版复验，结论可靠），
 * 但未找到反例时必须如实展示这些位置。
 */
function scanLimitations(node, schemaPath, ctx, seenPaths) {
  seenPaths = seenPaths || new Set();
  if (node === true || node === false || node === null || typeof node !== 'object') return;

  // $ref：draft-07 下兄弟关键字忽略，只扫目标定义（同一目标路径只扫一次）
  if (!Array.isArray(node) && typeof node.$ref === 'string') {
    if (!isLocalRef(node.$ref)) return; // 已由 precheckLocalRefs 拦截
    const target = node.$ref === '#' ? '' : node.$ref.slice(1);
    if (seenPaths.has(target)) return;
    seenPaths.add(target);
    scanLimitations(resolvePointer(ctx.root, node.$ref), target, ctx, seenPaths);
    return;
  }

  if (seenPaths.has(schemaPath)) return;
  seenPaths.add(schemaPath);

  if (Array.isArray(node)) {
    node.forEach((item, i) => scanLimitations(item, `${schemaPath}/${i}`, ctx, seenPaths));
    return;
  }

  const add = (keyword, message) => ctx.addLimit(schemaPath, keyword, message);

  // 形态特殊的「部分支持」写法
  if (Array.isArray(node.type)) {
    add('type', 'type 为类型数组（如 ["string","null"]），搜索器只支持单一 type，该节点的跨类型取值未枚举。');
  }
  if (Array.isArray(node.items)) {
    add('items', 'items 为元组数组形式，搜索器仅支持单一 items schema，各位置元素的取值差异未枚举。');
  }
  if (node.additionalProperties !== undefined &&
      typeof node.additionalProperties === 'object' &&
      node.additionalProperties !== null &&
      !Array.isArray(node.additionalProperties)) {
    add('additionalProperties', 'additionalProperties 为 schema 形式，搜索器仅枚举少量代表取值的额外属性，未能覆盖该约束拒绝的全部取值。');
  }

  // minimum / maximum 只对 integer 建模（number 的取值空间无法离散枚举）
  const effectiveType = resolveType(node);
  if ((node.minimum !== undefined || node.maximum !== undefined) && effectiveType !== 'integer') {
    const key = node.minimum !== undefined ? 'minimum' : 'maximum';
    add(key, `${KW_LABEL[key]} 作用于非 integer 节点（当前推断类型：${effectiveType || '任意'}），数值边界取值未枚举。`);
  }

  // 其余范围外断言关键字
  for (const key of Object.keys(node)) {
    if (SUPPORTED_KEYS.has(key) || IGNORE_KEYS.has(key)) continue;
    add(key, `${KW_LABEL[key] || `关键字 "${key}"`} 不在反例搜索的枚举范围内，该约束相关的取值差异未枚举。`);
  }

  // 深入可建模的结构子树（组合 / 元组等容器自身已记录限制，不再深入）
  if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
    for (const name of Object.keys(node.properties)) {
      scanLimitations(
        node.properties[name],
        `${schemaPath}/properties/${encodeToken(name)}`,
        ctx, seenPaths
      );
    }
  }
  if (node.items !== undefined) {
    if (Array.isArray(node.items)) {
      node.items.forEach((item, i) => scanLimitations(item, `${schemaPath}/items/${i}`, ctx, seenPaths));
    } else if (node.items && typeof node.items === 'object') {
      scanLimitations(node.items, `${schemaPath}/items`, ctx, seenPaths);
    }
  }
  if (node.additionalProperties &&
      typeof node.additionalProperties === 'object' &&
      !Array.isArray(node.additionalProperties)) {
    scanLimitations(node.additionalProperties, `${schemaPath}/additionalProperties`, ctx, seenPaths);
  }
}

/* ------------------------------ 候选枚举 ------------------------------ */

/**
 * 节点候选枚举器（惰性 generator）：产出顺序为
 *   基线值 → 该节点内各选择点的单变异（轮询）→ 多点组合，
 * 保证可选字段、枚举后续取值、整数 / 长度边界不会被「默认样本」掩盖。
 *
 * @param {Set<string>} ancestorRefs 当前展开分支上已进入的 $ref 目标路径
 * @yields {any} 候选值（同值可能重复，由顶层去重）
 */
function* planValue(node, schemaPath, ctx, ancestorRefs) {
  // 布尔 Schema
  if (node === true) { yield null; return; }
  if (node === false) return; // 恒假：无候选（必填位置由上层记录限制）
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return;

  // $ref：解析到文档内目标后继续；引用环（含可选路径上的自引用）不展开
  if (Object.prototype.hasOwnProperty.call(node, '$ref')) {
    if (typeof node.$ref !== 'string' || !isLocalRef(node.$ref)) return; // 编译预检已拦截
    const target = node.$ref === '#' ? '' : node.$ref.slice(1);
    if (ancestorRefs.has(target)) {
      ctx.addNote(target, '$ref 展开路径上出现引用环（#' + target + ' 在当前分支再次出现），环内结构不展开枚举，仅枚举到环前的取值（如空数组）；必填路径上的环则无法构造该对象。');
      return;
    }
    const nextRefs = new Set(ancestorRefs).add(target);
    yield* planValue(resolvePointer(ctx.root, node.$ref), target, ctx, nextRefs);
    return;
  }

  // const：固定值（是否旧版合法由 Ajv 复验裁决，枚举器不做假设）
  if (Object.prototype.hasOwnProperty.call(node, 'const')) {
    yield node.const;
    return;
  }

  // enum：按数组顺序逐个产出后续取值（封顶 + 记录限制），不猜其内部结构
  if (Array.isArray(node.enum)) {
    const total = node.enum.length;
    for (let i = 0; i < total; i++) {
      if (i >= MAX_ENUM_VALUES) {
        ctx.addLimit(`${schemaPath}/enum`, 'enum',
          `enum 共 ${total} 个取值，仅按顺序枚举前 ${MAX_ENUM_VALUES} 个，第 ${MAX_ENUM_VALUES + 1} 个及之后的取值未检查。`);
        break;
      }
      yield node.enum[i];
    }
    return;
  }

  const type = resolveType(node);

  if (type === 'object') { yield* planObject(node, schemaPath, ctx, ancestorRefs); return; }
  if (type === 'array') { yield* planArray(node, schemaPath, ctx, ancestorRefs); return; }
  if (type === 'string') {
    const n = intBound(node.minLength, 0);
    yield 'a'.repeat(n);       // 边界：恰好 minLength
    yield 'a'.repeat(n + 1);   // 邻接边界（如新版 maxLength 收紧到 n 时由复验捕获）
    return;
  }
  if (type === 'integer') {
    for (const v of integerValues(node)) yield v;
    return;
  }
  if (type === 'number') {
    yield 0;
    yield 0.5; // 新版若收窄为 integer，0.5 即被拒
    return;
  }
  if (type === 'boolean') { yield false; yield true; return; }
  if (type === 'null') { yield null; return; }
  if (type) return; // 未知 type：Ajv 编译期已拦截

  // 无可建模约束（{} / 仅注解）：null 是合法代表值
  yield null;
}

/** 整数值候选：最接近零者优先，随后给出下界、下界+1、上界、上界-1 等边界 */
function integerValues(node) {
  let lo = null;
  let hi = null;
  if (typeof node.minimum === 'number') lo = Math.ceil(node.minimum);
  if (typeof node.maximum === 'number') hi = Math.floor(node.maximum);
  if (lo !== null && hi !== null && lo > hi) return [];

  const vals = [];
  const push = (v) => {
    if (!Number.isInteger(v)) return;
    if (lo !== null && v < lo) return;
    if (hi !== null && v > hi) return;
    if (!vals.includes(v)) vals.push(v);
  };

  let base;
  if (lo !== null && lo > 0) base = lo;
  else if (hi !== null && hi < 0) base = hi;
  else base = 0;

  push(base);
  if (lo !== null) { push(lo); push(lo + 1); }
  if (hi !== null) { push(hi); push(hi - 1); }
  if (lo === null) push(base - 1);
  if (hi === null) push(base + 1);
  return vals;
}

/**
 * 对象枚举：必填字段为固定槽，可选字段为「缺席 / 各候选值」槽。
 * 旧版允许额外属性（additionalProperties 不为 false）时补一个额外属性槽，
 * 以覆盖新版把 additionalProperties 改为 false、或删除属性声明的破坏；
 * 额外属性的取值以少量代表值尝试，能否通过旧版由 Ajv 复验裁决。
 * 槽位组合统一走 combineSlots（基线 → 轮询单变异 → 组合）。
 */
function* planObject(node, schemaPath, ctx, ancestorRefs) {
  const required = Array.isArray(node.required) ? [...new Set(node.required)] : [];
  const props = node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)
    ? node.properties
    : null;

  const slotDefs = [];

  for (const name of required) {
    const childPath = `${schemaPath}/properties/${encodeToken(name)}`;
    const declared = props && Object.prototype.hasOwnProperty.call(props, name);
    if (!declared) {
      if (node.additionalProperties === true) {
        slotDefs.push({ name, optional: false, describeName: `必填字段 "${name}"`, makeIter: () => single(null) });
      } else {
        ctx.addLimit(`${schemaPath}/required`, 'required',
          `必填字段 "${name}" 未在 properties 中声明、且 additionalProperties 不允许补出该字段，无法构造该对象的候选，该节点后续取值全部跳过。`);
        return;
      }
    } else {
      slotDefs.push({
        name,
        optional: false,
        describeName: `必填字段 "${name}"`,
        makeIter: () => planValue(props[name], childPath, ctx, ancestorRefs),
      });
    }
  }

  if (props) {
    for (const name of Object.keys(props)) {
      if (required.includes(name)) continue;
      const childPath = `${schemaPath}/properties/${encodeToken(name)}`;
      slotDefs.push({
        name,
        optional: true,
        describeName: `可选字段 "${name}"`,
        makeIter: () => planValue(props[name], childPath, ctx, ancestorRefs),
      });
    }
  }

  // 额外属性槽（additionalProperties:false 时旧版本身拒绝额外字段，不补）
  if (node.additionalProperties !== false) {
    slotDefs.push({
      name: extraPropertyName(props),
      optional: true,
      describeName: '额外属性（properties 之外）',
      makeIter: () => fromList(EXTRA_VALUES),
    });
  }

  const build = (vec) => {
    const out = {};
    vec.forEach((v, i) => {
      if (v !== ABSENT) out[slotDefs[i].name] = v;
    });
    return out;
  };

  yield* combineSlots(slotDefs, build, ctx, schemaPath);
}

/** 挑一个不与已声明属性冲突的额外属性名 */
function extraPropertyName(props) {
  const base = '__extra__';
  let name = base;
  let k = 1;
  while (props && Object.prototype.hasOwnProperty.call(props, name)) {
    name = base + k++;
  }
  return name;
}

/**
 * 数组枚举：位置 0..minItems-1 为必填元素槽，尾部多一个「缺席 / 存在」槽
 * （长度恰好取 minItems 或 minItems+1，覆盖空 / 非空与长度邻接边界）。
 */
function* planArray(node, schemaPath, ctx, ancestorRefs) {
  const n = intBound(node.minItems, 0);
  const items = node.items;

  if (n > 0 && !(items && typeof items === 'object' && !Array.isArray(items))) {
    ctx.addLimit(`${schemaPath}/minItems`, 'minItems',
      `minItems 要求至少 ${n} 个元素，但没有可枚举的单一 items schema，该数组无法构造候选，该节点后续取值全部跳过。`);
    return;
  }
  if (n > MAX_ITEMS_SLOTS) {
    ctx.addLimit(`${schemaPath}/minItems`, 'minItems',
      `minItems=${n} 过大（>${MAX_ITEMS_SLOTS}），为控制候选规模不枚举该数组，该节点后续取值全部跳过。`);
    return;
  }

  const slotDefs = [];
  for (let i = 0; i < n; i++) {
    slotDefs.push({
      name: String(i),
      optional: false,
      describeName: `数组位置 [${i}]`,
      makeIter: () => planValue(items, `${schemaPath}/items`, ctx, ancestorRefs),
    });
  }
  // 尾槽缺席 => 长度 n；存在 => 长度 n+1
  if (items && typeof items === 'object' && !Array.isArray(items)) {
    slotDefs.push({
      name: String(n),
      optional: true,
      describeName: `数组位置 [${n}]（超出 minItems 的邻接元素）`,
      makeIter: () => planValue(items, `${schemaPath}/items`, ctx, ancestorRefs),
    });
  }

  const build = (vec) => {
    const arr = [];
    for (const v of vec) {
      if (v === ABSENT) break; // 只允许前缀存在：尾槽缺席即长度 n
      arr.push(v);
    }
    return arr;
  };

  yield* combineSlots(slotDefs, build, ctx, schemaPath);
}

/**
 * 通用槽位组合器（惰性）：
 *   1. 基线：必填槽取各自第一个候选，可选槽缺席；
 *   2. 轮询单变异（OFAT）：每轮依次让每个槽前进一步、其余保持基线，
 *      从而在候选上限内公平遍历所有可选字段 / 数组位置 / 枚举后续值 / 边界；
 *   3. 多槽组合：基于已拉取到的候选域做笛卡尔积（跳过基线与单变异）。
 *
 * 每个槽的迭代器都「按需拉取」：永不提前展开未消费的可选子树。
 */
function* combineSlots(slotDefs, build, ctx, schemaPath) {
  const states = slotDefs.map((d) => {
    const it = d.makeIter();
    const first = it.next();
    return { d, it, cache: first.done ? [] : [first.value], done: first.done };
  });

  // 必填槽一个候选都拉不出（恒 false / 必填引用环 / 矛盾边界等）=> 整条组合放弃
  for (const st of states) {
    if (!st.d.optional && st.done) {
      ctx.addLimit(schemaPath, 'required',
        `必填位置 ${st.d.describeName} 在支持范围内构造不出任何候选值（恒 false、必填 $ref 环或矛盾边界等），该节点候选全部跳过。`);
      return;
    }
  }

  const base = states.map((st) => (st.d.optional ? ABSENT : st.cache[0]));
  yield build(base);

  // 轮询单变异
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let i = 0; i < states.length; i++) {
      const st = states[i];
      if (st.done) continue;
      const nxt = st.it.next();
      if (nxt.done) { st.done = true; continue; }
      st.cache.push(nxt.value);
      progressed = true;
      const v = base.slice();
      v[i] = nxt.value;
      yield build(v);
    }
  }

  // 可选槽缺席（域首元素）+ 已拉取到的候选；必填槽即其候选域
  const domains = states.map((st) => (st.d.optional ? [ABSENT, ...st.cache] : st.cache.slice()));
  if (domains.some((d) => d.length === 0)) return;

  // 笛卡尔积（末槽最快），只产出相对基线偏离 ≥2 个槽的组合
  const total = domains.reduce((acc, d) => acc * d.length, 1);
  for (let radix = 0; radix < total; radix++) {
    const vec = [];
    let r = radix;
    let deviations = 0;
    for (let i = 0; i < domains.length; i++) {
      const d = domains[i];
      vec[i] = d[r % d.length];
      r = Math.floor(r / d.length);
      if (vec[i] !== base[i]) deviations++;
    }
    if (deviations >= 2) yield build(vec);
  }
}

function* single(v) {
  yield v;
}

function* fromList(list) {
  for (const v of list) yield v;
}

/* ------------------------------ 小工具 ------------------------------ */

/**
 * 取用于枚举的类型（与 generate.js 同口径）：
 *   显式单一 type 优先；无 type 时按 properties/required、items/minItems 推断；
 *   推断不出返回 null（任意值，枚举器给 null 代表值）。
 */
function resolveType(node) {
  if (Object.prototype.hasOwnProperty.call(node, 'type')) {
    if (typeof node.type === 'string') return node.type;
    return null; // 类型数组已在扫描阶段记录
  }
  if (node.properties !== undefined || node.required !== undefined) return 'object';
  if (node.items !== undefined || node.minItems !== undefined) return 'array';
  return null;
}

function intBound(v, fallback) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(0, Math.ceil(v));
}

module.exports = {
  findCounterexample,
  CounterexampleError,
  MAX_OLD_VALID,
  MAX_BUILT,
  MAX_ENUM_VALUES,
};
