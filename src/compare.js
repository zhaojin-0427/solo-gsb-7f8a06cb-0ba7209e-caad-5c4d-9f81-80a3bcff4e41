'use strict';

/**
 * compare.js —— JSON Schema 递归差异分析
 *
 * 输出的每一条 finding：
 * {
 *   id:      稳定序号（按遍历顺序分配，策略切换不影响）
 *   kind:    变化类型（见 KIND_META）
 *   path:    JSON Pointer（如 /properties/address/properties/city）
 *   name:    变化点名称
 *   reader:  对读取方的兼容级别 breaking | warning | safe | info
 *   writer:  对写入方的兼容级别 breaking | warning | safe | info
 *   detail:  人类可读的解释（为什么这样判定）
 *   oldValue / newValue: 预览值
 *   ref:     涉及的本地引用（如有）
 * }
 *
 * 兼容判定口径：
 *   reader（读取方 / 消费方 / 后向兼容性）：
 *       旧版读取方去读"新结构 + 旧写入方可能产出的数据"会不会出问题。
 *       判定基准 = 新版本写入方产出的数据是否仍满足旧读取方预期，
 *       即 OLD schema 是否接受 NEW 允许的实例。
 *   writer（写入方 / 生产方 / 前向兼容性）：
 *       旧版写入方继续写，新版本读取方按 NEW schema 校验是否仍接受，
 *       即 NEW schema 是否接受 OLD 允许的实例。
 *
 *   记忆：放宽约束 → writer 可能 breaking（新读取方读到旧值会失败）；
 *         收紧约束 → reader 可能 breaking（旧读取方读到新值会失败）。
 */

const { followRefs, encodeToken } = require('./refs');

const LEVELS = ['breaking', 'warning', 'safe', 'info'];
const RANK = { breaking: 0, warning: 1, safe: 2, info: 3 };

/** 变化类型元数据：标题 + 默认说明模板参数由 detail 直接给出 */
const KIND_META = {
  prop_added:            { title: '新增属性' },
  prop_removed:          { title: '移除属性' },
  required_added:        { title: '改为必填' },
  required_removed:      { title: '改为选填' },
  type_changed:          { title: '类型变化' },
  type_added:            { title: '新增类型约束' },
  type_removed:          { title: '移除类型约束' },
  const_changed:         { title: '常量值变化' },
  enum_added:            { title: '枚举新增取值' },
  enum_removed:          { title: '枚举移除取值' },
  enum_changed:          { title: '枚举集合变化（有增有减）' },
  format_changed:        { title: 'format 变化' },
  pattern_changed:       { title: '正则模式变化' },
  number_min_increased:  { title: '收紧下限' },
  number_min_decreased:  { title: '放宽下限' },
  number_max_decreased:  { title: '收紧上限' },
  number_max_increased:  { title: '放宽上限' },
  length_min_increased:  { title: '收紧最小长度' },
  length_min_decreased:  { title: '放宽最小长度' },
  length_max_decreased:  { title: '收紧最大长度' },
  length_max_increased:  { title: '放宽最大长度' },
  uniqueitems_on:        { title: '开启 uniqueItems' },
  uniqueitems_off:       { title: '关闭 uniqueItems' },
  items_schema_changed:  { title: '数组元素 schema 变化' },
  items_tuple_added:     { title: '元组新增位置' },
  items_tuple_removed:   { title: '元组移除位置' },
  additional_locked:     { title: 'additionalProperties 收紧（封闭对象）' },
  additional_loosened:   { title: 'additionalProperties 放宽' },
  additional_schema:     { title: 'additionalProperties schema 变化' },
  bool_schema_changed:   { title: '布尔 schema 变化' },
  combiner_notice:       { title: '组合关键字（allOf/oneOf/anyOf）' },
};

class CompareError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompareError';
  }
}

/* ------------------------------ 工具函数 ------------------------------ */

/** JSON 稳定序列化（对象键排序），用于枚举值等的比较 */
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 把 type 统一成数组形式；缺失返回 null */
function normTypes(sch) {
  if (!isObject(sch) || sch.type === undefined) return null;
  return Array.isArray(sch.type) ? [...sch.type] : [sch.type];
}

function preview(v) {
  if (v === undefined) return undefined;
  const s = typeof v === 'string' ? v : stable(v);
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
}

/* ------------------------------ 比对引擎 ------------------------------ */

