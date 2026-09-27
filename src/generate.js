'use strict';

/**
 * generate.js —— 有效样本（JSON 实例）生成
 *
 * 面向接口联调：从一份 draft-07 风格 Schema 生成一个"最小"的合法实例：
 *   - 对象只填 required 必填字段（选填字段一律不展开）
 *   - 数组取 minItems 要求的最少元素
 *   - 字符串用 'a' 补足 minLength
 *   - 整数取取值范围内最接近零的值
 *   - enum 按数组顺序逐个用同节点全部约束完整复验（properties / required、
 *     单一 items / minItems、文档内本地 $ref），返回第一个通过复验的取值
 *   - const 直接采用固定值（同样需通过同节点全部约束的完整复验）
 *   - 布尔 schema：true => null（任意值均可），false => 无解
 *   - 仅解析文档内本地 $ref（#/...）；可选路径上的自引用不展开，
 *     必填路径上的引用环立即报错并给出链路
 *
 * 支持的断言关键字（其余断言关键字一律指出 Schema 路径并拒绝生成）：
 *   type（单一类型）、const、enum、properties、required、items（单一 schema）、
 *   minItems、minLength、integer 的 minimum/maximum、$ref；
 *   additionalProperties 的布尔形式按语义处理（true 允许补字段，false/缺省不补）。
 *
 * 安全闸：生成前先用随项目安装的 Ajv 编译 Schema（拦截非法 Schema），
 * 生成后再用 Ajv 复验实例；复验不通过的实例绝不返回给前端。
 */

const Ajv = require('ajv');
const { isLocalRef, resolvePointer, encodeToken } = require('./refs');

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  // format 不在生成支持范围内（会被显式拒绝），静默 Ajv 对未知 format 的提示日志
  logger: { log() {}, warn() {}, error() {}, debug() {} },
});

class GenerateError extends Error {
  constructor(message, code, schemaPath, instancePath) {
    super(message);
    this.name = 'GenerateError';
    this.code = code || 'generate_error';
    this.schemaPath = schemaPath || '';
    this.instancePath = instancePath || '';
    this.problems = null;
  }
}

/** 注解 / 结构性关键字：不约束实例内容，遍历时直接忽略 */
const IGNORE_KEYS = new Set([
  '$id', '$schema', '$comment', '$defs', 'definitions',
  'title', 'description', 'default', 'examples',
  'readOnly', 'writeOnly', 'deprecated',
  'contentEncoding', 'contentMediaType',
]);

/** 显式支持的断言关键字 */
const SUPPORTED_KEYS = new Set([
  '$ref', 'type', 'const', 'enum',
  'properties', 'required', 'additionalProperties',
  'items', 'minItems', 'minLength', 'minimum', 'maximum',
]);

/** 其余 draft-07 常见断言关键字的中文名，报错时逐项指出位置 */
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

/**
 * 生成入口：预检外部引用 → 编译 → 受限生成 → Ajv 复验，任一环节失败即抛错。
 * @returns {any} 可直接 JSON.stringify 的实例
 */
function generateInstance(root) {
  // 0) 外部引用在编译前先给中文错误（Ajv 的报错为英文且不含操作建议）
  precheckRefs(root);

  // 1) 编译期校验：Schema 自身必须合法（draft-07）
  let validate;
  try {
    validate = ajv.compile(root);
  } catch (e) {
    throw new GenerateError('Schema 未通过 Ajv（draft-07）编译，无法生成：' + e.message, 'invalid_schema');
  }

  // 2) 受限生成（收集所有"不支持的关键字"问题；环 / 矛盾立即抛错）
  const ctx = {
    root,
    problems: [],
    refStack: [],
    // 已扫描过不支持关键字的子树（按 Schema 路径去重），供 enum/const
    // 候选结构约束的补扫复用
    scanned: new Set(),
    // enum/const 候选完整复验：独立 Ajv 实例与按 Schema 路径缓存的子校验器
    candidateAjv: null,
    candidateBaseId: '',
    candidateValidators: null,
    checkerSeq: 0,
  };
  const instance = genNode(root, '', '', ctx);

  if (ctx.problems.length) {
    const ps = ctx.problems;
    const lines = ps.map(
      (p, i) => `${i + 1}. ${p.label}｜Schema 路径：${p.schemaPath || '（根节点）'}｜${p.message}`
    );
    const err = new GenerateError(
      `检测到 ${ps.length} 处当前不支持生成的 Schema 写法，已拒绝生成：\n` + lines.join('\n'),
      'unsupported'
    );
    err.problems = ps;
    throw err;
  }

  // 3) 复验闸：只有 Ajv 校验通过的实例才允许显示
  if (!validate(instance)) {
    const detail = (validate.errors || []).slice(0, 5).map((er) => {
      const where = er.instancePath || '（根节点）';
      return `· ${where}：${er.message}`;
    });
    throw new GenerateError(
      '生成结果未通过 Ajv 复验，已拒绝显示（生成器无法在支持范围内构造合法实例）：\n' +
        detail.join('\n'),
      'verify_failed'
    );
  }

  return instance;
}

