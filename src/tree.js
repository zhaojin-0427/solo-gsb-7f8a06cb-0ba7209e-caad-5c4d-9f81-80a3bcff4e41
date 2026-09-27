'use strict';

/**
 * tree.js —— 把扁平 findings 按 JSON Pointer 组织成路径树
 *
 * 路径一律采用 RFC 6901 规范 JSON Pointer：
 *   属性名中的 ~ 编为 ~0、/ 编为 ~1（由 compare.js 在生成路径时完成）。
 * 因此建树时：
 *   - 只能按 "/" 切分原始 token，禁止先解码再切分（否则 a~1b 会被误拆成 a/b）；
 *   - 节点唯一键必须用 (kind, 原始 token)，显示名才是解码后的真实字段名，
 *     这样 "a/b" 属性与 a 下的 b 属性即使显示路径相似也不会串节点；
 *   - 节点 path 始终保留规范编码形式，与 finding.path / 迁移清单完全一致。
 *
 * 节点结构：
 * {
 *   name: 'city', path: '/properties/address/properties/city',
 *   reader: 'breaking'|null, writer: ...（该节点自身 finding 的级别）,
 *   worst: { reader, writer }（含后代的最差级别）,
 *   findings: [...], children: Map
 * }
 */

const { RANK } = require('./compare');
const { decodeToken } = require('./refs');

/**
 * 把 JSON Pointer 拆成显示段。
 * /properties/a/properties/b => [{ name:'a', kind:'prop', raw:'a' }, ...]
 * 切分基于未解码的原始 token；name 解码为真实字段名，raw 保留编码形式。
 */
function splitPath(pointer) {
  if (!pointer) return [];
  const tokens = pointer.split('/').slice(1);
  const segs = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'properties' && i + 1 < tokens.length) {
      // raw 保留编码，name 还原为真实字段名
      segs.push({ name: decodeToken(tokens[i + 1]), kind: 'prop', raw: tokens[i + 1] });
      i++;
    } else if (/^\d+$/.test(tokens[i])) {
      segs.push({ name: '[' + tokens[i] + ']', kind: 'index', raw: tokens[i] });
    } else {
      // 关键字（type、required、enum、items…）；解码以兼容罕见的转义写法
      segs.push({ name: decodeToken(tokens[i]), kind: 'keyword', raw: tokens[i] });
    }
  }
  return segs;
}

/**
 * 子节点唯一键：同一段位置上，属性 / 数组下标 / 关键字属于不同命名空间，
 * 且属性命名空间按编码后的原始 token 区分（a~1b 与 a/b 不会撞键）。
 */
function segKey(seg) {
  return seg.kind + ' ' + seg.raw;
}

function worstOf(levels) {
  let w = null;
  for (const l of levels) {
    if (l && (w === null || RANK[l] < RANK[w])) w = l;
  }
  return w;
}

function buildTree(findings) {
  const root = {
    name: '(root)',
    path: '',
    own: { reader: null, writer: null },
    worst: { reader: null, writer: null },
    findings: [],
    children: new Map(),
    childOrder: [],
  };

  for (const f of findings) {
    const segs = splitPath(f.path);
    let node = root;
    let accPath = '';

    for (const seg of segs) {
      // 重建该段的规范 pointer（属性段补 /properties/，一律使用原始 token）
      if (seg.kind === 'prop') accPath += '/properties/' + seg.raw;
      else accPath += '/' + seg.raw;

      const key = segKey(seg);
      if (!node.children.has(key)) {
        const child = {
          name: seg.name,
          path: accPath,
          kind: seg.kind,
          own: { reader: null, writer: null },
          worst: { reader: null, writer: null },
          findings: [],
          children: new Map(),
          childOrder: [],
        };
        node.children.set(key, child);
        node.childOrder.push(key);
      }
      node = node.children.get(key);
    }

    node.findings.push(f);
    node.own.reader = worstOf([node.own.reader, f.reader]);
    node.own.writer = worstOf([node.own.writer, f.writer]);
  }

  // 自底向上汇总最差级别（含后代）
  const summarize = (node) => {
    let levelsR = [node.own.reader];
    let levelsW = [node.own.writer];
    for (const key of node.childOrder) {
      const c = summarize(node.children.get(key));
      levelsR.push(c.worst.reader);
      levelsW.push(c.worst.writer);
    }
    node.worst.reader = worstOf(levelsR);
    node.worst.writer = worstOf(levelsW);
    return node;
  };
  summarize(root);

  return root;
}

module.exports = { buildTree, splitPath, segKey };