class Differ {
  constructor(oldRoot, newRoot) {
    this.oldRoot = oldRoot;
    this.newRoot = newRoot;
    this.findings = [];
    this.seq = 0;
  }

  emit(f) {
    this.findings.push(
      Object.assign(
        {
          id: this.seq++,
          reader: 'safe',
          writer: 'safe',
          oldValue: undefined,
          newValue: undefined,
          ref: null,
        },
        f
      )
    );
  }

  /**
   * 比对两个 schema 节点。
   * @param path 当前路径（JSON Pointer 字符串）
   * @param name 当前节点显示名
   * @param oldNode 旧节点（已解析 $ref 后的实际节点）
   * @param newNode 新节点
   * @param seen 循环检测：Set，键为 oldRef|newRef
   */
  walk(path, name, oldNode, newNode, seen) {
    // 解析 $ref（沿引用链走到最终 schema）
    let oldResolved, newResolved;
    try {
      oldResolved = followRefs(this.oldRoot, oldNode);
      newResolved = followRefs(this.newRoot, newNode);
    } catch (e) {
      throw new CompareError(e.message);
    }

    const oldSch = oldResolved.node;
    const newSch = newResolved.node;
    const refKey = (oldResolved.chain[0] || '') + '->' + (newResolved.chain[0] || '');

    // 循环检测：同一对 (旧引用, 新引用) 在同一栈上已展开过
    if (seen.has(refKey) && refKey !== '->') {
      return;
    }
    const nextSeen = refKey !== '->' ? new Set(seen).add(refKey) : seen;

    const refInfo =
      oldResolved.chain.length || newResolved.chain.length
        ? [].concat(oldResolved.chain.map((r) => '旧:' + r), newResolved.chain.map((r) => '新:' + r))
        : null;

    const oldIsBool = oldSch === true || oldSch === false;
    const newIsBool = newSch === true || newSch === false;

    if (oldIsBool || newIsBool) {
      this.compareBool(path, name, oldSch, newSch, refInfo);
      return;
    }
    if (!isObject(oldSch) || !isObject(newSch)) {
      // 极端异常结构，不继续递归
      return;
    }

    const oldTypes = normTypes(oldSch);
    const newTypes = normTypes(newSch);

    this.compareType(path, name, oldTypes, newTypes, refInfo);

    // 类型集合：只要两边都"可能是对象"才深入比对对象结构，避免误报
    const oldMayObject = !oldTypes || oldTypes.includes('object');
    const newMayObject = !newTypes || newTypes.includes('object');
    if (oldMayObject && newMayObject) {
      this.compareObject(path, oldSch, newSch, nextSeen, refInfo);
    }

    const oldMayArray = !oldTypes || oldTypes.includes('array');
    const newMayArray = !newTypes || newTypes.includes('array');
    if (oldMayArray && newMayArray) {
      this.compareArray(path, oldSch, newSch, nextSeen, refInfo);
    }

    this.compareEnumConst(path, name, oldSch, newSch, refInfo);
    this.compareStringRules(path, oldSch, newSch, refInfo);
    this.compareNumberRules(path, oldSch, newSch, refInfo);
    this.compareUniqueItems(path, oldSch, newSch, refInfo);
    this.notifyCombiners(path, oldSch, newSch);
  }

  /* ---------------- 类型 ---------------- */

