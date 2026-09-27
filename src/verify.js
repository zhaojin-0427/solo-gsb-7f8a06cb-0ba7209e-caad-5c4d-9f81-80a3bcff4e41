'use strict';

/**
 * verify.js —— 存量实例迁移核验
 *
 * 用户粘贴由多条 JSON 实例组成的数组（最多 100 条），服务端用随项目安装的
 * Ajv（draft-07）分别按当前旧、新两份 Schema 校验每条数据：
 *
 *   分类（保留输入顺序）：
 *     both      新旧均通过 —— 升级后依然合法
 *     oldOnly   仅旧版通过 —— 重点：这些存量数据升级到新版后会被拒收
 *     newOnly   仅新版通过 —— 旧校验下非法、新校验已放行
 *     bothFail  两版均失败 —— 本来就不合规的脏数据
 *
 * 位置约定：
 *   - 每条错误都给出实例侧 JSON Pointer（instancePath）：
 *     required / additionalProperties 的具体字段由校验器拼到指针末尾；
 *     字段名中的 ~ 与 / 按 RFC 6901 转义（~0 / ~1）。
 *   - schemaPath 为 Schema 侧定位（同样是 JSON Pointer），用于辅助排查。
 *
 * 引用策略：仅支持文档内本地 $ref，外部引用在编译前预检并给中文报错；
 * Ajv 不配置任何远程加载器，绝不会发起网络请求。
 */

const Ajv = require('ajv');
const { RefError, encodeToken, decodeToken } = require('./refs');

const MAX_INSTANCES = 100;
const MAX_ERRORS_PER_INSTANCE = 50;

class VerifyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'VerifyError';
    this.code = code || 'verify_error';
  }
}

/* ------------------------------ 输入解析 ------------------------------ */

/**
 * 解析粘贴的实例数组文本。
 * @returns {any[]} 解析后的数组（长度 1..100，元素可为任意 JSON 值）
 */
function parseInstances(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new VerifyError('请粘贴存量实例数据（JSON 数组文本，最多 100 条）。', 'empty_instances');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new VerifyError('实例数据不是合法 JSON：' + e.message, 'invalid_instances_json');
  }
  if (!Array.isArray(value)) {
    throw new VerifyError(
      `实例数据必须是 JSON 数组（[ ... ]），当前根节点为 ${typeLabel(value)}，无法逐条核验。`,
      'instances_not_array'
    );
  }
  if (value.length === 0) {
    throw new VerifyError('实例数组不能为空，请至少粘贴 1 条数据。', 'instances_empty');
  }
  if (value.length > MAX_INSTANCES) {
    throw new VerifyError(
      `实例数量 ${value.length} 条，超过单次上限 ${MAX_INSTANCES} 条，请分批核验。`,
      'too_many_instances'
    );
  }
  return value;
}

function typeLabel(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '数组';
  const t = typeof v;
  return ({ string: '字符串', number: '数字', boolean: '布尔值', object: '对象' })[t] || t;
}

/* ------------------------------ 编译 ------------------------------ */

function createAjv() {
  return new Ajv({
    allErrors: true,
    strict: false,
    // 不配置 loadSchema / ajv-formats / 任何网络能力；静默 Ajv 自身日志
    logger: { log() {}, warn() {}, error() {}, debug() {} },
  });
}

/**
 * 编译一份 Schema；外部引用 / Schema 自身非法时抛 VerifyError。
 * @param {object} root Schema 根
 * @param {string} label '旧' | '新'
 */
function compileSchema(ajvInstance, root, label) {
  try {
    return ajvInstance.compile(root);
  } catch (e) {
    throw new VerifyError(
      `${label} Schema 编译失败（Ajv draft-07），无法进行核验：${e.message}`,
      'invalid_schema'
    );
  }
}

/* ------------------------------ 核验主流程 ------------------------------ */

/**
 * 用两份 Schema 逐条核验实例数组。
 * @param {object} oldRoot 旧 Schema（已 JSON.parse）
 * @param {object} newRoot 新 Schema（已 JSON.parse）
 * @param {any[]} instances 实例数组（1..100 条）
 */
function verifyInstances(oldRoot, newRoot, instances) {
  // 同一 Ajv 实例注册两份 Schema 时 $id 可能冲突，各自独立实例编译
  const oldValidate = compileSchema(createAjv(), oldRoot, '旧');
  const newValidate = compileSchema(createAjv(), newRoot, '新');

  const items = [];
  const summary = { total: instances.length, both: 0, oldOnly: 0, newOnly: 0, bothFail: 0 };

  instances.forEach((instance, i) => {
    const oldResult = runValidator(oldValidate, instance);
    const newResult = runValidator(newValidate, instance);

    let category;
    if (oldResult.valid && newResult.valid) category = 'both';
    else if (oldResult.valid && !newResult.valid) category = 'oldOnly';
    else if (!oldResult.valid && newResult.valid) category = 'newOnly';
    else category = 'bothFail';
    summary[category]++;

    items.push({
      index: i, // 从 0 开始；展示层用 #1、#2 …，顺序即输入顺序
      category,
      old: oldResult,
      new: newResult,
    });
  });

  return { summary, items };
}

