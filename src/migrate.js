'use strict';

const { humanPath } = require('./refs');

/**
 * migrate.js —— 有序迁移清单生成
 *
 * 两种策略（行业通行的 Expand / Contract 双发模式）：
 *
 *  reader（保读取方兼容 / Backward 兼容，消费侧先行）：
 *    阶段 1  读取方先升级，做到"新数据也能读"（容忍新字段/新枚举/放宽值）
 *    阶段 2  写入方切换到新 Schema（收紧类变更此前读取方已不依赖旧口径）
 *    阶段 3  清理旧分支、旧默认值与兼容代码
 *
 *  writer（保写入方兼容 / Forward 兼容，生产侧先行）：
 *    阶段 1  写入方先升级，在旧校验仍生效时"新旧双发"（补必填、去非法值、双格式）
 *    阶段 2  读取方升级到新 Schema 并切换校验
 *    阶段 3  停止旧字段/旧枚举的产出，清理兼容代码
 *
 * 仅对当前策略下非 safe 的 finding 生成步骤；同阶段内按 finding id 升序，
 * 保证切换策略 / 重复比对时结果稳定。
 */

/** 路径片段转为人类可读定位（显示真实字段名；规范 Pointer 仍保存在 f.path / item.path） */
function locate(f) {
  return humanPath(f.path);
}

/**
 * 每个 finding 在两种策略下的步骤。
 * 返回 [{ phase: 1|2|3, text }]；当前策略侧级别为 safe 时不生成。
 */
