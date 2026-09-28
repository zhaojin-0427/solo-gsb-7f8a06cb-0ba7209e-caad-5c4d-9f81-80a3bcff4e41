'use strict';

const assert = require('assert');
const Ajv = require('ajv');
const {
  searchCounterexample,
  CounterError,
  MAX_VALID_CANDIDATES,
} = require('../src/counterexample');

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

/** 找到反例：断言旧版通过、新版拒绝（与服务端复验闸同口径的再确认） */
function expectCounter(name, oldSchema, newSchema, predicate) {
  check(name, () => {
    const r = searchCounterexample(oldSchema, newSchema);
    assert.strictEqual(r.found, true, '应找到反例：' + r.summary);
    const oldOk = new Ajv({ allErrors: true, strict: false }).compile(oldSchema);
    const newOk = new Ajv({ allErrors: true, strict: false }).compile(newSchema);
    assert.ok(oldOk(r.instance), '反例必须被旧版接收：' + JSON.stringify(oldOk.errors));
    assert.ok(!newOk(r.instance), '反例必须被新版拒绝');
    assert.ok(Array.isArray(r.newErrors) && r.newErrors.length >= 1, '应给出新版失败路径');
    if (predicate) assert.ok(predicate(r), '反例不满足预期：' + JSON.stringify(r.instance));
  });
}

/** 未找到反例（found=false）；allowTruncated 控制是否允许因上限停止 */
function expectNotFound(name, oldSchema, newSchema, allowTruncated) {
  check(name, () => {
    const r = searchCounterexample(oldSchema, newSchema);
    assert.strictEqual(r.found, false, '不应找到反例，实际：' + JSON.stringify(r.instance));
    assert.strictEqual(r.instance, null);
    if (!allowTruncated) {
      assert.strictEqual(r.exhausted, true, '候选空间应枚举完毕');
      assert.strictEqual(r.truncated, false);
    }
    assert.ok(r.candidatesChecked <= MAX_VALID_CANDIDATES, '合法候选数不得超过上限');
    assert.ok(/不能据此宣称两版 Schema 兼容/.test(r.summary), '未找到结论必须声明不保证兼容');
  });
}

function expectCounterError(name, oldSchema, newSchema, code) {
  check(name, () => {
    let err;
    try {
      searchCounterexample(oldSchema, newSchema);
    } catch (e) {
      err = e;
    }
    assert.ok(err, '应当抛错但未抛');
    assert.ok(err instanceof CounterError, '错误类型应为 CounterError：' + err.constructor.name);
    if (code) assert.strictEqual(err.code, code, `错误码期望 ${code}，实际 ${err.code}`);
  });
}

console.log('找到反例：写方破坏的典型场景');

