'use strict';

/**
 * refs.js —— 本地 $ref 引用解析
 *
 * 支持：
 *   "#/definitions/Foo"、"#/$defs/Foo"、"#" 等 JSON Pointer 形式的本地引用
 *   引用链解析（$ref 指向的节点自身也可能带 $ref）
 *   循环引用保护（以"展开深度上限 + 引用集合"兜底，比对时另有循环检测）
 *
 * 不支持：外部 URI 引用（http://、相对文件等），遇到即抛错提示。
 */

class RefError extends Error {
  constructor(message, pointer) {
    super(message);
    this.name = 'RefError';
    this.pointer = pointer || null;
  }
}

/** 按 RFC 6901 解码 JSON Pointer 片段（先还原 ~1 再还原 ~0，顺序不可颠倒） */
function decodeToken(token) {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** 按 RFC 6901 编码 JSON Pointer 片段（先转义 ~ 再转义 /，顺序不可颠倒） */
function encodeToken(token) {
  return String(token).replace(/~/g, '~0').replace(/\//g, '~1');
}

/** 判断是否为本地引用（# 或 #/...） */
function isLocalRef(ref) {
  return typeof ref === 'string' && (ref === '#' || ref.startsWith('#/'));
}

/**
 * 把规范 JSON Pointer 转成人类可读定位（显示真实字段名）：
 *   /properties/a~1b/properties/child  →  "a/b" › "child"
 * 只在展示层使用；差异路径 / 树节点 / 清单内部仍统一保存编码后的规范 Pointer。
 */
function humanPath(pointer) {
  if (!pointer) return '根节点';
  const tokens = pointer.split('/').slice(1);
  const parts = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'properties' && i + 1 < tokens.length) {
      parts.push('"' + decodeToken(tokens[i + 1]) + '"');
      i++;
    } else if (/^\d+$/.test(tokens[i])) {
      parts.push('[' + tokens[i] + ']');
    } else {
      parts.push(decodeToken(tokens[i]));
    }
  }
  return parts.join(' › ') || '根节点';
}

/**
 * 沿 JSON Pointer 在根文档上取节点。
 * 找不到时抛 RefError。
 */
function resolvePointer(root, pointer) {
  if (pointer === '#' || pointer === '#/') return root;

  const rawTokens = pointer.slice(2).split('/');
  let cur = root;

  for (const raw of rawTokens) {
    const token = decodeToken(raw);
    if (cur === null || typeof cur !== 'object' || !(token in cur)) {
      throw new RefError(`无法解析引用 "${pointer}"：路径片段 "${token}" 不存在`, pointer);
    }
    cur = cur[token];
  }
  return cur;
}

/**
 * 把一个（可能带 $ref 的）节点解析到它最终指向的 schema 节点。
 *
 * @param {object} root  整份 Schema 根对象（用于寻址）
 * @param {object} node  当前节点
 * @returns {{ node: object, chain: string[] }} 最终节点与经过的引用链
 */
function followRefs(root, node) {
  const chain = [];
  const seen = new Set();
  const MAX_HOPS = 100;

  let cur = node;
  for (let hops = 0; hops < MAX_HOPS; hops++) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) break;
    const ref = cur.$ref;
    if (typeof ref !== 'string') break;

    if (!isLocalRef(ref)) {
      throw new RefError(
        `仅支持本地引用（以 "#" 开头），检测到外部引用："${ref}"。请先内联外部定义后重试。`,
        ref
      );
    }
    if (seen.has(ref)) {
      // 引用链成环：停在环上的这个节点，交由比对阶段的循环检测处理
      chain.push(ref);
      return { node: cur, chain, cyclic: true };
    }
    seen.add(ref);
    chain.push(ref);
    cur = resolvePointer(root, ref);
  }

  return { node: cur, chain, cyclic: false };
}

module.exports = {
  RefError,
  isLocalRef,
  resolvePointer,
  followRefs,
  decodeToken,
  encodeToken,
  humanPath,
};
