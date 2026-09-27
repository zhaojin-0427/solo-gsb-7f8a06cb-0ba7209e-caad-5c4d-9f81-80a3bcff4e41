'use strict';

const assert = require('assert');
const Ajv = require('ajv');
const { generateInstance } = require('../src/generate');

const ajv = new Ajv({ allErrors: true, strict: false });

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓', name);
  } catch (e) {
    console.error('  ✗', name, '\n   ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e);
    process.exitCode = 1;
  }
}

/** 生成结果必须再次通过 Ajv 整树复验（与 server 闸口径一致） */
function expectValid(name, schema, predicate) {
  check(name, () => {
    const inst = generateInstance(schema);
    const validate = ajv.compile(schema);
    assert.ok(validate(inst), '生成实例未通过 Ajv 复验：' + JSON.stringify(validate.errors));
    if (predicate) assert.ok(predicate(inst), '实例不满足预期：' + JSON.stringify(inst));
  });
}

function expectError(name, schema, code, schemaPathPart) {
  check(name, () => {
    let err;
    try {
      generateInstance(schema);
    } catch (e) {
      err = e;
    }
    assert.ok(err, '应当抛错但成功生成了：' + (err ? '' : ''));
    assert.strictEqual(err.code, code, `错误码期望 ${code}，实际 ${err.code}（${err.message}）`);
    if (schemaPathPart) {
      assert.ok(
        err.schemaPath.includes(schemaPathPart) ||
          (err.problems || []).some((p) => p.schemaPath.includes(schemaPathPart)),
        `错误路径期望包含 "${schemaPathPart}"，实际 schemaPath=${err.schemaPath}`
      );
    }
  });
}

/* ------------------------------ 核心修复 ------------------------------ */

console.log('enum 误拒修复');

expectValid(
  '题述场景：[{x:0},{x:1}] + properties.x integer minimum:1 + required，选到 {x:1}',
  {
    type: 'object',
    required: ['kind'],
    properties: {
      kind: {
        enum: [{ x: 0 }, { x: 1 }],
        type: 'object',
        required: ['x'],
        properties: { x: { type: 'integer', minimum: 1 } },
      },
    },
  },
  (inst) => JSON.stringify(inst.kind) === '{"x":1}'
);

expectValid(
  '数组顺序：前两个缺 required 字段，跳过并选第三个',
  {
    enum: [{ x: 1 }, { x: 2 }, { x: 3, y: 'abc' }],
    type: 'object',
    required: ['x', 'y'],
    properties: {
      x: { type: 'integer' },
      y: { type: 'string', minLength: 3 },
    },
  },
  (inst) => JSON.stringify(inst) === '{"x":3,"y":"abc"}'
);

expectValid(
  '候选全部合法时取第一个（保持原顺序语义）',
  { enum: [1, 2, 3], type: 'integer', minimum: 0 },
  (inst) => inst === 1
);

expectValid(
  '数组候选 + items/minItems 约束',
  {
    type: 'array',
    minItems: 2,
    items: { type: 'integer', minimum: 1 },
    enum: [[0], [1, 1], [2, 2]],
  },
  (inst) => JSON.stringify(inst) === '[1,1]'
);

expectValid(
  '字符串候选 minLength 浅约束仍生效',
  { enum: ['ab', 'abc'], type: 'string', minLength: 3 },
  (inst) => inst === 'abc'
);

expectValid(
  '候选对象里的约束经文档内本地 $ref 解析',
  {
    definitions: {
      Thing: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer', minimum: 10 } },
      },
    },
    properties: {
      thing: { enum: [{ id: 1 }, { id: 11 }], $ref: '#/definitions/Thing' },
    },
  }
);

expectValid(
  'enum 节点自身经 $ref 指向（enum 写在目标定义上）',
  {
    definitions: {
      Mode: {
        enum: [{ n: 0 }, { n: 1 }],
        type: 'object',
        required: ['n'],
        properties: { n: { type: 'integer', minimum: 1 } },
      },
    },
    type: 'object',
    required: ['mode'],
    properties: { mode: { $ref: '#/definitions/Mode' } },
  },
  (inst) => JSON.stringify(inst.mode) === '{"n":1}'
);

expectValid(
  'const 固定值通过完整复验（合法）',
  {
    const: { x: 1 },
    type: 'object',
    required: ['x'],
    properties: { x: { type: 'integer', minimum: 1 } },
  }
);

expectValid(
  '多个 enum 节点并存，各自取正确的子校验器',
  {
    type: 'object',
    required: ['a', 'b'],
    properties: {
      a: { enum: [0, 5], type: 'integer', minimum: 3 },
      b: { enum: [{ n: 0 }, { n: 2 }], type: 'object', required: ['n'],
           properties: { n: { type: 'integer', minimum: 1 } } },
    },
  },
  (inst) => inst.a === 5 && JSON.stringify(inst.b) === '{"n":2}'
);

expectValid(
  '根节点 enum（schemaPath 为空）',
  { enum: ['', 'ok'], type: 'string', minLength: 2 },
  (inst) => inst === 'ok'
);