expectCounter(
  '新版新增必填字段（最小实例即反例）',
  { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
  { type: 'object', required: ['id', 'email'],
    properties: { id: { type: 'integer' }, email: { type: 'string' } } },
  (r) => r.instance.email === undefined &&
    r.newErrors.some((e) => e.keyword === 'required' && e.instancePath === '/email')
);

expectCounter(
  'enum 删除首个之后的取值（必须遍历后续取值，不能只试默认样本）',
  { type: 'string', enum: ['pending', 'paid', 'shipped'] },
  { type: 'string', enum: ['pending', 'paid'] },
  (r) => r.instance === 'paid' || r.instance === 'shipped'
);

expectCounter(
  '整数下界收紧（枚举边界值，最接近零的 0 先失败）',
  { type: 'integer', minimum: 1, maximum: 10 },
  { type: 'integer', minimum: 5, maximum: 10 },
  (r) => r.instance < 5
);

expectCounter(
  '整数上界收紧',
  { type: 'integer', minimum: 0, maximum: 10 },
  { type: 'integer', minimum: 0, maximum: 3 },
  (r) => r.instance > 3
);

expectCounter(
  '新版加 minLength（枚举空串 / 长度边界）',
  { type: 'string' },
  { type: 'string', minLength: 3 },
  (r) => r.instance.length < 3
);

expectCounter(
  'minLength 从 2 提高到 4（边界长度 2 的候选是反例）',
  { type: 'string', minLength: 2 },
  { type: 'string', minLength: 4 },
  (r) => r.instance.length >= 2 && r.instance.length < 4
);

expectCounter(
  '新版加 minItems（空数组是反例）',
  { type: 'array', items: { type: 'integer' } },
  { type: 'array', items: { type: 'integer' }, minItems: 1 },
  (r) => Array.isArray(r.instance) && r.instance.length === 0
);

expectCounter(
  'minItems 从 1 提高到 2（长度 1 是反例）',
  { type: 'array', items: { type: 'integer' }, minItems: 1 },
  { type: 'array', items: { type: 'integer' }, minItems: 2 },
  (r) => r.instance.length === 1
);

expectCounter(
  '必填字段 type 由 string 改 integer',
  { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
  (r) => r.newErrors.some((e) => e.keyword === 'type')
);

expectCounter(
  'number 收紧为 integer（枚举 0.5）',
  { type: 'number' },
  { type: 'integer' },
  (r) => r.instance === 0.5
);

expectCounter(
  '可选字段类型收紧（必须遍历选填字段，不能只验最小实例）',
  { type: 'object', properties: { a: { type: 'string' } } },
  { type: 'object', properties: { a: { type: 'integer' } } },
  (r) => Object.prototype.hasOwnProperty.call(r.instance, 'a')
);

expectCounter(
  '新版 const 固定值',
  { type: 'string' },
  { const: 'x' },
  (r) => r.instance !== 'x'
);

expectCounter(
  '新版 additionalProperties:false（多一个附加字段即反例）',
  { type: 'object', properties: { a: { type: 'string' } } },
  { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } },
  (r) => Object.keys(r.instance).length === 1 &&
    r.newErrors.some((e) => e.keyword === 'additionalProperties')
);

expectCounter(
  '新版移除某个可选属性并禁止附加属性',
  { type: 'object', properties: { keep: { type: 'string' }, gone: { type: 'integer' } } },
  { type: 'object', additionalProperties: false, properties: { keep: { type: 'string' } } },
  (r) => r.newErrors.some((e) => e.keyword === 'additionalProperties')
);

console.log('文档内本地 $ref');

expectCounter(
  '经 $ref 的属性整数下界收紧',
  { definitions: { S: { type: 'integer' } }, type: 'object', required: ['x'],
    properties: { x: { $ref: '#/definitions/S' } } },
  { definitions: { S: { type: 'integer', minimum: 3 } }, type: 'object', required: ['x'],
    properties: { x: { $ref: '#/definitions/S' } } }
);

expectCounter(
  '$ref 引用链（A -> B）上新必填字段',
  {
    definitions: {
      A: { $ref: '#/definitions/B' },
      B: { type: 'object', required: ['v'], properties: { v: { type: 'integer' } } },
    },
    $ref: '#/definitions/A',
  },
  {
    definitions: {
      A: { $ref: '#/definitions/B' },
      B: { type: 'object', required: ['v', 'w'],
        properties: { v: { type: 'integer' }, w: { type: 'integer' } } },
    },
    $ref: '#/definitions/A',
  }
);

expectCounter(
  '可选枚举字段经 $ref 缩值（遍历选填 + enum 后续取值）',
  {
    definitions: { Mode: { type: 'string', enum: ['a', 'b', 'c'] } },
    type: 'object',
    properties: { mode: { $ref: '#/definitions/Mode' } },
  },
  {
    definitions: { Mode: { type: 'string', enum: ['a'] } },
    type: 'object',
    properties: { mode: { $ref: '#/definitions/Mode' } },
  }
);

console.log('布尔 Schema');

expectCounter('旧 true / 新 必填对象（任意值 null 即反例）', true,
  { type: 'object', required: ['x'] });

expectCounter('旧 true / 新 false', true, false, (r) => r.instance === null);

expectNotFound('旧 false：旧版无合法实例，无候选可枚举', false, true);

console.log('未找到反例：支持范围内确实等价');

expectNotFound('相同 integer schema', { type: 'integer' }, { type: 'integer' });
expectNotFound('相同 object schema',
  { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
  { type: 'object', required: ['a'], properties: { a: { type: 'string' } } });
expectNotFound('新版放宽（minimum 降低，旧实例必为新实例）',
  { type: 'integer', minimum: 5 }, { type: 'integer', minimum: 1 });
expectNotFound('新版放宽 enum（加值）',
  { type: 'string', enum: ['a'] }, { type: 'string', enum: ['a', 'b'] });
expectNotFound('旧 true / 新 true（布尔 true 等价）', true, true);

console.log('搜索限制：范围外断言按侧给出 Schema 路径');

check('旧、新都带 multipleOf 且等价：找不到，notes 分侧记录关键字与路径', () => {
  const r = searchCounterexample(
    { type: 'integer', multipleOf: 2 },
    { type: 'integer', multipleOf: 2 }
  );
  assert.strictEqual(r.found, false);
  const sides = r.notes.map((n) => n.side).sort();
  assert.deepStrictEqual(sides, ['new', 'old']);
  assert.ok(r.notes.every((n) => n.keyword === 'multipleOf'));
  assert.ok(r.notes.every((n) => n.schemaPath === '/multipleOf'), JSON.stringify(r.notes));
});

check('新版加 multipleOf：候选 1 被新版拒绝，note 只出现在新版侧', () => {
  const r = searchCounterexample({ type: 'integer' }, { type: 'integer', multipleOf: 2 });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.instance, 1);
  assert.strictEqual(r.newErrors[0].keyword, 'multipleOf');
  assert.ok(r.notes.every((n) => n.side === 'new'));
});

check('旧版带可满足的 pattern 仍可搜索；找到反例且限制里指出旧版 pattern 路径', () => {
  const r = searchCounterexample(
    { type: 'string', pattern: '.*' },
    { type: 'string', const: 'zzz' }
  );
  assert.strictEqual(r.found, true);
  assert.ok(r.notes.some((n) => n.side === 'old' && n.keyword === 'pattern' && n.schemaPath === '/pattern'));
});

check('type 类型数组被列为限制，不影响其余候选的搜索', () => {
  const r = searchCounterexample(
    { type: 'object', properties: { a: { type: ['string', 'null'] } } },
    { type: 'object', required: ['x'] }
  );
  // 最小实例 {} 旧版通过、新版缺 x -> 反例
  assert.strictEqual(r.found, true);
  assert.ok(r.notes.some((n) => n.keyword === 'type' && n.schemaPath === '/properties/a/type'));
});

check('items 元组数组被列为限制', () => {
  const r = searchCounterexample(
    { type: 'array', items: [{ type: 'string' }] },
    { type: 'object' }
  );
  assert.ok(r.notes.some((n) => n.keyword === 'items'));
});

check('enum 超过 50 个取值：记录截断限制，且首个反例仍可找到', () => {
  const values = Array.from({ length: 60 }, (_, i) => i);
  const r = searchCounterexample({ type: 'integer', enum: values }, { type: 'integer', enum: [0] });
  assert.strictEqual(r.found, true);
  assert.ok(r.notes.some((n) => n.keyword === 'enum' && /enum/.test(n.schemaPath)));
});

check('必填路径 $ref 引用环：记录限制而非崩溃，未找到时不宣称兼容', () => {
  const cyc = {
    definitions: {
      L: { type: 'object', required: ['back'], properties: { back: { $ref: '#/definitions/L' } } },
    },
    $ref: '#/definitions/L',
  };
  const r = searchCounterexample(cyc, { type: 'object' });
  assert.strictEqual(r.found, false);
  assert.ok(r.notes.some((n) => n.keyword === '$ref'));
  assert.ok(/不能据此宣称两版 Schema 兼容/.test(r.summary));
});

console.log('上限与复验');

check('最多检查 500 个旧版合法候选（大组合空间 + 新旧相同）', () => {
  const fields = {};
  for (let i = 0; i < 8; i++) fields['f' + i] = { type: 'string', enum: ['a', 'b', 'c'] };
  const S = { type: 'object', properties: fields, additionalProperties: false };
  const r = searchCounterexample(S, S);
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.candidatesChecked, MAX_VALID_CANDIDATES);
  assert.ok(r.summary.includes(String(MAX_VALID_CANDIDATES)));
});