  compareType(path, name, oldTypes, newTypes, refInfo) {
    if (!oldTypes && !newTypes) return;

    if (oldTypes && newTypes) {
      const removed = oldTypes.filter((t) => !newTypes.includes(t));
      const added = newTypes.filter((t) => !oldTypes.includes(t));

      if (removed.length === 0 && added.length === 0) return;

      if (removed.length && added.length) {
        // 类型替换：旧读取方和旧写入方都可能踩雷
        this.emit({
          kind: 'type_changed',
          path,
          name,
          reader: 'breaking',
          writer: 'breaking',
          detail:
            `类型由 [${oldTypes.join(', ')}] 变为 [${newTypes.join(', ')}]。` +
            `旧读取方按 ${removed.join('/')} 解析新数据会失败；旧写入方产出的 ${removed.join('/')} 值也无法通过新校验。`,
          oldValue: oldTypes.join('|'),
          newValue: newTypes.join('|'),
          ref: refInfo,
        });
      } else if (added.length) {
        // 新增允许类型：放宽 → 旧读取方面临意料之外的新类型
        this.emit({
          kind: 'type_added',
          path,
          name,
          reader: 'breaking',
          writer: 'safe',
          detail: `新增允许类型 ${added.join('|')}（[${oldTypes.join(', ')}] → [${newTypes.join(', ')}]）。旧读取方只认识旧类型，遇到新类型数据可能解析失败。`,
          oldValue: oldTypes.join('|'),
          newValue: newTypes.join('|'),
          ref: refInfo,
        });
      } else {
        // 收窄允许类型：旧写入方仍可能输出被移除的类型
        this.emit({
          kind: 'type_removed',
          path,
          name,
          reader: 'safe',
          writer: 'breaking',
          detail: `允许类型由 [${oldTypes.join(', ')}] 收窄为 [${newTypes.join(', ')}]。旧写入方若产出 ${removed.join('/')} 类型，将无法通过新校验。`,
          oldValue: oldTypes.join('|'),
          newValue: newTypes.join('|'),
          ref: refInfo,
        });
      }
    } else if (newTypes) {
      // 无类型 → 限定类型：收紧
      this.emit({
        kind: 'type_added',
        path,
        name,
        reader: 'safe',
        writer: 'breaking',
        detail: `新增类型约束 [${newTypes.join(', ')}]（原先无类型限制，任意类型均合法）。旧写入方产出其它类型将被新校验拒绝。`,
        oldValue: 'any',
        newValue: newTypes.join('|'),
        ref: refInfo,
      });
    } else {
      // 限定类型 → 无类型：放宽
      this.emit({
        kind: 'type_removed',
        path,
        name,
        reader: 'warning',
        writer: 'safe',
        detail: `移除类型约束（[${oldTypes.join(', ')}] → 任意类型）。旧读取方预期 ${oldTypes.join('/')}，现在可能收到任意类型，需确认容错。`,
        oldValue: oldTypes.join('|'),
        newValue: 'any',
        ref: refInfo,
      });
    }
  }

  /* ---------------- 对象 ---------------- */

  compareObject(path, oldSch, newSch, seen, refInfo) {
    const oldProps = isObject(oldSch.properties) ? oldSch.properties : {};
    const newProps = isObject(newSch.properties) ? newSch.properties : {};
    const oldReq = new Set(Array.isArray(oldSch.required) ? oldSch.required : []);
    const newReq = new Set(Array.isArray(newSch.required) ? newSch.required : []);

    const names = new Set([...Object.keys(oldProps), ...Object.keys(newProps)]);
    for (const prop of [...names].sort()) {
      // RFC 6901：属性名中的 ~ 编为 ~0、/ 编为 ~1，避免路径被错误拆分
      const p = path + '/properties/' + encodeToken(prop);
      const inOld = prop in oldProps;
      const inNew = prop in newProps;
      const wasReq = oldReq.has(prop);
      const nowReq = newReq.has(prop);

      if (inOld && !inNew) {
        // 属性从定义中移除
        // 读取方风险取决于 additionalProperties：旧读取方仍认这个字段，但新数据不再保证产出
        const ap = newSch.additionalProperties;
        const locked = ap === false;
        this.emit({
          kind: 'prop_removed',
          path: p,
          name: prop,
          reader: locked ? 'breaking' : 'warning',
          writer: 'safe',
          detail: locked
            ? `属性 "${prop}" 被移除，且新 schema 封闭了额外属性（additionalProperties: false），旧读取方读取该字段的新数据时必定落空。`
            : `属性 "${prop}" 被移除。新数据不再保证包含该字段，依赖它的旧读取方需改为容错读取（字段缺失给默认值）。旧写入方继续产出该字段通常无害。`,
          oldValue: preview(oldProps[prop]),
          ref: refInfo,
        });
        continue;
      }

      if (!inOld && inNew) {
        // 新增属性
        if (nowReq) {
          this.emit({
            kind: 'prop_added',
            path: p,
            name: prop,
            reader: 'safe',
            writer: 'breaking',
            detail: `新增必填属性 "${prop}"。旧写入方不产出该字段，无法通过新版本校验；旧读取方不感知新字段，不受影响。`,
            newValue: preview(newProps[prop]),
            ref: refInfo,
          });
        } else {
          this.emit({
            kind: 'prop_added',
            path: p,
            name: prop,
            reader: 'safe',
            writer: 'safe',
            detail: `新增选填属性 "${prop}"。旧读取方忽略未知字段、旧写入方暂不产出，双向兼容（默认 additionalProperties 允许时）。`,
            newValue: preview(newProps[prop]),
            ref: refInfo,
          });
        }
        continue;
      }

      // 两边都存在：递归比对子 schema
      this.walk(p, prop, oldProps[prop], newProps[prop], seen);

      // 必填性变化
      if (!wasReq && nowReq) {
        this.emit({
          kind: 'required_added',
          path: p + '/required',
          name: prop,
          reader: 'safe',
          writer: 'breaking',
          detail: `属性 "${prop}" 由选填变为必填。旧写入方可能漏写该字段（或显式写 null），将被新校验拒绝。`,
          oldValue: 'optional',
          newValue: 'required',
          ref: refInfo,
        });
      } else if (wasReq && !nowReq) {
        this.emit({
          kind: 'required_removed',
          path: p + '/required',
          name: prop,
          reader: 'warning',
          writer: 'safe',
          detail: `属性 "${prop}" 由必填变为选填。新数据可能缺失该字段，旧读取方必须容忍 undefined / null，否则会空指针。`,
          oldValue: 'required',
          newValue: 'optional',
          ref: refInfo,
        });
      }
    }

    this.compareAdditionalProperties(path, oldSch, newSch, seen, refInfo);
  }

