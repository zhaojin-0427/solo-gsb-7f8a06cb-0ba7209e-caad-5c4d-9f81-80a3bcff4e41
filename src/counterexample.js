'use strict';

/**
 * counterexample.js —— 兼容性反例搜索
 *
 * 在比对页依据当前旧、新两份 draft-07 Schema，自动搜索一条
 * 「旧版接收、新版拒绝」的 JSON 实例，让用户无需先提供存量数据即可
 * 直接复现升级破坏。
 *
 * 搜索方式：在旧版 Schema 的「受支持子集」上做有界、有偏向的候选枚举，
 *   - 遍历对象的选填字段（按子集大小：不填 → 单个选填 → 两个 …）
 *   - 必填字段也逐一枚举非默认取值（覆盖必填 enum 缩值等变化）
 *   - enum 按数组顺序逐个尝试（含首个默认值之后的后续取值）
 *   - 整数枚举最接近零值与 minimum / maximum 上下界及附近小值
 *   - 字符串枚举 minLength 边界及其后续长度
 *   - 数组枚举 minItems 边界及其后续长度
 * 每个候选都由两个**互相独立的 Ajv 实例**编译出的旧、新校验器
 * 完整复验：旧版通过且新版失败即为反例。
 *
 * 支持范围：文档内本地 $ref、布尔 Schema、单一 type、对象 properties 与
 * required、const / enum、数组单一 items 与 minItems、字符串 minLength、
 * 整数 minimum / maximum（与 generate.js 口径一致）。范围外断言（pattern、
 * format、multipleOf、type 数组、items 元组等）不参与候选构造，但会
 * 逐条记录其所在 Schema 路径并随结果返回；无论是否找到反例，调用方都
 * 不得据此宣称两版 Schema 兼容。
 *
 * 上限：最多复验 500 个「旧版合法」候选（旧版复验失败的枚举尝试不计入，
 * 另设总尝试硬上限兜底）；可选递归结构按深度截断。
 */

const Ajv = require('ajv');
const { isLocalRef, resolvePointer, encodeToken } = require('./refs');
const { normalizeErrors, precheckLocalRefs } = require('./verify');

/** 最多按旧版复验通过计数检查的候选数（题面硬性要求） */
const MAX_VALID_CANDIDATES = 500;
/** 枚举尝试总硬上限（含旧版复验失败 / 范围外关键字过滤掉的候选） */
const MAX_TOTAL_ATTEMPTS = 5000;
/** 可选结构（含递归自引用）的最大展开深度 */
const MAX_DEPTH = 4;
/** 单个 enum 最多枚举的取值数（后续取值仍覆盖前 50 个） */
const MAX_ENUM_VALUES = 50;
/** 单个子节点最多收集的候选取值数 */
const MAX_CHILD_DOMAIN = 6;
/** 单个选填子集最多生成的字段取值组合数 */
const MAX_COMBOS_PER_SUBSET = 24;
/** 单节点最多枚举的选填字段子集数 */
const MAX_SUBSETS = 64;
/** 单节点最多枚举的数组长度种类 */
const MAX_LENGTHS = 3;
/** 新版失败路径最多回传条数 */
const MAX_NEW_ERRORS = 20;

class CounterError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CounterError';
    this.code = code || 'counterexample_error';
  }
}

/** 注解 / 结构性关键字：不约束实例内容，扫描时忽略（与 generate.js 一致） */
const IGNORE_KEYS = new Set([
  '$id', '$schema', '$comment', '$defs', 'definitions',
  'title', 'description', 'default', 'examples',
  'readOnly', 'writeOnly', 'deprecated',
  'contentEncoding', 'contentMediaType',
]);

/** 候选枚举显式支持的断言关键字 */
const SUPPORTED_KEYS = new Set([
  '$ref', 'type', 'const', 'enum',
  'properties', 'required', 'additionalProperties',
  'items', 'minItems', 'minLength', 'minimum', 'maximum',
]);

/** 范围外断言关键字的中文名，报告限制时逐项指出位置 */
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

/** 无类型 / 布尔 true 等任意值节点的通用候选域（不同 JSON 类型各一个代表） */
const UNIVERSAL_DOMAIN = [null, 0, '', false, true, {}];