/* ------------------------------ 核心递归 ------------------------------ */

function genNode(node, schemaPath, instancePath, ctx) {
  // 布尔 Schema
  if (node === true) return null; // {} 等价：任意值均可，取 null
  if (node === false) {
    throw hard(
      '该节点 Schema 恒为 false，任何实例都无法通过校验（无解）。',
      'unsatisfiable', schemaPath, instancePath
    );
  }
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw hard('Schema 节点必须是对象或布尔值。', 'invalid_schema', schemaPath, instancePath);
  }

  // $ref：draft-07 习惯下兄弟关键字一律忽略（与比对引擎口径一致）
  if (Object.prototype.hasOwnProperty.call(node, '$ref')) {
    if (typeof node.$ref !== 'string') {
      throw hard('$ref 必须是字符串。', 'invalid_schema', schemaPath, instancePath);
    }
    const ref = node.$ref;
    if (!isLocalRef(ref)) {
      const e = new (require('./refs').RefError)(
        `样本生成仅支持文档内本地引用（以 "#" 开头），检测到外部引用："${ref}"。请先内联外部定义后重试。`,
        ref
      );
      throw e;
    }
    const target = ref === '#' ? '' : ref.slice(1); // '#/definitions/X' → '/definitions/X'，'#' → ''
    if (ctx.refStack.includes(target)) {
      const chain = ctx.refStack.concat(target).map((p) => '#' + p).join(' → ');
      throw hard(
        `必填字段的展开路径上存在 $ref 引用环（${chain}），展开无法终止。` +
          '请把环上至少一个字段改为选填（可选自引用不会展开），或手工构造实例。',
        'ref_cycle', target, instancePath
      );
    }

    let resolved;
    try {
      resolved = resolvePointer(ctx.root, ref);
    } catch (e) {
      throw e;
    }
    ctx.refStack.push(target);
    try {
      return genNode(resolved, target, instancePath, ctx);
    } finally {
      ctx.refStack.pop();
    }
  }

  // 扫描不支持的关键字（只记录、不中断，尽量一次指出全部位置）
  scanUnsupported(node, schemaPath, instancePath, ctx);

  // const / enum：候选值必须通过同节点"全部受支持约束"的完整复验。
  // 候选可能是对象 / 数组，其 properties / required、单一 items / minItems
  // 以及文档内本地 $ref 等嵌套结构都要一并核对，不能只看顶层类型；
  // 不支持的断言关键字不参与候选筛选（由顶层统一报 unsupported）。
  if (Object.prototype.hasOwnProperty.call(node, 'const') || Array.isArray(node.enum)) {
    scanCandidateConstraints(node, schemaPath, instancePath, ctx);

    if (Object.prototype.hasOwnProperty.call(node, 'const')) {
      if (Array.isArray(node.enum) && !node.enum.some((v) => deepEqual(v, node.const))) {
        throw hard('const 固定值不在 enum 取值列表中，约束互相矛盾。', 'contradiction', `${schemaPath}/const`, instancePath);
      }
      // 与原规则同序：const 在受支持子集内过不了约束时立即报矛盾
      // （另有不支持关键字时由顶层统一报 unsupported，但矛盾优先）
      if (!checkCandidate(node.const, schemaPath, ctx)) {
        throw hard(
          'const 固定值不满足该节点的全部约束（properties / required、items / minItems、$ref 等），约束互相矛盾。',
          'contradiction', `${schemaPath}/const`, instancePath
        );
      }
      return node.const;
    }

    // enum：按数组顺序逐个复验，返回第一个通过的候选。
    // 顺序与原规则一致：候选相容性只按"受支持子集"判定（不支持的断言
    // 由顶层统一报 unsupported，不参与筛选）；候选在受支持子集内全部
    // 失败时，无论是否另有不支持关键字，都立即报无解
    for (const cand of node.enum) {
      if (checkCandidate(cand, schemaPath, ctx)) return cand;
    }
    // 候选本身无一合法：给出指向 enum 路径的无解错误
    throw hard(
      'enum 中没有取值能通过该节点的全部约束（已按数组顺序逐一核对 ' +
        'properties / required、items / minItems、$ref 等约束），该节点无合法实例。',
      'unsatisfiable', `${schemaPath}/enum`, instancePath
    );
  }

  const type = resolveType(node);

  if (type === 'object') return genObject(node, schemaPath, instancePath, ctx);
  if (type === 'array') return genArray(node, schemaPath, instancePath, ctx);
  if (type === 'string') {
    const n = intBound(node.minLength, 0);
    return 'a'.repeat(n);
  }
  if (type === 'integer') return genInteger(node, schemaPath, instancePath);
  if (type === 'number') return 0; // 数字类型不处理边界（边界仅支持整数），0 对无约束 number 恒合法
  if (type === 'boolean') return false;
  if (type === 'null') return null;
  if (type) {
    // 未知 type 正常会在 Ajv 编译阶段被拦下，这里兜底
    throw hard(`不认识的类型 "${type}"。`, 'invalid_schema', schemaPath, instancePath);
  }

  // 无任何可建模约束（{} / 仅注解）：任意值均可
  return null;
}