  compareAdditionalProperties(path, oldSch, newSch, seen, refInfo) {
    const hasOld = 'additionalProperties' in oldSch;
    const hasNew = 'additionalProperties' in newSch;
    const oldAp = hasOld ? oldSch.additionalProperties : true; // 默认允许
    const newAp = hasNew ? newSch.additionalProperties : true;

    // 只报告真正发生变化的情况
    if (stable(oldAp) === stable(newAp)) return;

    const oldLocked = oldAp === false;
    const newLocked = newAp === false;

    if (newLocked && !oldLocked) {
      this.emit({
        kind: 'additional_locked',
        path: path + '/additionalProperties',
        name: 'additionalProperties',
        reader: 'breaking',
        writer: 'breaking',
        detail:
          'additionalProperties 被设为 false，对象从"允许额外字段"变为"封闭"。' +
          '旧读取方依赖的既有字段若在新定义中缺失将无法读到；旧写入方携带的任何额外字段都会被新校验拒绝。',
        oldValue: preview(oldAp),
        newValue: 'false',
        ref: refInfo,
      });
      return;
    }

    if (oldLocked && !newLocked) {
      this.emit({
        kind: 'additional_loosened',
        path: path + '/additionalProperties',
        name: 'additionalProperties',
        reader: 'warning',
        writer: 'safe',
        detail: 'additionalProperties 由 false 放开。新数据可能携带旧读取方不认识的额外字段，确认读取方会忽略未知字段。',
        oldValue: 'false',
        newValue: preview(newAp),
        ref: refInfo,
      });
      return;
    }

    // 两侧均为 schema 对象：递归比较其约束（子路径 finding 会说明具体差异）
    if (isObject(oldAp) && isObject(newAp)) {
      this.walk(path + '/additionalProperties', 'additionalProperties', oldAp, newAp, seen);
    } else {
      // true(允许) <-> schema 等其它变化，按收紧/放宽提示
      this.emit({
        kind: 'additional_schema',
        path: path + '/additionalProperties',
        name: 'additionalProperties',
        reader: newAp === true ? 'warning' : 'safe',
        writer: newAp === true ? 'safe' : 'breaking',
        detail: newAp === true
          ? '额外属性从带 schema 约束变为完全放开，旧读取方可能收到形态未知的额外字段。'
          : '额外属性新增了 schema 约束，旧写入方携带的额外字段若不满足将被拒绝。',
        oldValue: preview(oldAp),
        newValue: preview(newAp),
        ref: refInfo,
      });
    }
  }

  /* ---------------- 数组 ---------------- */