/** 跑一次校验并归一化错误（归一化时需回看实例取值，补出 type 的实际类型） */
function runValidator(validate, instance) {
  const valid = !!validate(instance);
  return {
    valid,
    errors: valid ? [] : normalizeErrors(validate.errors, instance),
  };
}

/* ------------------------------ 错误归一化 ------------------------------ */

const TYPE_LABELS = {
  string: '字符串', number: '数字', integer: '整数',
  boolean: '布尔值', object: '对象', array: '数组', null: 'null',
};

const COMPARISON_LABELS = { '>=': '≥', '<=': '≤', '>': '>', '<': '<' };

/**
 * 把 Ajv 原始错误数组转成统一的中文结构。
 * required / additionalProperties 的字段位置拼进 instancePath（JSON Pointer）。
 * @param {object[]} rawErrors Ajv 错误
 * @param {any} rootInstance 被校验的实例（用于回看 type 错误位置的实际类型）
 */
function normalizeErrors(rawErrors, rootInstance) {
  const out = [];
  for (const er of rawErrors || []) {
    let instancePath = er.instancePath || '';
    let message;

    switch (er.keyword) {
      case 'required':
        // Ajv 的 instancePath 指向缺字段的对象本身，把缺失字段补到指针末尾
        instancePath += '/' + encodeToken(er.params.missingProperty);
        message = `缺少必填字段 "${er.params.missingProperty}"`;
        break;
      case 'additionalProperties':
        instancePath += '/' + encodeToken(er.params.additionalProperty);
        message = `不允许出现多余字段 "${er.params.additionalProperty}"`;
        break;
      case 'type':
        message = `类型应为 ${typeList(er.params.type)}，实际为 ${actualTypeAt(rootInstance, instancePath)}`;
        break;
      case 'enum':
        message = `取值必须等于允许值之一：${compactList(er.params.allowedValues)}`;
        break;
      case 'const':
        message = `取值必须恒等于 ${compact(er.params.allowedValue)}`;
        break;
      case 'minimum':
      case 'maximum':
      case 'exclusiveMinimum':
      case 'exclusiveMaximum': {
        const op = COMPARISON_LABELS[er.params.comparison] || er.params.comparison;
        const scale = { minimum: '最小值', maximum: '最大值', exclusiveMinimum: '排他最小值', exclusiveMaximum: '排他最大值' }[er.keyword];
        message = `数值必须 ${op} ${er.params.limit}（${scale}约束）`;
        break;
      }
      case 'multipleOf':
        message = `必须是 ${er.params.multipleOf} 的整数倍`;
        break;
      case 'minLength':
        message = `字符串长度不得少于 ${er.params.limit} 个字符`;
        break;
      case 'maxLength':
        message = `字符串长度不得超过 ${er.params.limit} 个字符`;
        break;
      case 'pattern':
        message = `必须匹配正则模式 ${er.params.pattern}`;
        break;
      case 'format':
        message = `必须符合 "${er.params.format}" 格式`;
        break;
      case 'minItems':
        message = `数组元素数量不得少于 ${er.params.limit} 个`;
        break;
      case 'maxItems':
        message = `数组元素数量不得超过 ${er.params.limit} 个`;
        break;
      case 'uniqueItems':
        message = `数组元素必须唯一（第 ${er.params.j + 1} 项与第 ${er.params.i + 1} 项重复）`;
        break;
      case 'contains':
        message = `数组至少要包含 ${er.params.minContains || 1} 个满足 contains 条件的元素`;
        break;
      case 'minProperties':
        message = `对象属性数量不得少于 ${er.params.limit} 个`;
        break;
      case 'maxProperties':
        message = `对象属性数量不得超过 ${er.params.limit} 个`;
        break;
      case 'dependencies':
        message = `当字段 "${er.params.property}" 存在时，必须同时存在字段 "${er.params.missingProperty}"`;
        break;
      case 'propertyNames':
        message = er.params.failingProperty !== undefined
          ? `属性名 "${er.params.failingProperty}" 不满足 propertyNames 约束`
          : '存在不满足 propertyNames 约束的属性名';
        break;
      case 'oneOf':
        message = er.params.passingSchemas === null
          ? '必须恰好匹配 oneOf 中的一个 schema，当前一个都不匹配'
          : `必须恰好匹配 oneOf 中的一个 schema，当前匹配了 ${er.params.passingSchemas.length + 1} 个`;
        break;
      case 'anyOf':
        message = '不匹配 anyOf 中的任何 schema';
        break;
      case 'allOf':
        message = '必须匹配 allOf 中的全部 schema';
        break;
      case 'not':
        message = '不能匹配 not 所描述的 schema';
        break;
      case 'if':
        message = '数据不满足 if/then/else 条件分支要求';
        break;
      case 'false schema':
        message = '命中恒为 false 的 schema，该位置不允许任何取值';
        break;
      default:
        // 未覆盖的 draft-07 关键字：保留 Ajv 原始英文信息，绝不静默吞掉
        message = er.message || er.keyword;
    }

    out.push({
      instancePath: instancePath || '',
      schemaPath: String(er.schemaPath || '').replace(/^#/, ''),
      keyword: er.keyword,
      message,
    });
    if (out.length >= MAX_ERRORS_PER_INSTANCE) {
      out.push({
        instancePath,
        schemaPath: '',
        keyword: '__truncated__',
        message: `错误过多，仅展示前 ${MAX_ERRORS_PER_INSTANCE} 条；请修正上述问题后重新核验。`,
      });
      break;
    }
  }
  return out;
}

function typeList(t) {
  if (Array.isArray(t)) return t.map((x) => TYPE_LABELS[x] || x).join('、');
  return TYPE_LABELS[t] || String(t);
}

/** 沿 JSON Pointer 回看实例值（指针按 RFC 6901 编码），用于补出实际类型 */
function valueAtPointer(root, pointer) {
  if (!pointer) return root;
  let cur = root;
  const tokens = pointer.split('/').slice(1);
  for (const raw of tokens) {
    const token = decodeToken(raw);
    if (cur === null || typeof cur !== 'object' || !(token in cur)) return undefined;
    cur = cur[token];
  }
  return cur;
}

/** 实例某位置的实际 JSON 类型中文名（Ajv v8 的 type 错误不再直接带 dataTypeName） */
function actualTypeAt(root, pointer) {
  const v = valueAtPointer(root, pointer);
  if (v === undefined) return '路径不存在';
  if (v === null) return TYPE_LABELS.null;
  if (Array.isArray(v)) return TYPE_LABELS.array;
  return TYPE_LABELS[typeof v] || typeof v;
}

function compact(v) {
  let s;
  try {
    s = JSON.stringify(v);
  } catch (e) {
    s = String(v);
  }
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}

function compactList(list) {
  if (!Array.isArray(list)) return compact(list);
  const shown = list.slice(0, 10).map(compact).join('、');
  return list.length > 10 ? `${shown} 等 ${list.length} 个值` : shown;
}

/**
 * 全文档预检：外部引用（http(s)、URN、相对路径文件等）在 Ajv 编译前先给
 * 中文错误。只沿 Schema 位置递归，不进入 enum/const/default/examples 等
 * 实例值（实例值里碰巧出现 "$ref" 属性不是引用）。
 */
function precheckLocalRefs(root) {
  const SCHEMA_CONTAINER_KEYS = new Set([
    'properties', 'patternProperties', '$defs', 'definitions',
  ]);
  const SCHEMA_DIRECT_KEYS = new Set([
    'items', 'additionalProperties', 'contains', 'propertyNames',
    'not', 'if', 'then', 'else',
  ]);
  const SCHEMA_ARRAY_KEYS = new Set(['allOf', 'anyOf', 'oneOf']);
  const INSTANCE_VALUE_KEYS = new Set(['enum', 'const', 'default', 'examples']);

  const visit = (node) => {
    if (node === true || node === false || node === null || typeof node !== 'object') return;

    if (!Array.isArray(node) && typeof node.$ref === 'string') {
      if (node.$ref !== '#' && !node.$ref.startsWith('#/')) {
        throw new RefError(
          `迁移核验仅支持文档内本地引用（以 "#" 开头），检测到外部引用："${node.$ref}"。请先内联外部定义后重试。`,
          node.$ref
        );
      }
      // draft-07：$ref 的兄弟关键字被忽略，无需继续深入
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (INSTANCE_VALUE_KEYS.has(key)) continue;
      if (SCHEMA_CONTAINER_KEYS.has(key)) {
        if (value && typeof value === 'object') Object.values(value).forEach(visit);
      } else if (SCHEMA_DIRECT_KEYS.has(key)) {
        visit(value);
      } else if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(value)) {
        value.forEach(visit);
      } else if (key === 'dependencies' && value && typeof value === 'object') {
        // schema 依赖的值是对象 schema；属性依赖的值是字符串数组
        Object.values(value).forEach((dep) => visit(dep));
      }
    }
  };
  visit(root);
}

module.exports = {
  VerifyError,
  MAX_INSTANCES,
  parseInstances,
  verifyInstances,
  normalizeErrors,
  precheckLocalRefs,
};
