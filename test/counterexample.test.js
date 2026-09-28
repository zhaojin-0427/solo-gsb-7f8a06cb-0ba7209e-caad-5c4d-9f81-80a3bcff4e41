'use strict';

const assert = require('assert');
const Ajv = require('ajv');
const { findCounterexample, CounterexampleError, MAX_OLD_VALID } = require('../src/counterexample');

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  logger: { log() {}, warn() {}, error() {}, debug() {} },
});

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

/** 音：找到反例时，实例必须真的旧版通过 / 新版拒绝（用独立 Ajv 再次复验） */
function expectCounterexample(name, oldSchema, newSchema, predicate) {
  check(name, () => {
    const r = findCounterexample(oldSchema, newSchema);
    assert.strictEqual(r.found, true, '应当找到反例，但 found=false；限制：' +
      JSON.stringify(r.limitations.old.concat(r.limitations.new)));
    const oldValid = ajv.compile(oldSchema);
    const newValid = ajv.compile(newSchema);
    assert.ok(oldValid(r.instance), '反例竟然未通过旧版校验：' + JSON.stringify(oldValid.errors));
    assert.ok(!newValid(r.instance), '反例竟然通过了新版校验：' + JSON.stringify(r.instance));
    assert.ok(r.newErrors.length > 0, '应返回新版失败原因');
    if (predicate) predicate(r);
  });
}

function expectNotFound(name, oldSchema, newSchema) {
  check(name, () => {
    const r = findCounterexample(oldSchema, newSchema);
    assert.strictEqual(r.found, false, '不应找到反例，却找到：' + JSON.stringify(r.instance));
  });
}

function expectThrow(name, oldSchema, newSchema, code) {
  check(name, () => {
    let err;
    try {
      findCounterexample(oldSchema, newSchema);
    } catch (e) {
      err = e;
    }
    assert.ok(err, '应当抛错但未抛');
    assert.ok(err instanceof CounterexampleError || err.name === 'RefError', '错误类型不符：' + err.name);
    if (code) assert.strictEqual(err.code, code, `错误码期望 ${code}，实际 ${err.code}`);
  });
}

console.log('核心破坏场景（自动复现，无需存量数据）');

expectCounterexample(
  '新增必填：基线实例缺该字段即被新版拒绝',
  { type: 'object', required: ['id'], properties: { id: { type: 'integer' }, email: { type: 'string' } } },
  { type: 'object', required: ['id', 'email'], properties: { id: { type: 'integer' }, email: { type: 'string' } } },
  (r) => {
    assert.ok(!('email' in r.instance), '基线不应含可选 email');
    assert.strictEqual(r.newErrors[0].keyword, 'required');
    assert.strictEqual(r.newErrors[0].instancePath, '/email');
  }
);

expectCounterexample(
  '枚举首个取值被删：基线（第一个取值）即为反例',
  { enum: ['pending', 'paid', 'shipped'] },
  { enum: ['paid', 'shipped', 'refunded'] },
  (r) => assert.strictEqual(r.instance, 'pending')
);

expectCounterexample(
  '枚举仅删后续取值：遍历到第 4 个值才找到（不能只检验默认样本）',
  { enum: ['a', 'b', 'c', 'd'] },
  { enum: ['a', 'b', 'c'] },
  (r) => {
    assert.strictEqual(r.instance, 'd');
    assert.ok(r.checked >= 4, '应至少复验 4 个候选，实际 ' + r.checked);
  }
);

expectCounterexample(
  '整数上界 99 收紧到 9：边界值 99 被拒',
  { type: 'integer', minimum: 1, maximum: 99 },
  { type: 'integer', minimum: 1, maximum: 9 },
  (r) => assert.ok(r.instance > 9, '期望 >9 的边界值，实际 ' + r.instance)
);

expectCounterexample(
  '新增整数下限 0：邻接边界 -1 被拒',
  { type: 'integer' },
  { type: 'integer', minimum: 0 },
  (r) => assert.strictEqual(r.instance, -1)
);

expectCounterexample(
  '整数下界抬高：旧下界边界值被拒',
  { type: 'integer', minimum: 0, maximum: 100 },
  { type: 'integer', minimum: 10, maximum: 100 },
  (r) => assert.strictEqual(r.instance, 0)
);