  compareArray(path, oldSch, newSch, seen, refInfo) {
    const oldItems = oldSch.items;
    const newItems = newSch.items;
    if (oldItems === undefined && newItems === undefined) {
      this.compareArrayBounds(path, oldSch, newSch, refInfo);
      return;
    }

    const oldTuple = Array.isArray(oldItems);
    const newTuple = Array.isArray(newItems);

    if (!oldTuple && !newTuple) {
      // 单 schema 形式：递归比较元素
      if (isObject(oldItems) && isObject(newItems)) {
        this.walk(path + '/items', 'items', oldItems, newItems, seen);
      } else if (stable(oldItems) !== stable(newItems)) {
        const newlyAdded = oldItems === undefined && newItems !== undefined;
        this.emit({
          kind: 'items_schema_changed',
          path: path + '/items',
          name: 'items',
          reader: newlyAdded ? 'safe' : 'warning',
          writer: newlyAdded ? 'breaking' : 'safe',
          detail: newlyAdded
            ? '新增数组元素 schema 约束。旧写入方产出的元素可能不满足新约束，将被拒绝。'
            : '移除数组元素 schema 约束。旧读取方预期元素具有固定结构，需容忍任意形态元素。',
          oldValue: preview(oldItems),
          newValue: preview(newItems),
          ref: refInfo,
        });
      }
    } else if (oldTuple !== newTuple) {
      // 元组（items 为数组）与列表（items 为单 schema）形式互相转换
      this.emit({
        kind: 'items_schema_changed',
        path: path + '/items',
        name: 'items',
        reader: 'breaking',
        writer: 'breaking',
        detail:
          '数组 items 由' + (oldTuple ? '元组（定长、按位置异构）' : '列表（元素同构）') +
          '变为' + (newTuple ? '元组（定长、按位置异构）' : '列表（元素同构）') +
          '，长度与按位置解析的假设均改变，读取方与写入方都需改造。',
        oldValue: oldTuple ? 'tuple[' + oldItems.length + ']' : preview(oldItems),
        newValue: newTuple ? 'tuple[' + newItems.length + ']' : preview(newItems),
        ref: refInfo,
      });
    } else {
      // 元组形式（items 为数组）逐位置比较
      const oldArr = oldTuple ? oldItems : [];
      const newArr = newTuple ? newItems : [];
      const len = Math.max(oldArr.length, newArr.length);
      for (let i = 0; i < len; i++) {
        const ip = path + '/items/' + i;
        if (i >= oldArr.length) {
          this.emit({
            kind: 'items_tuple_added',
            path: ip,
            name: '[' + i + ']',
            reader: 'safe',
            writer: newSch.minItems !== undefined && i < newSch.minItems ? 'breaking' : 'warning',
            detail:
              '元组新增第 ' + i + ' 位元素。' +
              (newSch.minItems !== undefined && i < newSch.minItems
                ? '且 minItems 要求包含该位置，旧写入方产出的短数组将被拒绝。'
                : '旧写入方不提供该位置时通常仍兼容；旧读取方遇到更长的数组需忽略多余元素。'),
            newValue: preview(newArr[i]),
            ref: refInfo,
          });
        } else if (i >= newArr.length) {
          this.emit({
            kind: 'items_tuple_removed',
            path: ip,
            name: '[' + i + ']',
            reader: 'warning',
            writer: 'safe',
            detail: '元组第 ' + i + ' 位元素被移除。旧读取方预期该位置存在，新数组可能更短，需做越界容错。',
            oldValue: preview(oldArr[i]),
            ref: refInfo,
          });
        } else if (isObject(oldArr[i]) && isObject(newArr[i])) {
          this.walk(ip, '[' + i + ']', oldArr[i], newArr[i], seen);
        }
      }
    }

    this.compareArrayBounds(path, oldSch, newSch, refInfo);
  }

  compareArrayBounds(path, oldSch, newSch, refInfo) {
    this.compareBound(path, 'minItems', oldSch.minItems, newSch.minItems, refInfo, {
      inc: { kind: 'length_min_increased' },
      dec: { kind: 'length_min_decreased' },
      label: '数组最小长度 minItems',
    });
    this.compareBound(path, 'maxItems', oldSch.maxItems, newSch.maxItems, refInfo, {
      inc: { kind: 'length_max_increased' }, // 数值变大 = 放宽
      dec: { kind: 'length_max_decreased' }, // 数值变小 = 收紧
      reversed: true,
      label: '数组最大长度 maxItems',
    });
  }

  /* ---------------- enum / const ---------------- */

