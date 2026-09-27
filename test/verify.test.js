'use strict';

const assert = require('assert');
const {
  verifyInstances,
  parseInstances,
  normalizeErrors,
  precheckLocalRefs,
  VerifyError,
  MAX_INSTANCES,
} = require('../src/verify');
const { RefError } = require('../src/refs');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓', name);
  } catch (e) {
    console.error('  ✗', name, '\n   ', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e);
    process.exitCode = 1;
  }
}

function expectVerifyError(name, fn, code) {
  check(name, () => {
    let err;
    try {
      fn();
    } catch (e) {
      err = e;
    }
    assert.ok(err, '应当抛错但未抛');
    assert.ok(err instanceof VerifyError, '错误类型应为 VerifyError');
    if (code) assert.strictEqual(err.code, code, `错误码期望 ${code}，实际 ${err.code}`);
  });
}

const OLD = {
  type: 'object',
  required: ['id', 'name'],
  additionalProperties: false,
  properties: {
    id: { type: 'integer', minimum: 1 },
    name: { type: 'string' },
    email: { type: 'string' },
    m: { $ref: '#/definitions/M' },
  },
  definitions: {
    M: {
      type: 'object',
      required: ['a/b'],
      properties: { 'a/b': { type: 'string' }, 'x~y': { type: 'integer' } },
    },
  },
};

// 新版：新增必填 email、收紧 id 下限、m 的 a/b 要求整数、新增必填 x~y
const NEW = {
  type: 'object',
  required: ['id', 'name', 'email'],
  additionalProperties: false,
  properties: {
    id: { type: 'integer', minimum: 100 },
    name: { type: 'string' },
    email: { type: 'string' },
    m: { $ref: '#/definitions/M' },
  },
  definitions: {
    M: {
      type: 'object',
      required: ['a/b', 'x~y'],
      properties: { 'a/b': { type: 'integer' }, 'x~y': { type: 'integer' } },
    },
  },
};

console.log('分类与顺序');

check('四类分类正确且顺序与输入一致', () => {
  const instances = [
    { id: 100, name: 'a', email: 'e@x' },                                 // 0 both（m 两版均选填，省略）
    { id: 1, name: 'b', m: { 'a/b': 's' } },                              // 1 oldOnly
    { id: 100, name: 'c', email: 'e@x', m: { 'a/b': 2, 'x~y': 1 } },      // 2 newOnly
    { name: 42, email: 'e@x' },                                           // 3 bothFail（缺 id 且 name 类型错）
  ];

  const { summary, items } = verifyInstances(OLD, NEW, instances);
  assert.deepStrictEqual(summary, { total: 4, both: 1, oldOnly: 1, newOnly: 1, bothFail: 1 });
  assert.deepStrictEqual(items.map((i) => i.category), ['both', 'oldOnly', 'newOnly', 'bothFail']);
  assert.deepStrictEqual(items.map((i) => i.index), [0, 1, 2, 3]);
  assert.strictEqual(items[0].old.valid, true);
  assert.strictEqual(items[0].old.errors.length, 0);
});

check('仅旧版通过：错误来自新版（缺 email、id 下限、m.a/b 类型、m.x~y 必填）', () => {
  const inst = { id: 1, name: 'b', m: { 'a/b': 's' } };
  const { items } = verifyInstances(OLD, NEW, [inst]);
  const it = items[0];
  assert.strictEqual(it.category, 'oldOnly');
  const keywords = it.new.errors.map((e) => e.keyword).sort();
  assert.deepStrictEqual(keywords, ['minimum', 'required', 'required', 'type']);
});

console.log('JSON Pointer 定位与转义');

check('缺失必填字段定位到具体字段；~ 与 / 按 ~0 / ~1 转义', () => {
  const { items } = verifyInstances(OLD, NEW, [{ id: 1, name: 'b', m: {} }]);
  const ptrs = items[0].new.errors.filter((e) => e.keyword === 'required').map((e) => e.instancePath);
  assert.ok(ptrs.includes('/email'), '应定位 /email：' + JSON.stringify(ptrs));
  assert.ok(ptrs.includes('/m/x~0y'), '应定位 /m/x~0y：' + JSON.stringify(ptrs));
  assert.ok(ptrs.includes("/m/a~1b"), '应定位 /m/a~1b：' + JSON.stringify(ptrs));
});

check('多余属性定位到具体字段（additionalProperties 指针拼到字段）', () => {
  const { items } = verifyInstances(OLD, NEW, [{ id: 100, name: 'a', email: 'e', bogus: 1 }]);
  const err = items[0].new.errors.find((e) => e.keyword === 'additionalProperties');
  assert.ok(err, '应当有 additionalProperties 错误');
  assert.strictEqual(err.instancePath, '/bogus');
  assert.ok(/多余字段 "bogus"/.test(err.message));
});

check('字段名含 / 时指针编码为 ~1（含嵌套与斜杠）', () => {
  const { items } = verifyInstances(OLD, NEW, [{ id: 100, name: 'a', email: 'e', m: { 'a/b': 'str', 'x~y': 1 } }]);
  const typeErr = items[0].new.errors.find((e) => e.keyword === 'type');
  assert.ok(typeErr, '新版 m.a/b 要求整数，应有 type 错误');
  assert.strictEqual(typeErr.instancePath, '/m/a~1b');
});

check('根节点错误的 instancePath 为空字符串', () => {
  const { items } = verifyInstances({ type: 'string' }, { type: 'string' }, [1]);
  assert.strictEqual(items[0].category, 'bothFail');
  assert.strictEqual(items[0].old.errors[0].instancePath, '');
});