/* ------------------------------ 对象 ------------------------------ */

function genObject(node, schemaPath, instancePath, ctx) {
  const required = Array.isArray(node.required)
    ? [...new Set(node.required)]
    : [];
  const props = node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)
    ? node.properties
    : null;
  const out = {};

  for (const name of required) {
    const childInstancePath = `${instancePath}/${encodeToken(name)}`;
    const hasProp = props && Object.prototype.hasOwnProperty.call(props, name);
    if (!hasProp) {
      // 只填 properties 内的必填字段；未声明字段仅在 additionalProperties:true 时补 null
      if (node.additionalProperties === true) {
        out[name] = null;
        continue;
      }
      throw hard(
        `必填字段 "${name}" 未在 properties 中声明，且 additionalProperties 不允许补出该字段，无法生成。`,
        'unsatisfiable', `${schemaPath}/required`, childInstancePath
      );
    }
    out[name] = genNode(
      props[name],
      `${schemaPath}/properties/${encodeToken(name)}`,
      childInstancePath,
      ctx
    );
  }
  return out;
}

/* ------------------------------ 数组 ------------------------------ */

function genArray(node, schemaPath, instancePath, ctx) {
  const n = intBound(node.minItems, 0);
  const items = node.items;

  if (n > 0 && items === undefined) {
    throw hard(
      `minItems 要求至少 ${n} 个元素，但未提供单一 items schema，无法生成元素。`,
      'unsatisfiable', `${schemaPath}/minItems`, instancePath
    );
  }

  const arr = [];
  // 元组数组（items 为数组）已在扫描阶段记为不支持，这里仅处理单一 schema
  if (items && typeof items === 'object' && !Array.isArray(items)) {
    for (let i = 0; i < n; i++) {
      arr.push(genNode(items, `${schemaPath}/items`, `${instancePath}/${i}`, ctx));
    }
  }
  return arr;
}

/* ------------------------------ 整数 ------------------------------ */

function genInteger(node, schemaPath, instancePath) {
  // minimum/maximum 允许写成小数：整数最小可取 ceil(min)，最大可取 floor(max)
  let lo = null;
  let hi = null;
  if (typeof node.minimum === 'number') lo = Math.ceil(node.minimum);
  if (typeof node.maximum === 'number') hi = Math.floor(node.maximum);

  if (lo !== null && hi !== null && lo > hi) {
    throw hard(
      `整数取值区间为空（向上取整后的最小值 ${lo} 大于向下取整后的最大值 ${hi}），约束矛盾。`,
      'contradiction', schemaPath, instancePath
    );
  }

  // 取范围内最接近零的值
  if (lo !== null && lo > 0) return lo;
  if (hi !== null && hi < 0) return hi;
  return 0;
}

/* ------------------------------ 类型推断 / 关键字扫描 ------------------------------ */

/**
 * 取用于生成的类型：
 *   - 显式 type 仅支持单一字符串；类型数组记为不支持
 *   - 无 type 时按 properties/required、items/minItems 推断对象 / 数组
 *   - 推断不出则返回 null（任意值）
 */