  compareEnumConst(path, name, oldSch, newSch, refInfo) {
    // const
    if ('const' in oldSch || 'const' in newSch) {
      if (stable(oldSch.const) !== stable(newSch.const)) {
        this.emit({
          kind: 'const_changed',
          path: path + '/const',
          name: 'const',
          reader: 'breaking',
          writer: 'breaking',
          detail:
            oldSch.const === undefined
              ? `新增常量约束，值固定为 ${preview(newSch.const)}。旧写入方产出其它值将被拒绝。`
              : newSch.const === undefined
              ? `移除常量约束（原值 ${preview(oldSch.const)}）。旧读取方预期拿到固定值，需容忍其它取值。`
              : `常量值由 ${preview(oldSch.const)} 变为 ${preview(newSch.const)}，旧读取方与旧写入方互不兼容。`,
          oldValue: preview(oldSch.const),
          newValue: preview(newSch.const),
          ref: refInfo,
        });
      }
      return; // const 与 enum 同时出现时以 const 为准
    }

    // enum
    if (Array.isArray(oldSch.enum) || Array.isArray(newSch.enum)) {
      const oldList = Array.isArray(oldSch.enum) ? oldSch.enum : null;
      const newList = Array.isArray(newSch.enum) ? newSch.enum : null;

      if (oldList && newList) {
        const oldSet = new Map(oldList.map((v) => [stable(v), v]));
        const newSet = new Map(newList.map((v) => [stable(v), v]));
        const added = [...newSet.keys()].filter((k) => !oldSet.has(k)).map((k) => newSet.get(k));
        const removed = [...oldSet.keys()].filter((k) => !newSet.has(k)).map((k) => oldSet.get(k));

        if (!added.length && !removed.length) return;

        if (added.length && removed.length) {
          this.emit({
            kind: 'enum_changed',
            path: path + '/enum',
            name: 'enum',
            reader: 'breaking',
            writer: 'breaking',
            detail: `枚举同时新增 [${added.map(preview).join(', ')}]、移除 [${removed
              .map(preview)
              .join(', ')}]。旧读取方不认识新值，旧写入方可能继续写被删的值，双向均破坏。`,
            oldValue: oldList.map(preview).join(' | '),
            newValue: newList.map(preview).join(' | '),
            ref: refInfo,
          });
        } else if (added.length) {
          this.emit({
            kind: 'enum_added',
            path: path + '/enum',
            name: 'enum',
            reader: 'breaking',
            writer: 'safe',
            detail: `枚举新增取值 [${added
              .map(preview)
              .join(', ')}]。旧读取方的 switch/映射没有这些分支，收到新值会落到 default 或报错；旧写入方继续写旧值合法。`,
            oldValue: oldList.map(preview).join(' | '),
            newValue: newList.map(preview).join(' | '),
            ref: refInfo,
          });
        } else {
          this.emit({
            kind: 'enum_removed',
            path: path + '/enum',
            name: 'enum',
            reader: 'safe',
            writer: 'breaking',
            detail: `枚举移除取值 [${removed
              .map(preview)
              .join(', ')}]。旧写入方可能继续产出这些值，将被新校验拒绝；旧读取方认识的子集仍在，读取不受影响。`,
            oldValue: oldList.map(preview).join(' | '),
            newValue: newList.map(preview).join(' | '),
            ref: refInfo,
          });
        }
      } else if (newList) {
        this.emit({
          kind: 'enum_added',
          path: path + '/enum',
          name: 'enum',
          reader: 'safe',
          writer: 'breaking',
          detail: `新增枚举约束 [${newList.map(preview).join(', ')}]（原先任意值合法）。旧写入方产出枚举之外的值将被拒绝。`,
          newValue: newList.map(preview).join(' | '),
          ref: refInfo,
        });
      } else {
        this.emit({
          kind: 'enum_removed',
          path: path + '/enum',
          name: 'enum',
          reader: 'warning',
          writer: 'safe',
          detail: `移除枚举约束（原取值 [${oldList.map(preview).join(', ')}]）。旧读取方只会处理这些已知值，需确认能容忍范围外的新值。`,
          oldValue: oldList.map(preview).join(' | '),
          ref: refInfo,
        });
      }
    }
  }

  /* ---------------- 字符串 / 数值约束 ---------------- */