check('旧版不合法的枚举尝试不占用 500 预算（旧版 additionalProperties:false 过滤）', () => {
  // 附加属性候选会被旧版拒绝；正常搜索不应因此异常
  const oldSchema = {
    type: 'object',
    additionalProperties: false,
    properties: { a: { type: 'string' } },
  };
  const newSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['a'],
    properties: { a: { type: 'string' } },
  };
  const r = searchCounterexample(oldSchema, newSchema);
  assert.strictEqual(r.found, true); // {} 旧版通过、新版缺 a
  assert.ok(r.candidatesAttempted >= r.candidatesChecked);
});

check('每个候选都经两版完整复验：结果与独立 Ajv 判定一致（批量抽样）', () => {
  const cases = [
    [{ type: 'integer', minimum: 0 }, { type: 'integer', minimum: 10 }],
    [{ type: 'string' }, { type: 'string', minLength: 2 }],
    [{ type: 'array', items: { type: 'boolean' } },
      { type: 'array', items: { type: 'boolean' }, minItems: 2 }],
  ];
  for (const [o, n] of cases) {
    const r = searchCounterexample(o, n);
    assert.strictEqual(r.found, true);
    const ov = new Ajv({ allErrors: true, strict: false }).compile(o);
    const nv = new Ajv({ allErrors: true, strict: false }).compile(n);
    assert.ok(ov(r.instance));
    assert.ok(!nv(r.instance));
  }
});