function resolveType(node) {
  if (Object.prototype.hasOwnProperty.call(node, 'type')) {
    if (Array.isArray(node.type)) return null; // 已在扫描阶段记录问题
    if (typeof node.type === 'string') return node.type;
    return null; // 非法 type 由 Ajv 编译阶段拦截
  }
  if (node.properties !== undefined || node.required !== undefined) return 'object';
  if (node.items !== undefined || node.minItems !== undefined) return 'array';
  return null;
}

function scanUnsupported(node, schemaPath, instancePath, ctx) {
  // 标记本子树已按当前节点扫描过，enum/const 候选补扫时跳过（子树另由 walk 推进）
  ctx.scanned.add(schemaPath);
  const add = (label, message, key) => {
    ctx.problems.push({
      label,
      message,
      keyword: key || label,
      schemaPath: key ? `${schemaPath}/${key}` : schemaPath,
      instancePath,
    });
  };

  // 形态特殊的"部分支持"关键字
  if (Array.isArray(node.type)) {
    add('type（类型数组）', '仅支持单一 type，不支持类型数组（如 ["string","null"]），无法确定唯一实例。', 'type');
  }
  if (Array.isArray(node.items)) {
    add('items（元组数组）', '数组仅支持单一 items schema，不支持 items 数组形式的元组校验。', 'items');
  }
  if (node.additionalProperties !== undefined &&
      typeof node.additionalProperties === 'object' &&
      node.additionalProperties !== null &&
      !Array.isArray(node.additionalProperties)) {
    add('additionalProperties（schema 形式）',
      '仅支持 additionalProperties 的布尔形式，不支持按 schema 约束附加属性。', 'additionalProperties');
  }

  const effectiveType = resolveType(node);
  if ((node.minimum !== undefined || node.maximum !== undefined) && effectiveType !== 'integer') {
    const key = node.minimum !== undefined ? 'minimum' : 'maximum';
    add(KW_LABEL[key] || key, 'minimum / maximum 仅支持整数（integer）类型的取值生成。', key);
  }

  for (const key of Object.keys(node)) {
    if (SUPPORTED_KEYS.has(key) || IGNORE_KEYS.has(key)) continue;
    add(KW_LABEL[key] || `关键字 "${key}"`, '该断言关键字不在样本生成的支持范围内，请手工编写实例或移除该约束。', key);
  }
}

/* ------------------------------ 小工具 ------------------------------ */

function hard(message, code, schemaPath, instancePath) {
  return new GenerateError(message, code, schemaPath, instancePath);
}

function intBound(v, fallback) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(0, Math.ceil(v));
}

/**
 * 用同节点 Schema 对 enum / const 候选值做完整复验。
 *
 * 候选若是对象 / 数组，浅查（只看顶层 type / 长度 / 范围）会漏掉
 * properties / required、items / minItems 以及本地 $ref 里的约束，
 * 导致选中的候选在最终 Ajv 复验时失败、整次请求被拒。
 *
 * 复验用的子校验器按节点 Schema 路径（JSON Pointer）从注册在独立 Ajv
 * （每次请求一份，避免重复 $id 冲突）的整份文档中取出——$ref 在同一文档
 * 内自动解析，因此候选若是对象 / 数组，其 properties / required、
 * 单一 items / minItems 等嵌套约束都会被一并核对，结论与最终整树复验闸
 * 在"受支持子集"内一致。
 *
 * 当文档中存在不支持的断言关键字时，候选相容性按"剔除这些关键字后的
 * 受支持子集"判定（它们本来就要拒绝生成，不能参与候选筛选，否则带
 * pattern 的节点所有候选都会被否掉、语义从 unsupported 变成无解）；
 * 无此类关键字时，受支持子集与完整 Schema 完全相同。
 */
function checkCandidate(value, schemaPath, ctx) {
  return !!getCandidateValidator(schemaPath, ctx)(value);
}

/**
 * 按节点的 Schema 路径取候选复验校验器（同一路径只编译一次）。
 * 全树已扫描出不支持关键字时，使用"剔除这些关键字后"的整份文档，
 * 使候选相容性不受本就会拒绝生成的断言影响（与原浅查口径一致）。
 */