check('数组下标定位', () => {
  const schema = { type: 'array', items: { type: 'integer' } };
  const { items } = verifyInstances(schema, schema, [[1, 'x', 3]]);
  const err = items[0].old.errors[0];
  assert.strictEqual(err.instancePath, '/1');
  assert.strictEqual(err.keyword, 'type');
});

check('错误信息为中文且 schemaPath 去掉前导 #', () => {
  const { items } = verifyInstances(OLD, NEW, [{ id: 100, name: 'a', email: 'e', m: {} }]);
  const err = items[0].new.errors.find((e) => e.keyword === 'required');
  assert.ok(err, '新版 m 缺必填，应有 required 错误');
  assert.ok(err.message.includes('缺少必填字段'), err.message);
  assert.ok(!err.schemaPath.startsWith('#'), 'schemaPath 不应带前导 #：' + err.schemaPath);
});

console.log('中文类型回看');

check('type 错误补出实例实际类型（Ajv v8 不直接给 dataTypeName）', () => {
  const { items } = verifyInstances(
    { type: 'object', properties: { a: { type: 'string' } } },
    { type: 'object', properties: { a: { type: 'string' } } },
    [{ a: 1 }, { a: [] }, { a: null }]
  );
  assert.ok(items[0].old.errors[0].message.includes('实际为 数字'));
  assert.ok(items[1].old.errors[0].message.includes('实际为 数组'));
  assert.ok(items[2].old.errors[0].message.includes('实际为 null'));
});

console.log('输入解析');

expectVerifyError('空文本', () => parseInstances('   '), 'empty_instances');
expectVerifyError('非法 JSON', () => parseInstances('[{]'), 'invalid_instances_json');
expectVerifyError('根节点不是数组', () => parseInstances('{"x":1}'), 'instances_not_array');
expectVerifyError('空数组', () => parseInstances('[]'), 'instances_empty');
expectVerifyError(`超过 ${MAX_INSTANCES} 条`, () => parseInstances(JSON.stringify(new Array(MAX_INSTANCES + 1).fill(1))), 'too_many_instances');

check('恰好 100 条允许，1 条也允许', () => {
  assert.strictEqual(parseInstances(JSON.stringify(new Array(MAX_INSTANCES).fill(1))).length, MAX_INSTANCES);
  assert.strictEqual(parseInstances('[null]').length, 1);
});

console.log('Schema 侧');

expectVerifyError('旧 Schema 非法导致编译失败',
  () => verifyInstances({ type: 'bogus' }, {}, [1]), 'invalid_schema');
expectVerifyError('新 Schema 非法导致编译失败',
  () => verifyInstances({}, { type: 'bogus' }, [1]), 'invalid_schema');

check('外部引用预检抛 RefError', () => {
  let err;
  try {
    precheckLocalRefs({ $ref: 'https://example.com/s.json' });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof RefError);
  assert.ok(/外部引用/.test(err.message));
});

check('本地引用（含引用链 / 自引用）预检通过', () => {
  precheckLocalRefs(OLD);
  precheckLocalRefs({ definitions: { A: { $ref: '#/definitions/B' }, B: { type: 'object' } }, $ref: '#/definitions/A' });
});

check('嵌套结构里的外部引用也能检出（properties/items/allOf/dependencies）', () => {
  assert.throws(() => precheckLocalRefs({
    type: 'object',
    properties: { a: { $ref: './other.json' } },
  }), RefError);
  assert.throws(() => precheckLocalRefs({
    type: 'array',
    items: { allOf: [{ $ref: 'urn:foo' }] },
  }), RefError);
});

check('enum/const 实例值里碰巧出现 $ref 不算外部引用（不深入实例值）', () => {
  precheckLocalRefs({ type: 'object', properties: { k: { enum: [{ $ref: 'http://x' }] }, c: { const: { $ref: '#/x' } } } });
});

console.log('边界与稳定');

check('布尔 Schema true/false 正常参与校验', () => {
  const { items } = verifyInstances(true, false, [1, 'x', null, {}, []]);
  assert.ok(items.every((i) => i.old.valid === true));
  assert.ok(items.every((i) => i.new.valid === false));
  assert.ok(items.every((i) => i.category === 'oldOnly'));
});

check('错误数量封顶，附加截断提示', () => {
  const schema = { type: 'object', additionalProperties: false, properties: {} };
  const inst = {};
  for (let i = 0; i < 200; i++) inst['k' + i] = i;
  const { items } = verifyInstances(schema, schema, [inst]);
  const errs = items[0].old.errors;
  assert.ok(errs.length <= 51, '应封顶：' + errs.length);
  assert.strictEqual(errs[errs.length - 1].keyword, '__truncated__');
});

check('重复核验结果相互独立（校验器复用不串数据）', () => {
  const r1 = verifyInstances(OLD, NEW, [{ id: 1, name: 'b' }]);
  const r2 = verifyInstances(OLD, NEW, [{ id: 100, name: 'b', email: 'e' }]);
  assert.strictEqual(r1.items[0].category, 'oldOnly');
  assert.notStrictEqual(r2.items[0].category, 'oldOnly');
});

check('示例 Schema + 示例实例：分类统计为 1/3/2/4', () => {
  const oldS = require('../samples/verify.old.schema.json');
  const newS = require('../samples/verify.new.schema.json');
  const insts = require('../samples/verify.instances.json');
  const { summary } = verifyInstances(oldS, newS, insts);
  assert.deepStrictEqual(summary, { total: 10, both: 1, oldOnly: 3, newOnly: 2, bothFail: 4 });
});

console.log(`\n${passed} 项通过` + (process.exitCode ? '，存在失败' : ''));