expectValid(
  'enum 候选为数组、经 $ref items 复验',
  {
    definitions: { I: { type: 'integer', minimum: 1 } },
    type: 'array',
    minItems: 1,
    items: { $ref: '#/definitions/I' },
    enum: [[0], [0, 0], [1]],
  },
  (inst) => JSON.stringify(inst) === '[1]'
);

/* ------------------------------ 无解 / 矛盾 ------------------------------ */

console.log('无解 / 矛盾');

expectError(
  '候选均不合法 → unsatisfiable，路径指向 enum',
  { enum: [{ x: 0 }, { x: 1 }], type: 'object', required: ['x'],
    properties: { x: { type: 'integer', minimum: 5 } } },
  'unsatisfiable', '/enum'
);

expectError(
  'enum 空数组 → Ajv 编译期拒绝（invalid_schema，规范要求至少一个元素）',
  { enum: [], type: 'integer' },
  'invalid_schema'
);

expectError(
  'enum 候选都错类型 + 节点无其他约束 → unsatisfiable',
  { enum: ['a', 'b'], type: 'integer' },
  'unsatisfiable', '/enum'
);

expectError(
  'const 与嵌套属性约束矛盾 → contradiction，路径指向 const',
  { const: { x: 0 }, type: 'object', required: ['x'],
    properties: { x: { type: 'integer', minimum: 1 } } },
  'contradiction', '/const'
);

expectError(
  'const 不在 enum 中 → contradiction（保持原行为）',
  { const: 9, enum: [1, 2] },
  'contradiction', '/const'
);

expectError(
  'const 浅约束不过 + 节点带不支持关键字 → 立即 contradiction（保持原顺序）',
  { const: 'a', type: 'string', minLength: 5, pattern: '^x' },
  'contradiction'
);

expectError(
  'const 合法 + 节点带不支持关键字 → unsupported',
  { const: 'abc', type: 'string', minLength: 3, pattern: '^x' },
  'unsupported', '/pattern'
);

/* ------------------------------ 不支持关键字 ------------------------------ */

console.log('不支持关键字仍按路径拒绝');

expectError(
  'enum 节点自身带不支持关键字（如 pattern），有候选可过其他约束 → unsupported 且带路径',
  { enum: ['a', 'bb'], type: 'string', pattern: '^x' },
  'unsupported', '/pattern'
);

expectError(
  'enum 节点带不支持关键字，但候选连受支持约束都过不了 → 无解（新规则 unsatisfiable）',
  { enum: ['a'], type: 'string', minLength: 5, pattern: '^x' },
  'unsatisfiable'
);

expectError(
  'enum 候选对象的嵌套 properties 中藏 pattern → 补扫报路径并拒绝',
  {
    enum: [{ name: 'a' }, { name: 'bbb' }],
    type: 'object',
    properties: { name: { type: 'string', pattern: '^b+$' } },
  },
  'unsupported', '/properties/name/pattern'
);

expectError(
  '嵌套不支持点经 $ref 指向 definitions，路径落在定义节点上',
  {
    definitions: { S: { type: 'string', format: 'email' } },
    enum: [{ v: 'a' }, { v: 'b' }],
    type: 'object',
    properties: { v: { $ref: '#/definitions/S' } },
  },
  'unsupported', '/definitions/S/format'
);

expectError(
  'enum 数组候选的 items 里藏 multipleOf → 补扫报路径',
  {
    type: 'array',
    items: { type: 'integer', multipleOf: 3 },
    enum: [[1], [2]],
  },
  'unsupported', '/items/multipleOf'
);

/* ------------------------------ 回归：原有用法 ------------------------------ */

console.log('原有行为回归');

expectValid('示例 gen.schema.json 正常生成', require('../samples/gen.schema.json'));

expectValid(
  '普通 required 对象 / minItems / minLength / 整数边界',
  {
    type: 'object',
    required: ['s', 'i', 'arr'],
    properties: {
      s: { type: 'string', minLength: 3 },
      i: { type: 'integer', minimum: 1, maximum: 5 },
      arr: { type: 'array', minItems: 2, items: { type: 'boolean' } },
    },
  },
  (inst) => JSON.stringify(inst) === JSON.stringify({ s: 'aaa', i: 1, arr: [false, false] })
);

expectError(
  '布尔 false → unsatisfiable',
  false,
  'unsatisfiable'
);

expectError(
  '必填路径 $ref 环 → ref_cycle',
  (() => {
    const s = {
      type: 'object',
      required: ['self'],
      properties: { self: { $ref: '#/definitions/Loop' } },
    };
    s.definitions = { Loop: { type: 'object', required: ['back'], properties: { back: { $ref: '#/definitions/Loop' } } } };
    return s;
  })(),
  'ref_cycle'
);

expectValid(
  '可选自引用不展开（enum 之外路径）',
  {
    definitions: {
      Node: {
        type: 'object',
        required: ['v'],
        properties: { v: { type: 'integer' }, next: { $ref: '#/definitions/Node' } },
      },
    },
    $ref: '#/definitions/Node',
  },
  (inst) => JSON.stringify(inst) === '{"v":0}'
);

console.log(`\n${passed} 项通过` + (process.exitCode ? '，存在失败' : ''));