expectCounterexample(
  '字符串新增 minLength=1：空串（边界）被拒',
  { type: 'string' },
  { type: 'string', minLength: 1 },
  (r) => assert.strictEqual(r.instance, '')
);

expectCounterexample(
  '数组新增 minItems=1：空数组（边界）被拒',
  { type: 'array', items: { type: 'integer' } },
  { type: 'array', items: { type: 'integer' }, minItems: 1 },
  (r) => assert.deepStrictEqual(r.instance, [])
);

expectCounterexample(
  'const 固定值改变',
  { const: 'x' },
  { const: 'y' }
);

expectCounterexample(
  'type 由 string 改为 integer',
  { type: 'string' },
  { type: 'integer' }
);

expectCounterexample(
  '可选嵌套属性类型变更：遍历可选字段时命中',
  { type: 'object', properties: { m: { type: 'object', properties: { x: { type: 'integer' } } } } },
  { type: 'object', properties: { m: { type: 'object', properties: { x: { type: 'string' } } } } },
  (r) => assert.strictEqual(r.newErrors[0].instancePath, '/m/x')
);

expectCounterexample(
  '新版 additionalProperties 改为 false：枚举额外属性槽命中',
  { type: 'object', properties: { a: { type: 'integer' } } },
  { type: 'object', properties: { a: { type: 'integer' } }, additionalProperties: false },
  (r) => {
    assert.strictEqual(r.newErrors[0].keyword, 'additionalProperties');
    const keys = Object.keys(r.instance);
    assert.ok(keys.some((k) => k !== 'a'), '实例应含一个额外属性：' + JSON.stringify(r.instance));
  }
);

expectCounterexample(
  '根布尔 true → false：null 被新版恒假拒绝',
  true,
  false,
  (r) => assert.strictEqual(r.instance, null)
);

console.log('本地 $ref / 递归');

expectCounterexample(
  '经 $ref 的可选枚举字段：基线（不带可选字段）触发新版 required',
  {
    definitions: { M: { type: 'object', properties: { tier: { enum: ['free', 'pro'] } } } },
    type: 'object', required: ['m'],
    properties: { m: { $ref: '#/definitions/M' } },
  },
  {
    definitions: { M: { type: 'object', required: ['tier'], properties: { tier: { enum: ['pro'] } } } },
    type: 'object', required: ['m'],
    properties: { m: { $ref: '#/definitions/M' } },
  }
);

expectCounterexample(
  '递归自引用：必填路径新增 next，无环实例 {v} 即反例',
  {
    definitions: { Node: { type: 'object', required: ['v'],
      properties: { v: { type: 'integer' }, next: { $ref: '#/definitions/Node' } } } },
    $ref: '#/definitions/Node',
  },
  {
    definitions: { Node: { type: 'object', required: ['v', 'next'],
      properties: { v: { type: 'integer' }, next: { $ref: '#/definitions/Node' } } } },
    $ref: '#/definitions/Node',
  },
  (r) => assert.deepStrictEqual(r.instance, { v: 0 })
);

console.log('未找到（不得宣称兼容）与上限');

expectNotFound(
  '两版相同的对象 Schema',
  { type: 'object', required: ['a'], properties: { a: { type: 'integer' } } },
  { type: 'object', required: ['a'], properties: { a: { type: 'integer' } } }
);

expectNotFound(
  '新版放宽（integer 上界变大）',
  { type: 'integer', maximum: 9 },
  { type: 'integer', maximum: 99 }
);

expectNotFound('根布尔 true 两版一致', true, true);
expectNotFound('无约束 {} 两版一致', {}, {});

check('候选空间爆炸时最多检查 500 个旧版合法候选并标记 truncated', () => {
  const props = {};
  for (let i = 0; i < 10; i++) props['p' + i] = { type: 'integer' };
  const schema = { type: 'object', properties: props };
  const r = findCounterexample(schema, schema);
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.checked, MAX_OLD_VALID);
  assert.strictEqual(r.truncated, true);
  assert.ok(r.notes.old.some((n) => n.message.includes(String(MAX_OLD_VALID))), '应说明达到上限');
});

check('旧根恒 false：checked=0 并给出根级说明，不抛错', () => {
  const r = findCounterexample(false, { type: 'integer' });
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.checked, 0);
  assert.ok(r.notes.old.some((n) => n.schemaPath === '' && n.message.includes('恒为 false')));
});

