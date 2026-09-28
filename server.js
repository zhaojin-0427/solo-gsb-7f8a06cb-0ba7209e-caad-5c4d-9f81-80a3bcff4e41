'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const { compareSchemas, CompareError, KIND_META } = require('./src/compare');
const { buildPlan } = require('./src/migrate');
const { buildTree } = require('./src/tree');
const { RefError } = require('./src/refs');
const { generateInstance, GenerateError } = require('./src/generate');
const { findCounterexample, CounterexampleError } = require('./src/counterexample');
const {
  VerifyError,
  parseInstances,
  verifyInstances,
  precheckLocalRefs,
} = require('./src/verify');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function parseSchema(text, label) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new CompareError(`请提供${label} Schema 内容（JSON 文本）。`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CompareError(`${label} Schema 不是合法 JSON：${e.message}`);
  }
}

app.post('/api/compare', (req, res) => {
  try {
    const { oldSchema, newSchema, strategy } = req.body || {};
    const oldRoot = parseSchema(oldSchema, '旧');
    const newRoot = parseSchema(newSchema, '新');

    const { findings, summary } = compareSchemas(oldRoot, newRoot);
    // 两种策略的计划一次算好，前端切换时纯本地重渲染，结果稳定
    const readerPlan = buildPlan(findings, 'reader');
    const writerPlan = buildPlan(findings, 'writer');
    const tree = buildTree(findings);

    res.json({
      ok: true,
      findings,
      kindMeta: KIND_META,
      summary,
      plans: { reader: readerPlan, writer: writerPlan },
      activeStrategy: strategy === 'writer' ? 'writer' : 'reader',
      tree: serializeTree(tree),
    });
  } catch (e) {
    if (e instanceof CompareError || e instanceof RefError) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    console.error(e);
    res.status(500).json({ ok: false, error: '服务器内部错误：' + e.message });
  }
});

/** Map -> 可序列化数组 */
function serializeTree(node) {
  return {
    name: node.name,
    path: node.path,
    kind: node.kind || 'root',
    own: node.own,
    worst: node.worst,
    findings: node.findings,
    children: node.childOrder.map((k) => serializeTree(node.children.get(k))),
  };
}

// 有效样本生成：从旧 / 新 Schema 中选一份，构造可复制的最小合法实例（Ajv 复验通过才返回）
app.post('/api/generate', (req, res) => {
  try {
    const { oldSchema, newSchema, side } = req.body || {};
    const useOld = side !== 'new';
    const root = parseSchema(useOld ? oldSchema : newSchema, useOld ? '旧' : '新');
    const instance = generateInstance(root);
    res.json({
      ok: true,
      side: useOld ? 'old' : 'new',
      instance,
      instanceText: JSON.stringify(instance, null, 2),
    });
  } catch (e) {
    if (e instanceof GenerateError) {
      return res.status(400).json({
        ok: false,
        error: e.message,
        code: e.code,
        schemaPath: e.schemaPath || '',
        instancePath: e.instancePath || '',
        problems: e.problems || null,
      });
    }
    if (e instanceof CompareError || e instanceof RefError) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    console.error(e);
    res.status(500).json({ ok: false, error: '服务器内部错误：' + e.message });
  }
});

// 兼容性反例搜索：依据旧、新 Schema 自动找一条「旧版接收、新版拒绝」的实例
app.post('/api/counterexample', (req, res) => {
  try {
    const { oldSchema, newSchema } = req.body || {};
    const oldRoot = parseSchema(oldSchema, '旧');
    const newRoot = parseSchema(newSchema, '新');
    const result = findCounterexample(oldRoot, newRoot);
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof CounterexampleError) {
      return res.status(400).json({ ok: false, error: e.message, code: e.code });
    }
    if (e instanceof CompareError || e instanceof RefError) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    console.error(e);
    res.status(500).json({ ok: false, error: '服务器内部错误：' + e.message });
  }
});

// 存量实例迁移核验：用 Ajv（draft-07）按旧、新 Schema 分别校验实例数组中的每条数据
app.post('/api/verify', (req, res) => {
  try {
    const { oldSchema, newSchema, instances } = req.body || {};
    const oldRoot = parseSchema(oldSchema, '旧');
    const newRoot = parseSchema(newSchema, '新');
    // 外部引用在编译前拦截（Ajv 不配置任何远程加载器，绝不发起网络请求）
    precheckLocalRefs(oldRoot);
    precheckLocalRefs(newRoot);
    const list = parseInstances(instances);
    const result = verifyInstances(oldRoot, newRoot, list);
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof VerifyError) {
      return res.status(400).json({ ok: false, error: e.message, code: e.code });
    }
    if (e instanceof CompareError || e instanceof RefError) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    console.error(e);
    res.status(500).json({ ok: false, error: '服务器内部错误：' + e.message });
  }
});

// 示例 Schema（页面一键载入）
app.get('/api/sample', (req, res) => {
  const dir = path.join(__dirname, 'samples');
  res.json({
    old: fs.readFileSync(path.join(dir, 'old.schema.json'), 'utf8'),
    new: fs.readFileSync(path.join(dir, 'new.schema.json'), 'utf8'),
    gen: fs.readFileSync(path.join(dir, 'gen.schema.json'), 'utf8'),
    verifyOld: fs.readFileSync(path.join(dir, 'verify.old.schema.json'), 'utf8'),
    verifyNew: fs.readFileSync(path.join(dir, 'verify.new.schema.json'), 'utf8'),
    verifyInstances: fs.readFileSync(path.join(dir, 'verify.instances.json'), 'utf8'),
  });
});

app.listen(PORT, () => {
  console.log(`JSON Schema 兼容性迁移规划器已启动：http://localhost:${PORT}`);
});