/* ------------------------------ 入口 ------------------------------ */

/**
 * 搜索兼容性反例。
 * @param {object|boolean} oldRoot 旧 Schema（已 JSON.parse）
 * @param {object|boolean} newRoot 新 Schema（已 JSON.parse）
 * @returns {object} 搜索结果（found / not found 结构见 README）
 */
function searchCounterexample(oldRoot, newRoot) {
  // 0) 外部引用在编译前拦截（两份 Schema 都不允许）
  precheckLocalRefs(oldRoot);
  precheckLocalRefs(newRoot);

  // 1) 旧、新各由独立 Ajv 实例编译（$id 互不干扰，校验状态互不串扰）
  const silent = { log() {}, warn() {}, error() {}, debug() {} };
  let oldValidate;
  let newValidate;
  try {
    oldValidate = new Ajv({ allErrors: true, strict: false, logger: silent }).compile(oldRoot);
  } catch (e) {
    throw new CounterError('旧 Schema 未通过 Ajv（draft-07）编译，无法搜索反例：' + e.message, 'invalid_schema');
  }
  try {
    newValidate = new Ajv({ allErrors: true, strict: false, logger: silent }).compile(newRoot);
  } catch (e) {
    throw new CounterError('新 Schema 未通过 Ajv（draft-07）编译，无法搜索反例：' + e.message, 'invalid_schema');
  }

  const ctx = {
    root: oldRoot,
    notes: [],
    noteKeys: new Set(),
  };

  // 2) 范围外断言扫描：分别给出旧 / 新 Schema 侧的具体路径
  scanUnsupported(oldRoot, 'old', ctx);
  scanUnsupported(newRoot, 'new', ctx);

  // 3) 有界枚举候选，逐个用旧、新校验器完整复验
  let candidatesChecked = 0;
  let candidatesAttempted = 0;
  let truncated = false;

  for (const candidate of enumerateNode(oldRoot, '', ctx, [], 0, true)) {
    candidatesAttempted++;

    // 旧版复验：不通过的候选直接跳过（不计入 500 个合法候选预算）
    if (!oldValidate(candidate)) continue;
    candidatesChecked++;

    // 新版完整复验
    if (!newValidate(candidate)) {
      const newErrors = normalizeErrors(newValidate.errors, candidate).slice(0, MAX_NEW_ERRORS);
      return {
        found: true,
        truncated: false,
        exhausted: false,
        instance: candidate,
        instanceText: JSON.stringify(candidate, null, 2),
        candidatesChecked,
        candidatesAttempted,
        newErrors,
        notes: ctx.notes,
        summary:
          `在第 ${candidatesChecked} 个旧版合法候选上找到反例` +
          `（共枚举尝试 ${candidatesAttempted} 个候选）：该实例旧版校验通过、新版校验失败，` +
          '可直接复制复现本次升级破坏。',
      };
    }

    if (candidatesChecked >= MAX_VALID_CANDIDATES) {
      truncated = true;
      break;
    }
    if (candidatesAttempted >= MAX_TOTAL_ATTEMPTS) {
      truncated = true;
      break;
    }
  }

  return {
    found: false,
    truncated,
    exhausted: !truncated,
    instance: null,
    instanceText: '',
    candidatesChecked,
    candidatesAttempted,
    newErrors: [],
    notes: ctx.notes,
    summary: buildNotFoundSummary(candidatesChecked, candidatesAttempted, truncated, ctx.notes),
  };
}

function buildNotFoundSummary(checked, attempted, truncated, notes) {
  const parts = [];
  if (truncated) {
    parts.push(
      `已达搜索上限：复验 ${checked} 个旧版合法候选（共枚举尝试 ${attempted} 个）后仍未找到反例，` +
      '候选空间未穷尽。'
    );
  } else {
    parts.push(
      `支持范围内的候选空间已枚举完毕：共复验 ${checked} 个旧版合法候选` +
      `（枚举尝试 ${attempted} 个），全部也能通过新版校验，未找到反例。`
    );
  }
  if (notes.length) {
    parts.push(`此外搜索存在 ${notes.length} 处范围 / 结构限制（见下）。`);
  }
  parts.push('该结论不是子包含证明，不能据此宣称两版 Schema 兼容。');
  return parts.join('');
}