function getCandidateValidator(schemaPath, ctx) {
  if (ctx.candidateValidators && ctx.candidateValidators.has(schemaPath)) {
    return ctx.candidateValidators.get(schemaPath);
  }

  const silent = { log() {}, warn() {}, error() {}, debug() {} };
  const fragment = pointerFragment(schemaPath);

  // 独立 Ajv（每次请求一份，避免重复 $id 冲突），根文档注册到一次性
  // 命名空间（根自带 $id 也不受影响）；$ref 在同一文档内自动解析
  if (!ctx.candidateAjv) {
    const full = new Ajv({ allErrors: true, strict: false, logger: silent });
    const fullId = `urn:gen-cand:${++ctx.checkerSeq}`;
    full.addSchema(ctx.root, fullId);
    ctx.candidateAjv = full;
    ctx.candidateBaseId = fullId;
    ctx.candidateValidators = new Map();
  }

  let validator;
  if (ctx.problems.length > 0) {
    // 受支持子集版：深拷贝整份文档并剔除不支持断言后注册到第二个 Ajv
    if (!ctx.supportedAjv) {
      const sup = new Ajv({ allErrors: true, strict: false, logger: silent });
      const supId = `urn:gen-cand-sup:${++ctx.checkerSeq}`;
      sup.addSchema(getSupportedRoot(ctx), supId);
      ctx.supportedAjv = sup;
      ctx.supportedBaseId = supId;
    }
    validator = ctx.supportedAjv.getSchema(ctx.supportedBaseId + '#' + fragment);
  } else {
    validator = ctx.candidateAjv.getSchema(ctx.candidateBaseId + '#' + fragment);
  }

  if (!validator) {
    throw hard(
      `无法取得节点 "#${schemaPath}" 的候选复验校验器，请检查 Schema 结构。`,
      'invalid_schema', schemaPath, ''
    );
  }
  ctx.candidateValidators.set(schemaPath, validator);
  return validator;
}

/** Schema 路径 → URI fragment：逐段 RFC 3986 百分号编码（~ 无需转义） */
function pointerFragment(schemaPath) {
  return schemaPath.split('/').map(encodeURIComponent).join('/');
}

/** 惰性获取"剔除不支持关键字后"的整份 Schema（深拷贝，只做一次） */
function getSupportedRoot(ctx) {
  if (!ctx.supportedRoot) ctx.supportedRoot = stripUnsupported(ctx.root);
  return ctx.supportedRoot;
}

/**
 * 深拷贝 Schema 并剔除"不支持生成"的断言关键字，供候选相容性复验使用。
 * 剔除口径与 scanUnsupported 的判定保持一致；$ref 节点按 draft-07 语义
 * 只保留 $ref（兄弟断言本就不生效）。
 */
function stripUnsupported(rootNode) {
  const clone = (n) => {
    if (n === null || typeof n !== 'object') return n;
    if (Array.isArray(n)) return n.map(clone);
    if (typeof n.$ref === 'string') return { $ref: n.$ref };

    const out = {};
    for (const key of Object.keys(n)) {
      if (IGNORE_KEYS.has(key)) { out[key] = n[key]; continue; }
      if (key === 'type' && Array.isArray(n.type)) continue;        // 类型数组
      if (key === 'items' && Array.isArray(n.items)) continue;      // 元组数组
      if (key === 'additionalProperties' &&
          n.additionalProperties && typeof n.additionalProperties === 'object') {
        continue;                                                  // schema 形式
      }
      if (KW_LABEL[key]) continue;                                 // 其余不支持断言
      const v = n[key];
      out[key] = (v && typeof v === 'object') ? clone(v) : v;
    }
    return out;
  };
  return clone(rootNode);
}

/**
 * 补扫 enum / const 节点"结构约束子树"里的不支持关键字。
 *
 * 候选若是对象 / 数组，其合法性还取决于 properties、items 以及本地 $ref
 * 指向的子节点中的约束；这些子树在正常"构造"路径上不会经过（对象只展开
 * required），需要在此补扫，确保不支持的断言仍按原规则指出路径并拒绝生成。
 */