console.log('范围外断言：继续搜索并报告 Schema 路径');

check('旧版含 pattern（未找到反例）：old 侧限制指向 /pattern，且不宣称兼容', () => {
  const r = findCounterexample({ type: 'string', pattern: '^z+' }, { type: 'string' });
  assert.strictEqual(r.found, false);
  assert.ok(r.limitations.old.some((p) => p.schemaPath === '' && p.keyword === 'pattern'),
    JSON.stringify(r.limitations.old));
});

check('新版含 pattern 仍可找到反例（候选经完整 Schema 复验），new 侧记录 /pattern', () => {
  const r = findCounterexample({ type: 'string' }, { type: 'string', pattern: '^z' });
  assert.strictEqual(r.found, true);
  assert.ok(r.limitations.new.some((p) => p.keyword === 'pattern'));
  // 反例可靠性再次复验
  assert.ok(ajv.compile({ type: 'string' })(r.instance));
  assert.ok(!ajv.compile({ type: 'string', pattern: '^z' })(r.instance));
});

check('number 上的 minimum 记为范围外（边界只支持 integer）', () => {
  const r = findCounterexample({ type: 'number', minimum: 0 }, { type: 'number', minimum: 1 });
  assert.ok(r.found); // 基线 0 恰好也是反例
  assert.ok(r.limitations.old.some((p) => p.keyword === 'minimum'));
});

check('元组 items / 类型数组 / oneOf 均记录限制路径', () => {
  const oldS = {
    type: 'object',
    properties: {
      a: { items: [{ type: 'string' }, { type: 'integer' }] },
      b: { type: ['string', 'null'] },
      c: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
    },
  };
  const r = findCounterexample(oldS, oldS);
  const paths = r.limitations.old.map((p) => p.schemaPath + '/' + p.keyword);
  assert.ok(paths.includes('/properties/a/items'), JSON.stringify(paths));
  assert.ok(paths.includes('/properties/b/type'), JSON.stringify(paths));
  assert.ok(paths.includes('/properties/c/oneOf'), JSON.stringify(paths));
});

check('enum 超过 100 个取值：记录 /enum 限制', () => {
  const vals = Array.from({ length: 150 }, (_, i) => i);
  const r = findCounterexample({ enum: vals }, { enum: vals.slice(0, 149) });
  // 反例 149 在封顶之外，找不到，但必须说明限制
  assert.strictEqual(r.found, false);
  assert.ok(r.limitations.old.some((p) => p.keyword === 'enum' && p.schemaPath === '/enum'));
});

console.log('独立编译 / 输入错误');

expectThrow('外部 $ref 直接拒绝（不配置远程加载）', { $ref: 'https://example.com/s.json' }, {}, null);
expectThrow('旧 Schema 非法 type：invalid_schema', { type: '不存在的类型' }, {}, 'invalid_schema');
expectThrow('新 Schema 编译失败：invalid_schema', {}, { type: 123 }, 'invalid_schema');

check('每个候选都由旧、新独立校验器完整复验：返回的失败路径来自新版', () => {
  const r = findCounterexample(
    { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
    { type: 'object', required: ['id', 'name'], properties: { id: { type: 'integer' }, name: { type: 'string' } } }
  );
  assert.strictEqual(r.found, true);
  const er = r.newErrors[0];
  assert.strictEqual(er.instancePath, '/name');
  assert.ok(er.schemaPath.includes('/required'), 'schemaPath 应指向新版 required：' + er.schemaPath);
  assert.ok(er.message.includes('name'), '中文原因应含字段名：' + er.message);
});

check('示例 Schema（samples/old ↔ samples/new）可找到真实反例且复验可靠', () => {
  const oldS = require('../samples/old.schema.json');
  const newS = require('../samples/new.schema.json');
  const r = findCounterexample(oldS, newS);
  assert.strictEqual(r.found, true);
  assert.ok(ajv.compile(oldS)(r.instance), '旧版应通过');
  assert.ok(!ajv.compile(newS)(r.instance), '新版应拒绝');
  // 示例含 format / maxLength / number 边界等范围外断言，两侧限制均如实上报
  assert.ok(r.limitations.old.length > 0);
  assert.ok(r.limitations.new.length > 0);
});

console.log(`\n${passed} 项通过` + (process.exitCode ? '，存在失败' : ''));