  compareStringRules(path, oldSch, newSch, refInfo) {
    // pattern
    if ('pattern' in oldSch || 'pattern' in newSch) {
      if ((oldSch.pattern || '') !== (newSch.pattern || '')) {
        this.emit({
          kind: 'pattern_changed',
          path: path + '/pattern',
          name: 'pattern',
          reader: 'warning',
          writer: 'warning',
          detail: `正则模式由 ${preview(oldSch.pattern) || '(无)'} 变为 ${
            preview(newSch.pattern) || '(无)'
          }。模式语义无法自动判断松紧，请人工确认：收紧→旧写入方受影响，放宽→旧读取方需容忍新格式。`,
          oldValue: preview(oldSch.pattern),
          newValue: preview(newSch.pattern),
          ref: refInfo,
        });
      }
    }

    // format
    if (('format' in oldSch) || ('format' in newSch)) {
      if ((oldSch.format || '') !== (newSch.format || '')) {
        this.emit({
          kind: 'format_changed',
          path: path + '/format',
          name: 'format',
          reader: 'warning',
          writer: 'warning',
          detail: `format 由 "${oldSch.format || '无'}" 变为 "${
            newSch.format || '无'
          }"。format 默认仅作注解、不强制，按贵方校验严格程度人工确认。`,
          oldValue: oldSch.format,
          newValue: newSch.format,
          ref: refInfo,
        });
      }
    }

    // minLength / maxLength（注意长度规则与 min/maxItems 方向一致）
    this.compareBound(path, 'minLength', oldSch.minLength, newSch.minLength, refInfo, {
      inc: { kind: 'length_min_increased' },
      dec: { kind: 'length_min_decreased' },
      label: '最小长度 minLength',
    });
    this.compareBound(path, 'maxLength', oldSch.maxLength, newSch.maxLength, refInfo, {
      inc: { kind: 'length_max_increased' },
      dec: { kind: 'length_max_decreased' },
      reversed: true,
      label: '最大长度 maxLength',
    });
  }

  compareNumberRules(path, oldSch, newSch, refInfo) {
    // minimum / exclusiveMinimum：数值变大=收紧(writer breaking)，变小=放宽
    this.compareBound(path, 'minimum', oldSch.minimum, newSch.minimum, refInfo, {
      inc: { kind: 'number_min_increased' },
      dec: { kind: 'number_min_decreased' },
      label: '下限 minimum',
    });
    this.compareBound(path, 'exclusiveMinimum', oldSch.exclusiveMinimum, newSch.exclusiveMinimum, refInfo, {
      inc: { kind: 'number_min_increased' },
      dec: { kind: 'number_min_decreased' },
      label: '排他下限 exclusiveMinimum',
    });
    // maximum：数值变小=收紧
    this.compareBound(path, 'maximum', oldSch.maximum, newSch.maximum, refInfo, {
      inc: { kind: 'number_max_increased' },
      dec: { kind: 'number_max_decreased' },
      reversed: true,
      label: '上限 maximum',
    });
    this.compareBound(path, 'exclusiveMaximum', oldSch.exclusiveMaximum, newSch.exclusiveMaximum, refInfo, {
      inc: { kind: 'number_max_increased' },
      dec: { kind: 'number_max_decreased' },
      reversed: true,
      label: '排他上限 exclusiveMaximum',
    });
  }

  /**
   * 通用数值边界比较。
   * 默认方向：新值变大=收紧(writer breaking/reader safe)；reversed 时对调（如 max* 变小=收紧）。
   */
  compareBound(path, key, oldVal, newVal, refInfo, opts) {
    const o = typeof oldVal === 'number' ? oldVal : null;
    const n = typeof newVal === 'number' ? newVal : null;
    if (o === null && n === null) return;

    const sub = path + '/' + key;

    if (o !== null && n !== null && o === n) return;

    const tightening = (o === null && n !== null) || (o !== null && n !== null && (opts.reversed ? n < o : n > o));
    const loosening = (n === null && o !== null) || (o !== null && n !== null && (opts.reversed ? n > o : n < o));

    if (tightening) {
      this.emit({
        kind: opts.reversed ? opts.dec.kind : opts.inc.kind,
        path: sub,
        name: key,
        reader: 'safe',
        writer: 'breaking',
        detail:
          `${opts.label} 收紧（${o === null ? '未限制' : o} → ${n}）。` +
          (o === null
            ? '旧写入方此前不受此限，可能产出不满足新边界的值。'
            : '旧写入方若产出落在原范围内、新范围外的值，将被新校验拒绝。'),
        oldValue: o === null ? undefined : String(o),
        newValue: String(n),
        ref: refInfo,
      });
    } else if (loosening) {
      this.emit({
        kind: opts.reversed ? opts.inc.kind : opts.dec.kind,
        path: sub,
        name: key,
        reader: 'warning',
        writer: 'safe',
        detail:
          `${opts.label} 放宽（${o} → ${n === null ? '未限制' : n}）。` +
          '新数据可能落在旧边界之外，旧读取方需确认不会因越界值出错（如截断、溢出、假设失效）。',
        oldValue: String(o),
        newValue: n === null ? undefined : String(n),
        ref: refInfo,
      });
    }
  }