function scanCandidateConstraints(node, schemaPath, instancePath, ctx) {
  const walk = (sub, subPath, subInstancePath, seenRefs) => {
    if (sub === true || sub === false) return;
    if (sub === null || typeof sub !== 'object') return;

    // $ref：外部引用已在预检阶段拒绝；本地引用解析到目标后继续
    if (!Array.isArray(sub) && typeof sub.$ref === 'string') {
      if (!isLocalRef(sub.$ref)) return;
      if (seenRefs.has(sub.$ref)) return; // 引用环：目标子树已在遍历中
      const target = sub.$ref === '#' ? '' : sub.$ref.slice(1);
      if (seenRefs.has(target)) return;
      const nextSeen = new Set(seenRefs).add(sub.$ref).add(target);
      const resolved = resolvePointer(ctx.root, sub.$ref);
      walk(resolved, target, subInstancePath, nextSeen);
      // draft-07 习惯下兄弟关键字忽略，不再遍历兄弟
      return;
    }

    // 本子树在主生成路径 / 先前补扫中已扫描过则跳过
    if (ctx.scanned.has(subPath)) return;
    ctx.scanned.add(subPath);
    scanUnsupported(sub, subPath, subInstancePath, ctx);

    if (Array.isArray(sub)) {
      // items 元组数组等"位置即 schema"的数组
      sub.forEach((item, i) => walk(item, `${subPath}/${i}`, `${subInstancePath}/${i}`, seenRefs));
      return;
    }

    if (sub.properties && typeof sub.properties === 'object' && !Array.isArray(sub.properties)) {
      for (const name of Object.keys(sub.properties)) {
        walk(
          sub.properties[name],
          `${subPath}/properties/${encodeToken(name)}`,
          `${subInstancePath}/${encodeToken(name)}`,
          seenRefs
        );
      }
    }
    if (sub.items !== undefined) {
      if (Array.isArray(sub.items)) {
        sub.items.forEach((item, i) =>
          walk(item, `${subPath}/items/${i}`, `${subInstancePath}/${i}`, seenRefs)
        );
      } else {
        walk(sub.items, `${subPath}/items`, `${subInstancePath}/0`, seenRefs);
      }
    }
    if (sub.additionalProperties &&
        typeof sub.additionalProperties === 'object' &&
        !Array.isArray(sub.additionalProperties)) {
      walk(sub.additionalProperties, `${subPath}/additionalProperties`, subInstancePath, seenRefs);
    }
  };

  // 节点自身已在 genNode 中扫描，只深入结构约束子树
  const seenRefs = new Set([schemaPath]);
  if (node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties)) {
    for (const name of Object.keys(node.properties)) {
      walk(
        node.properties[name],
        `${schemaPath}/properties/${encodeToken(name)}`,
        `${instancePath}/${encodeToken(name)}`,
        seenRefs
      );
    }
  }
  if (node.items !== undefined) {
    if (Array.isArray(node.items)) {
      node.items.forEach((item, i) =>
        walk(item, `${schemaPath}/items/${i}`, `${instancePath}/${i}`, seenRefs)
      );
    } else {
      walk(node.items, `${schemaPath}/items`, `${instancePath}/0`, seenRefs);
    }
  }
  if (node.additionalProperties &&
      typeof node.additionalProperties === 'object' &&
      !Array.isArray(node.additionalProperties)) {
    walk(node.additionalProperties, `${schemaPath}/additionalProperties`, instancePath, seenRefs);
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

/**
 * 全文档预检：外部引用（http(s)、相对路径等）在 Ajv 编译前先给中文错误。
 * 只沿"Schema 位置"递归，不进入 enum/const/default/examples 等实例值
 * （实例值里碰巧出现 "$ref" 属性不是引用）。
 */
function precheckRefs(root) {
  const visit = (node) => {
    if (node === true || node === false || node === null || typeof node !== 'object') return;

    if (!Array.isArray(node) && typeof node.$ref === 'string') {
      if (!isLocalRef(node.$ref)) {
        throw new (require('./refs').RefError)(
          `样本生成仅支持文档内本地引用（以 "#" 开头），检测到外部引用："${node.$ref}"。请先内联外部定义后重试。`,
          node.$ref
        );
      }
      // draft-07：$ref 的兄弟关键字被忽略，无需继续深入
      return;
    }

    if (Array.isArray(node)) {
      // 仅 items 元组 / allOf 等位置数组中会放 schema
      node.forEach(visit);
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' || key === 'patternProperties' || key === '$defs' || key === 'definitions') {
        if (value && typeof value === 'object') Object.values(value).forEach(visit);
      } else if (['items', 'additionalProperties', 'contains', 'propertyNames', 'not', 'if', 'then', 'else'].includes(key)) {
        visit(value);
      } else if (['allOf', 'anyOf', 'oneOf'].includes(key) && Array.isArray(value)) {
        value.forEach(visit);
      } else if (key === 'dependencies' && value && typeof value === 'object') {
        // schema 依赖的值是对象 schema；属性依赖的值是字符串数组
        Object.values(value).forEach((dep) => visit(dep));
      }
      // enum / const / default / examples 等实例值不深入；其余标量/数组自然忽略
    }
  };
  visit(root);
}

module.exports = { generateInstance, GenerateError };