const PLANS = {
  prop_added(f, side) {
    if (side === 'reader') {
      // 新必填对旧写入方是 breaking：读取方其实无影响，真正动作在写入方
      return [
        { phase: 2, text: `写入方开始产出新属性 ${locate(f)}；读取方保持忽略未知字段即可。` },
        { phase: 3, text: '确认全链路写入方均已产出该字段后，将其固化为必填。' },
      ];
    }
    return [
      { phase: 1, text: `写入方先以"选填"形式新增属性 ${locate(f)}，与旧字段双发，确保旧校验通过。` },
      { phase: 2, text: '读取方部署支持新字段的版本后，再把该属性升级为必填并切换校验。' },
      { phase: 3, text: '核对所有写入方覆盖率 100%，移除字段缺失时的兜底逻辑。' },
    ];
  },

  prop_removed(f, side) {
    if (side === 'reader') {
      return [
        { phase: 1, text: `改造所有读取 ${locate(f)} 的消费方：字段缺失时使用默认值 / 空值兜底，禁止直接解引用。` },
        { phase: 2, text: '读取方全量上线后，写入方停止产出该字段。' },
        { phase: 3, text: '删除读取方针对该字段的旧解析分支与数据模型。' },
      ];
    }
    return [
      { phase: 3, text: `读取方全部停止依赖 ${locate(f)} 后，写入方才可停止产出并从 Schema 移除。` },
    ];
  },

  required_added(f, side) {
    if (side === 'reader') {
      return [
        { phase: 2, text: `写入方补齐 ${locate(f)} 后再切换为必填；读取方无需改造。` },
      ];
    }
    return [
      { phase: 1, text: `写入方先保证全量数据都包含 ${locate(f)}（历史数据回填或默认值），新旧版本同时合法。` },
      { phase: 2, text: '数据覆盖率达标后，Schema 中把该字段改为必填并由读取方启用校验。' },
      { phase: 3, text: '移除回填脚本与缺省兜底。' },
    ];
  },

  required_removed(f, side) {
    if (side === 'reader') {
      return [
        { phase: 1, text: `读取方为 ${locate(f)} 增加缺失 / null 容错（默认值、空判断）。` },
        { phase: 2, text: '容错版本全量上线后，写入方可停止保证该字段。' },
      ];
    }
    return [{ phase: 3, text: `读取方全部能处理 ${locate(f)} 缺失后，再从 required 中移除。` }];
  },

  type_changed(f) {
    return [
      { phase: 1, text: `写入方对 ${locate(f)} 做双格式输出（同时给出旧类型与新类型字段），或与读取方约定过渡期可识别的包装结构。` },
      { phase: 2, text: '读取方升级解析逻辑，支持新类型并灰度切换。' },
      { phase: 3, text: '读取方完成切换后，写入方停止旧类型输出，删除旧解析代码。' },
    ];
  },

  type_added(f, side) {
    if (side === 'reader') {
      return [
        { phase: 1, text: `读取方扩展 ${locate(f)} 的类型分支，覆盖新类型 ${f.newValue || ''}，未知类型走安全降级。` },
        { phase: 2, text: '读取方全量支持后，写入方方可产出新类型数据。' },
      ];
    }
    return [{ phase: 1, text: `写入方在过渡期不要产出新类型（${f.newValue || ''}），保持旧类型直至读取方升级。` }];
  },

  type_removed(f, side) {
    if (side === 'reader') {
      return [{ phase: 2, text: `读取方无需改造（仍认识保留类型）；写入方停止产出被移除类型后切换校验。` }];
    }
    return [
      { phase: 1, text: `写入方将 ${locate(f)} 的产出统一转换为保留类型（${f.newValue || ''}），清洗历史脏数据。` },
      { phase: 2, text: '线上不再出现被移除类型后，读取方启用收窄后的类型校验。' },
    ];
  },

  const_changed(f) {
    return [
      { phase: 1, text: `写入方与读取方约定 ${locate(f)} 的新旧常量值过渡期：写入方双发或读取方同时接受两值。` },
      { phase: 2, text: '读取方改为按新常量值判断后，写入方切换输出。' },
      { phase: 3, text: '删除对旧常量值的判断分支。' },
    ];
  },

  enum_added(f, side) {
    if (side === 'reader') {
      return [
        { phase: 1, text: `读取方补齐 ${locate(f)} 对新枚举值的处理分支，并让 default 分支安全（记日志 / 忽略，不抛错）。` },
        { phase: 2, text: '全部读取方上线后，写入方才开始产出新枚举值。' },
        { phase: 3, text: '清理读取方对新值的临时降级逻辑。' },
      ];
    }
    return [{ phase: 1, text: `写入方暂不产出新枚举值，等待读取方支持 ${locate(f)} 后再开放。` }];
  },

  enum_removed(f, side) {
    if (side === 'reader') {
      return [{ phase: 2, text: `读取方无需改造（保留值仍被认识）；写入方停止产出被删值后切换校验。` }];
    }
    return [
      { phase: 1, text: `写入方停止产出被删枚举值，历史数据映射为保留值（${locate(f)}）。` },
      { phase: 2, text: '确认线上数据不再出现被删值后，读取方启用新枚举校验。' },
      { phase: 3, text: '删除写入方对被删值的映射代码。' },
    ];
  },

  enum_changed(f) {
    return [
      { phase: 1, text: `读取方补齐 ${locate(f)} 新枚举分支；写入方停止产出被删枚举值（必要时数据回填映射）。` },
      { phase: 2, text: '双侧就绪后切换校验，写入方开始产出新值。' },
      { phase: 3, text: '删除新旧枚举值的临时兼容分支。' },
    ];
  },

  format_changed(f) {
    return [
      { phase: 1, text: `人工确认 ${locate(f)} 的格式语义（${f.oldValue || '无'} → ${
        f.newValue || '无'
      }）：写入方按新格式输出，读取方同时解析两种格式。` },
      { phase: 2, text: '读取方完成新格式解析切换。' },
      { phase: 3, text: '移除旧格式解析分支。' },
    ];
  },

  pattern_changed(f) {
    return [
      { phase: 1, text: `人工判定 ${locate(f)} 模式收紧还是放宽；收紧则写入方先清洗存量数据，放宽则读取方先容忍新格式。` },
      { phase: 2, text: '数据全部满足新模式后切换校验。' },
    ];
  },

  additional_locked(f) {
    return [
      { phase: 1, text: `盘点 ${locate(f)} 下实际流转的全部字段：读取方依赖的字段补进 properties，写入方停止携带任何额外字段。` },
      { phase: 2, text: '双侧清理完成后再设置 additionalProperties: false 并切换校验。' },
      { phase: 3, text: '删除对额外字段的透传 / 兜底代码。' },
    ];
  },

  additional_loosened(f, side) {
    if (side === 'reader') {
      return [
        { phase: 1, text: `确认 ${locate(f)} 的读取方均忽略未知字段（无严格反序列化、无白名单报错）。` },
      ];
    }
    return [];
  },

  additional_schema(f) {
    return [{ phase: 1, text: `按 ${locate(f)} 子路径列出的具体约束差异执行对应迁移动作。` }];
  },

  items_schema_changed(f) {
    return [{ phase: 1, text: `数组元素结构变化见 ${locate(f)} 的子条目，按其类型 / 必填 / 枚举等具体差异安排顺序。` }];
  },

  items_tuple_added(f, side) {
    if (side === 'reader') {
      return [
        { phase: 1, text: `读取方遍历数组时忽略多余位置元素，不做定长假设（${locate(f)}）。` },
        { phase: 2, text: '读取方上线后写入方可输出更长元组。' },
      ];
    }
    return [
      { phase: 1, text: `写入方在 minItems 收紧前保证该位置有值（${locate(f)}），必要时填默认元素。` },
      { phase: 2, text: '存量数据补齐后启用新 minItems 校验。' },
    ];
  },

  items_tuple_removed(f, side) {
    if (side === 'reader') {
      return [{ phase: 1, text: `读取方访问 ${locate(f)} 前做长度检查，容忍更短数组。` }];
    }
    return [{ phase: 3, text: '读取方全部完成越界容错后，写入方再停止产出该位置。' }];
  },

  bool_schema_changed(f) {
    return [
      { phase: 1, text: `确认 ${locate(f)} 由 ${f.oldValue} 变为 ${f.newValue} 的影响面：false 会拒绝全部实例，需与所有读写方对齐后再切换。` },
      { phase: 2, text: '影响方全部就绪后切换校验。' },
    ];
  },

  combiner_notice(f) {
    return [{ phase: 1, text: `人工展开 ${locate(f)} 的 ${f.name} 分支，核对交集/并集语义下的兼容性。` }];
  },

  uniqueitems_on(f, side) {
    if (side === 'reader') {
      return [{ phase: 2, text: '写入方完成去重后开启校验，读取方无需改造。' }];
    }
    return [
      { phase: 1, text: `写入方对 ${locate(f)} 对应数组去重，清洗存量重复数据。` },
      { phase: 2, text: '确认无重复后启用 uniqueItems 校验。' },
    ];
  },

  uniqueitems_off(f, side) {
    if (side === 'reader') {
      return [{ phase: 1, text: `复查读取方是否假设元素唯一（去重表、Map 覆盖），针对 ${locate(f)} 改为可重复处理。` }];
    }
    return [];
  },
};