/* ------------------------------ 范围外断言扫描 ------------------------------ */

/**
 * 全文档扫描范围外断言，逐条记录 { side, keyword, schemaPath, label, message }。
 * 沿本地 $ref 深入定义节点（路径落在被指向的定义上），不进入 enum/const 等
 * 实例值；每个 Schema 路径只扫描一次。
 */
function scanUnsupported(root, side, ctx) {
  const visited = new Set();
  const sideLabel = side === 'old' ? '旧' : '新';

  const push = (label, message, schemaPath, keyword) => {
    const kw = keyword || label;
    addNote(ctx, {
      side,
      keyword: kw,
      schemaPath,
      label,
      message: `（${sideLabel}版 Schema）${message}`,
    });
  };

  const walk = (node, schemaPath) => {
    if (node === true || node === false || node === null || typeof node !== 'object') return;

    // 位置数组（理论上此入口只会遇到 schema 节点，保留兜底）
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${schemaPath}/${i}`));
      return;
    }

    if (typeof node.$ref === 'string') {
      if (!isLocalRef(node.$ref)) return; // 外部引用已由 precheckLocalRefs 拦截
      const target = node.$ref === '#' ? '' : node.$ref.slice(1);
      if (visited.has(target)) return;
      visited.add(target);
      let resolved;
      try {
        resolved = resolvePointer(root, node.$ref);
      } catch (e) {
        return; // 无法解析的引用会在 Ajv 编译期以 invalid_schema 报错
      }
      walk(resolved, target);
      return; // draft-07：$ref 兄弟关键字被忽略
    }

    if (visited.has(schemaPath)) return;
    visited.add(schemaPath);

    if (Array.isArray(node.type)) {
      push('type（类型数组）', '仅支持单一 type，类型数组节点的候选不参与枚举。', `${schemaPath}/type`, 'type');
    }
    if (Array.isArray(node.items)) {
      push('items（元组数组）', '数组仅支持单一 items schema，元组位置元素的候选不参与枚举。', `${schemaPath}/items`, 'items');
    }
    if (node.additionalProperties !== undefined &&
        typeof node.additionalProperties === 'object' &&
        node.additionalProperties !== null) {
      push('additionalProperties（schema 形式）',
        '仅支持 additionalProperties 的布尔形式，附加属性上的约束不参与枚举。',
        `${schemaPath}/additionalProperties`, 'additionalProperties');
    }

    const effectiveType = resolveType(node);
    if ((node.minimum !== undefined || node.maximum !== undefined) && effectiveType !== 'integer') {
      const key = node.minimum !== undefined ? 'minimum' : 'maximum';
      push(KW_LABEL[key], 'minimum / maximum 边界仅支持整数（integer）节点，该约束不参与候选构造。',
        `${schemaPath}/${key}`, key);
    }

    for (const key of Object.keys(node)) {
      if (SUPPORTED_KEYS.has(key) || IGNORE_KEYS.has(key)) continue;
      push(KW_LABEL[key] || `关键字 "${key}"`,
        '该断言不在反例搜索的支持范围内，对应候选空间不会被枚举。',
        `${schemaPath}/${key}`, key);
    }

    if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
      for (const name of Object.keys(node.properties)) {
        walk(node.properties[name], `${schemaPath}/properties/${encodeToken(name)}`);
      }
    }
    if (node.items && typeof node.items === 'object' && !Array.isArray(node.items)) {
      walk(node.items, `${schemaPath}/items`);
    }
    if (node.additionalProperties && typeof node.additionalProperties === 'object' &&
        !Array.isArray(node.additionalProperties)) {
      walk(node.additionalProperties, `${schemaPath}/additionalProperties`);
    }
  };

  walk(root, '');
}

/* ------------------------------ 候选枚举（生成器） ------------------------------ */

/**
 * 枚举某 Schema 节点上的候选值（惰性生成器）。
 * 约定：每个复合节点的第一个产出必为「最小实例」（与样本生成同口径），
 * 随后才是各维度的变体；这样 500 预算内优先覆盖单点破坏。
 *
 * @param {object|boolean} node Schema 节点
 * @param {string} schemaPath 节点在旧版文档内的 JSON Pointer
 * @param {object} ctx 搜索上下文（notes / root）
 * @param {string[]} refStack 必填展开链上的 $ref 目标（循环保护）
 * @param {number} depth 当前展开深度（可选递归截断）
 * @param {boolean} required 当前节点是否位于必填展开路径上
 */
function* enumerateNode(node, schemaPath, ctx, refStack, depth, required) {
  // 布尔 Schema
  if (node === true) {
    yield* UNIVERSAL_DOMAIN;
    return;
  }
  if (node === false) {
    addNote(ctx, {
      side: 'old',
      keyword: 'false schema',
      schemaPath,
      label: '布尔 Schema false',
      message: `（旧版 Schema）${pathPrefix(schemaPath)}恒为 false，不存在任何合法实例，该子树无候选可枚举。`,
    });
    return;
  }
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    addNote(ctx, {
      side: 'old',
      keyword: '__invalid_node__',
      schemaPath,
      label: '非法 Schema 节点',
      message: `（旧版 Schema）${pathPrefix(schemaPath)}节点必须是对象或布尔值，该子树跳过枚举。`,
    });
    return;
  }

  // $ref：draft-07 习惯下兄弟关键字忽略
  if (typeof node.$ref === 'string') {
    if (!isLocalRef(node.$ref)) {
      addNote(ctx, {
        side: 'old',
        keyword: '$ref',
        schemaPath,
        label: '外部引用',
        message: `（旧版 Schema）${pathPrefix(schemaPath)}为外部引用 "${node.$ref}"，候选枚举不支持（请先内联）。`,
      });
      return;
    }
    const target = node.$ref === '#' ? '' : node.$ref.slice(1);
    if (refStack.includes(target)) {
      if (required) {
        const chain = refStack.concat(target).map((p) => '#' + p).join(' → ');
        addNoteOnce(ctx, 'ref-cycle:' + target, {
          side: 'old',
          keyword: '$ref',
          schemaPath: target,
          label: '$ref 引用环',
          message:
            `（旧版 Schema）必填字段展开路径上存在 $ref 引用环（${chain}），` +
            '该路径不参与候选枚举（可选路径上的同环按深度截断）。',
        });
      }
      return;
    }
    let resolved;
    try {
      resolved = resolvePointer(ctx.root, node.$ref);
    } catch (e) {
      return; // 编译期会以 invalid_schema 报错
    }
    refStack.push(target);
    try {
      yield* enumerateNode(resolved, target, ctx, refStack, depth, required);
    } finally {
      refStack.pop();
    }
    return;
  }

  // const：固定值（嵌套约束由 Ajv 完整复验把关）
  if (Object.prototype.hasOwnProperty.call(node, 'const')) {
    yield node.const;
    return;
  }

  // enum：按数组顺序逐个尝试（明确覆盖首个默认值之后的后续取值）
  if (Array.isArray(node.enum)) {
    if (node.enum.length > MAX_ENUM_VALUES) {
      addNoteOnce(ctx, `enum-trunc:${schemaPath}`, {
        side: 'old',
        keyword: 'enum',
        schemaPath: `${schemaPath}/enum`,
        label: 'enum 取值过多',
        message:
          `（旧版 Schema）${pathPrefix(schemaPath)}enum 共 ${node.enum.length} 个取值，` +
          `搜索最多枚举前 ${MAX_ENUM_VALUES} 个，其余取值未覆盖。`,
      });
    }
    for (const v of node.enum.slice(0, MAX_ENUM_VALUES)) yield v;
    return;
  }

  const type = resolveType(node);
  if (type === 'object') {
    yield* enumObject(node, schemaPath, ctx, refStack, depth);
    return;
  }
  if (type === 'array') {
    yield* enumArray(node, schemaPath, ctx, refStack, depth);
    return;
  }
  yield* scalarDomain(type, node, schemaPath, ctx);
}

/* ------------------------------ 对象 ------------------------------ */

function* enumObject(node, schemaPath, ctx, refStack, depth) {
  const props = node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)
    ? node.properties
    : null;
  const requiredSet = new Set(Array.isArray(node.required) ? node.required : []);
  const requiredNames = Array.isArray(node.required) ? [...new Set(node.required)] : [];
  const optionalNames = props ? Object.keys(props).filter((n) => !requiredSet.has(n)) : [];

  // 必填字段中未在 properties 声明的：additionalProperties:true 时补 null，
  // 否则旧版自身无合法实例
  const missingRequired = requiredNames.filter((n) => !props || !Object.prototype.hasOwnProperty.call(props, n));
  if (missingRequired.length && node.additionalProperties !== true) {
    addNoteOnce(ctx, `missing-req:${schemaPath}`, {
      side: 'old',
      keyword: 'required',
      schemaPath: `${schemaPath}/required`,
      label: '必填字段无声明',
      message:
        `（旧版 Schema）${pathPrefix(schemaPath)}必填字段 ${missingRequired.map((n) => `"${n}"`).join('、')} ` +
        '未在 properties 中声明且 additionalProperties 不允许补出，旧版无合法实例可枚举。',
    });
    return;
  }

  // 旧版是否允许附加属性（draft-07 缺省为允许；schema 形式属范围外，仍尝试由 Ajv 过滤）
  const allowExtra = node.additionalProperties !== false;
  const extraName = props ? pickExtraKey(Object.keys(props)) : '_extra';

  const minimalOnly = depth >= MAX_DEPTH;

  // 选填子集：[]（不填选填）→ 单个选填 → 两个 …，数量有界
  const subsets = enumerateSubsets(optionalNames, MAX_SUBSETS);
  let subsetIndex = 0;

  for (const subset of subsets) {
    // 字段定义：必填在前（顺序稳定），选填按声明顺序
    const fieldDefs = [];
    for (const name of requiredNames) {
      if (props && Object.prototype.hasOwnProperty.call(props, name)) {
        fieldDefs.push({
          name,
          path: `${schemaPath}/properties/${encodeToken(name)}`,
          options: collectOptions(props[name], `${schemaPath}/properties/${encodeToken(name)}`,
            ctx, refStack, depth + 1, true, minimalOnly),
        });
      } else {
        fieldDefs.push({ name, path: `${schemaPath}/required`, options: [null] });
      }
    }
    for (const name of subset) {
      fieldDefs.push({
        name,
        path: `${schemaPath}/properties/${encodeToken(name)}`,
        options: collectOptions(props[name], `${schemaPath}/properties/${encodeToken(name)}`,
          ctx, refStack, depth + 1, false, minimalOnly),
      });
    }

    if (fieldDefs.some((f) => f.options.length === 0)) continue;

    let comboCount = 0;
    for (const vec of comboVectors(fieldDefs.map((f) => f.options))) {
      const obj = {};
      fieldDefs.forEach((f, i) => { obj[f.name] = f.options[vec[i]]; });
      yield obj;
      comboCount += 1;
      if (minimalOnly) break; // 深度截断：只产出最小实例
      if (comboCount >= MAX_COMBOS_PER_SUBSET) break;
    }

    // 空集组合过完后，尽早尝试「多一个附加属性」这一独立破坏维度
    if (subsetIndex === 0 && allowExtra) {
      const extraBase = {};
      fieldDefs.forEach((f) => { extraBase[f.name] = f.options[0]; });
      extraBase[extraName] = null;
      yield extraBase;
    }
    subsetIndex++;
  }
}

/* ------------------------------ 数组 ------------------------------ */

function* enumArray(node, schemaPath, ctx, refStack, depth) {
  const n = intBound(node.minItems, 0);
  const items = node.items;

  if (n > 0 && items === undefined) {
    addNoteOnce(ctx, `min-items-no-items:${schemaPath}`, {
      side: 'old',
      keyword: 'minItems',
      schemaPath: `${schemaPath}/minItems`,
      label: 'minItems 无 items',
      message:
        `（旧版 Schema）${pathPrefix(schemaPath)}minItems 要求至少 ${n} 个元素，` +
        '但未提供单一 items schema，无法枚举元素。',
    });
    return;
  }

  // 长度围绕 minItems 边界：n、n+1（n=0 时补 1、2，覆盖新版提高下限）
  let lengths = [...new Set([n, n + 1, n === 0 ? 2 : null].filter((v) => v !== null))];
  lengths = lengths.slice(0, MAX_LENGTHS);

  const minimalOnly = depth >= MAX_DEPTH;

  for (const len of lengths) {
    if (items === undefined) {
      if (len === 0) yield [];
      continue;
    }
    if (Array.isArray(items)) {
      // 元组数组属范围外断言（扫描已记录路径）：用 null 占位交由 Ajv 过滤
      yield new Array(len).fill(null);
      continue;
    }

    const lists = [];
    for (let i = 0; i < len; i++) {
      const opts = collectOptions(items, `${schemaPath}/items`, ctx, refStack, depth + 1, true, minimalOnly);
      if (opts.length === 0) {
        lists.length = 0;
        break;
      }
      lists.push(opts);
    }
    if (len > 0 && !lists.length) continue;
    if (len === 0) {
      // 长度 0 是 minItems 收紧时的关键边界候选，必须单独产出
      yield [];
      continue;
    }

    let comboCount = 0;
    for (const vec of comboVectors(lists)) {
      yield vec.map((choice, i) => lists[i][choice]);
      comboCount += 1;
      if (minimalOnly) break;
      if (comboCount >= MAX_COMBOS_PER_SUBSET) break;
    }
  }
}

/* ------------------------------ 标量取值域 ------------------------------ */

function* scalarDomain(type, node, schemaPath, ctx) {
  switch (type) {
    case 'string': {
      const min = intBound(node.minLength, 0);
      const out = [];
      // minLength 边界值及后续长度（新版若加长 minLength，边界值即反例）
      for (const len of [min, min + 1, min + 2]) {
        if (len < 0) continue;
        const s = 'a'.repeat(len);
        if (!out.includes(s)) out.push(s);
      }
      yield* out;
      return;
    }
    case 'integer': {
      let lo = null;
      let hi = null;
      if (typeof node.minimum === 'number') lo = Math.ceil(node.minimum);
      if (typeof node.maximum === 'number') hi = Math.floor(node.maximum);
      if (lo !== null && hi !== null && lo > hi) {
        addNoteOnce(ctx, `int-empty:${schemaPath}`, {
          side: 'old',
          keyword: 'minimum',
          schemaPath,
          label: '整数区间为空',
          message:
            `（旧版 Schema）${pathPrefix(schemaPath)}整数取值区间为空` +
            `（向上取整后的最小值 ${lo} 大于向下取整后的最大值 ${hi}），该节点无合法实例。`,
        });
        return;
      }
      // 最接近零的值（与样本生成器同口径），随后才是上下界与附近小值
      const nearZero = lo !== null && lo > 0 ? lo : hi !== null && hi < 0 ? hi : 0;
      const cands = [];
      const push = (v) => {
        if (!Number.isInteger(v)) return;
        if (lo !== null && v < lo) return;
        if (hi !== null && v > hi) return;
        if (!cands.includes(v)) cands.push(v);
      };
      push(nearZero);
      push(lo);
      push(hi);
      for (const v of [1, -1, 2, 1000, -1000]) push(v);
      yield* cands.slice(0, MAX_CHILD_DOMAIN);
      return;
    }
    case 'number':
      // 0.5 专门覆盖新版收紧为 integer；±1000 覆盖新版加上 / 收紧边界
      yield* [0, 1, -1, 0.5, 1000, -1000];
      return;
    case 'boolean':
      yield false;
      yield true;
      return;
    case 'null':
      yield null;
      return;
    default:
      // 无 type 且推断不出结构：任意值均可，跨类型各取一个代表
      yield* UNIVERSAL_DOMAIN;
  }
}

/* ------------------------------ 枚举小工具 ------------------------------ */

/**
 * 收集子节点的候选取值（复用惰性生成器，最多 cap 个）。
 * minimalOnly 时只取第一个（即最小实例），用于深度截断。
 */
function collectOptions(node, schemaPath, ctx, refStack, depth, required, minimalOnly) {
  const out = [];
  const cap = minimalOnly ? 1 : MAX_CHILD_DOMAIN;
  for (const v of enumerateNode(node, schemaPath, ctx, refStack.slice(), depth, required)) {
    out.push(v);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * 选填字段子集枚举：按子集大小升序、同大小按声明顺序，最多 limit 个。
 * 保证先「不填任何选填」再「逐个尝试每个选填字段」。
 */
function* enumerateSubsets(names, limit) {
  yield [];
  let count = 1;
  const k = names.length;
  for (let size = 1; size <= k; size++) {
    const indices = Array.from({ length: size }, (_, i) => i);
    while (indices[0] <= k - size) {
      yield indices.map((i) => names[i]);
      count++;
      if (count >= limit) return;
      // 组合词典序推进
      let p = size - 1;
      while (p >= 0 && indices[p] === k - size + p) p--;
      if (p < 0) break;
      indices[p]++;
      for (let q = p + 1; q < size; q++) indices[q] = indices[q - 1] + 1;
    }
  }
}

/**
 * 多字段取值组合的迭代顺序（每字段索引 0 为最小取值）：
 *   1) 全最小向量；
 *   2) 单字段偏离最小的向量（轮转覆盖每个字段，保证预算内每个字段
 *      至少有一个非默认取值被试到）；
 *   3) 其余向量按词典序补齐。
 * 产出总数受 MAX_COMBOS_PER_SUBSET 约束。
 */
function* comboVectors(optionLists) {
  const lens = optionLists.map((a) => a.length);
  if (lens.some((l) => l === 0)) return;
  const seen = new Set();
  let emitted = 0;

  const zero = lens.map(() => 0);
  seen.add(zero.join(','));
  yield zero;
  emitted++;
  if (emitted >= MAX_COMBOS_PER_SUBSET) return;

  // 单字段偏离：按「偏离序号轮转、字段轮转」展开，公平覆盖每个字段
  const maxLen = Math.max(...lens);
  for (let alt = 1; alt < maxLen; alt++) {
    for (let i = 0; i < lens.length; i++) {
      if (alt >= lens[i]) continue;
      const v = lens.map(() => 0);
      v[i] = alt;
      const key = v.join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      yield v;
      emitted++;
      if (emitted >= MAX_COMBOS_PER_SUBSET) return;
    }
  }

  // 其余组合按词典序（混合进位枚举）
  const total = lens.reduce((a, b) => a * b, 1);
  if (total > 100000) return;
  for (let code = 0; code < total; code++) {
    let c = code;
    const v = [];
    for (let i = 0; i < lens.length; i++) {
      v.push(c % lens[i]);
      c = Math.floor(c / lens[i]);
    }
    const key = v.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    yield v;
    emitted++;
    if (emitted >= MAX_COMBOS_PER_SUBSET) return;
  }
}

/**
 * 取用于枚举的类型（与 generate.js 同口径）：
 * 单一 type 优先；无 type 时按 properties/required、items/minItems 推断。
 */
function resolveType(node) {
  if (Object.prototype.hasOwnProperty.call(node, 'type')) {
    if (typeof node.type === 'string') return node.type;
    return null; // 类型数组在扫描阶段已记录
  }
  if (node.properties !== undefined || node.required !== undefined) return 'object';
  if (node.items !== undefined || node.minItems !== undefined) return 'array';
  return null;
}

function intBound(v, fallback) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(0, Math.ceil(v));
}

/** 挑一个不与任何已声明属性冲突的附加属性名 */
function pickExtraKey(names) {
  const base = '__counterexampleExtra__';
  if (!names.includes(base)) return base;
  let i = 1;
  while (names.includes(base + i)) i++;
  return base + i;
}

function pathPrefix(schemaPath) {
  return schemaPath ? `路径 "${schemaPath}" ` : '';
}

function addNote(ctx, note) {
  ctx.notes.push(note);
}

function addNoteOnce(ctx, dedupeKey, note) {
  if (ctx.noteKeys.has(dedupeKey)) return;
  ctx.noteKeys.add(dedupeKey);
  ctx.notes.push(note);
}

module.exports = {
  CounterError,
  searchCounterexample,
  MAX_VALID_CANDIDATES,
  MAX_TOTAL_ATTEMPTS,
};