console.log('Schema 编译与引用预检');

expectCounterError('旧 Schema 非法 → invalid_schema', { type: 'bogus' }, {}, 'invalid_schema');
expectCounterError('新 Schema 非法 → invalid_schema', {}, { type: 'bogus' }, 'invalid_schema');

check('旧版外部引用直接报错（RefError，编译前拦截）', () => {
  assert.throws(
    () => searchCounterexample({ $ref: 'https://example.com/s.json' }, {}),
    /外部引用/
  );
});
check('新版外部引用同样报错', () => {
  assert.throws(
    () => searchCounterexample({}, { $ref: './other.json' }),
    /外部引用/
  );
});
check('独立 Ajv 实例编译两份带相同 $id 的 Schema 不冲突', () => {
  const o = { $id: 'https://x.test/s.json', type: 'integer' };
  const n = { $id: 'https://x.test/s.json', type: 'string' };
  const r = searchCounterexample(o, n);
  assert.strictEqual(r.found, true);
});

console.log('示例 Schema');

check('samples/old + samples/new：找到旧收新拒反例且示例限制被列出', () => {
  const oldS = require('../samples/old.schema.json');
  const newS = require('../samples/new.schema.json');
  const r = searchCounterexample(oldS, newS);
  assert.strictEqual(r.found, true);
  const oldOk = new Ajv({ allErrors: true, strict: false }).compile(oldS);
  const newOk = new Ajv({ allErrors: true, strict: false }).compile(newS);
  assert.ok(oldOk(r.instance), JSON.stringify(oldOk.errors));
  assert.ok(!newOk(r.instance));
  // 示例里含 format / maxItems / uniqueItems / 元组等范围外断言，必须如实列出
  assert.ok(r.notes.length > 0);
});

console.log(`\n${passed} 项通过` + (process.exitCode ? '，存在失败' : ''));