/** 数值边界类（收紧 / 放宽）统一模板 */
function boundPlan(f, side, isTightening) {
  if (isTightening) {
    if (side === 'reader') {
      return [{ phase: 2, text: `写入方将 ${locate(f)} 的产出收敛到新边界内后切换校验，读取方无需改造。` }];
    }
    return [
      { phase: 1, text: `写入方把 ${locate(f)} 的产出收敛到新边界（${f.oldValue ?? '未限制'} → ${
        f.newValue
      }），并清洗越界存量数据。` },
      { phase: 2, text: '线上数据全部达标后，读取方启用收紧后的校验。' },
    ];
  }
  if (side === 'reader') {
    return [
      { phase: 1, text: `读取方确认 ${locate(f)} 能处理放宽后的值域（${f.oldValue} → ${
        f.newValue ?? '未限制'
      }），检查截断 / 溢出 / 边界假设。` },
    ];
  }
  return [];
}

const TIGHTEN_KINDS = new Set([
  'number_min_increased',
  'number_max_decreased',
  'length_min_increased',
  'length_max_decreased',
]);
const LOOSEN_KINDS = new Set([
  'number_min_decreased',
  'number_max_increased',
  'length_min_decreased',
  'length_max_increased',
]);

/**
 * 生成迁移清单
 * @param findings compare 输出
 * @param strategy 'reader' | 'writer'
 */
function buildPlan(findings, strategy) {
  const side = strategy === 'writer' ? 'writer' : 'reader';
  const items = [];

  for (const f of findings) {
    if (f[side] === 'safe') continue;

    let steps = null;
    if (PLANS[f.kind]) {
      steps = PLANS[f.kind](f, side);
    } else if (TIGHTEN_KINDS.has(f.kind)) {
      steps = boundPlan(f, side, true);
    } else if (LOOSEN_KINDS.has(f.kind)) {
      steps = boundPlan(f, side, false);
    } else {
      steps = [{ phase: 1, text: `处理 ${locate(f)} 的 "${f.name}" 变化（${f.detail}）` }];
    }

    for (const s of steps || []) {
      items.push({
        findingId: f.id,
        kind: f.kind,
        path: f.path,
        level: f[side],
        phase: s.phase,
        text: s.text,
      });
    }
  }

  // 稳定排序：阶段优先，阶段内按原始发现顺序
  items.sort((a, b) => a.phase - b.phase || a.findingId - b.findingId || a.text.localeCompare(b.text));

  const phaseTitles =
    side === 'reader'
      ? {
          1: '阶段 1 · 读取方先行（容忍新结构）',
          2: '阶段 2 · 写入方切换到新 Schema',
          3: '阶段 3 · 清理旧逻辑',
        }
      : {
          1: '阶段 1 · 写入方先行（双发 / 收敛产出）',
          2: '阶段 2 · 读取方升级并切换校验',
          3: '阶段 3 · 停止旧产出并清理',
        };

  const counts = { breaking: 0, warning: 0, safe: 0, info: 0 };
  for (const f of findings) counts[f[side]]++;

  return { strategy: side, items, phaseTitles, counts };
}

module.exports = { buildPlan };