  compareUniqueItems(path, oldSch, newSch, refInfo) {
    const o = oldSch.uniqueItems === true;
    const n = newSch.uniqueItems === true;
    if (o === n) return;
    if (n && !o) {
      this.emit({
        kind: 'uniqueitems_on',
        path: path + '/uniqueItems',
        name: 'uniqueItems',
        reader: 'safe',
        writer: 'breaking',
        detail: '开启 uniqueItems，旧写入方产出含重复元素的数组将被新校验拒绝。',
        oldValue: 'false',
        newValue: 'true',
        ref: refInfo,
      });
    } else {
      this.emit({
        kind: 'uniqueitems_off',
        path: path + '/uniqueItems',
        name: 'uniqueItems',
        reader: 'warning',
        writer: 'safe',
        detail: '关闭 uniqueItems，新数组可能含重复元素，旧读取方若假设元素唯一（如去重索引、Map 覆盖逻辑）需复查。',
        oldValue: 'true',
        newValue: 'false',
        ref: refInfo,
      });
    }
  }

  /* ---------------- 布尔 schema / 组合关键字 ---------------- */

  compareBool(path, name, oldSch, newSch, refInfo) {
    if (oldSch === newSch) return;
    // true = 接受一切（{}），false = 拒绝一切
    const label = (v) => (v === true ? 'true（接受任意值）' : v === false ? 'false（拒绝一切）' : preview(v));
    this.emit({
      kind: 'bool_schema_changed',
      path,
      name,
      reader: newSch === false ? 'breaking' : 'warning',
      writer: newSch === false ? 'breaking' : oldSch === false ? 'safe' : 'warning',
      detail: `布尔 schema 由 ${label(oldSch)} 变为 ${label(newSch)}。`,
      oldValue: label(oldSch),
      newValue: label(newSch),
      ref: refInfo,
    });
  }

  notifyCombiners(path, oldSch, newSch) {
    for (const key of ['allOf', 'oneOf', 'anyOf']) {
      const o = Array.isArray(oldSch[key]);
      const n = Array.isArray(newSch[key]);
      if (o || n) {
        this.emit({
          kind: 'combiner_notice',
          path: path + '/' + key,
          name: key,
          reader: 'info',
          writer: 'info',
          detail:
            `检测到 ${key} 组合关键字${o !== n ? '（一侧新增/移除）' : '（两侧均有）'}。` +
            '本工具不会展开组合子 schema 的交集/并集语义做精确判定，请人工核对该分支下的兼容性。',
          oldValue: o ? oldSch[key].length + ' 个分支' : undefined,
          newValue: n ? newSch[key].length + ' 个分支' : undefined,
        });
      }
    }
  }
}

/**
 * 比对入口。
 * @returns {{ findings: Array, summary: object }}
 */
function compareSchemas(oldRoot, newRoot) {
  if (!isObject(oldRoot)) throw new CompareError('旧 Schema 根节点必须是 JSON 对象。');
  if (!isObject(newRoot)) throw new CompareError('新 Schema 根节点必须是 JSON 对象。');

  const differ = new Differ(oldRoot, newRoot);
  differ.walk('', '(root)', oldRoot, newRoot, new Set());

  const findings = differ.findings;
  const summary = {
    total: findings.length,
    reader: countBy(findings, 'reader'),
    writer: countBy(findings, 'writer'),
  };
  return { findings, summary };
}

function countBy(findings, side) {
  const c = { breaking: 0, warning: 0, safe: 0, info: 0 };
  for (const f of findings) c[f[side]]++;
  return c;
}

module.exports = { compareSchemas, CompareError, KIND_META, LEVELS, RANK };
