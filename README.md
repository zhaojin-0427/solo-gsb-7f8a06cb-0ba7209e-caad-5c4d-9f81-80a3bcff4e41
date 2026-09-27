# JSON Schema 兼容性迁移规划器

粘贴（或上传）**旧、新两份 JSON Schema**，工具会：

1. **解析本地 `$ref`**（`#/definitions/...`、`#/$defs/...`，支持引用链与递归自引用的循环保护）；
2. **递归比较**对象属性、数组、`type`、`required`、`enum`/`const`、数值/长度边界、`pattern`、`format`、`uniqueItems`、`additionalProperties` 等变化；
3. 对每处变化分别按 **读取方（Backward，旧消费方读新数据）** 与 **写入方（Forward，旧生产方写新校验）** 两种策略判定破坏等级（破坏 / 风险 / 兼容 / 提示），并在**路径树**中逐条解释原因；
4. 生成按阶段排序的**有序迁移清单**（Expand-Contract 双发模式）；
5. **生成有效样本**：任选旧 / 新其中一版 Schema，构造一个可复制的最小合法 JSON 实例（供接口联调），结果经 Ajv（draft-07）复验通过后才显示；
6. **存量实例迁移核验**：粘贴最多 100 条存量 JSON 实例组成的数组，服务端用 Ajv 分别按当前旧、新 Schema 逐条校验，找出**升级后会被新版拒收的存量数据**。

所有解析与比对都在本地服务完成，Schema 内容不会上传到任何外部服务。

---

## 一条命令启动

需要本机装有 Docker（含 Compose 插件）：

```bash
docker compose up --build
```

然后浏览器打开：

```
http://localhost:3000
```

后台运行：`docker compose up --build -d`；停止：`docker compose down`。

> 端口被占用？修改 `docker-compose.yml` 中 `"3000:3000"` 的左侧端口即可。

### 不用 Docker，直接用 Node 运行

需要 Node.js ≥ 18：

```bash
npm install
npm start
# 访问 http://localhost:3000
```

---

## 使用方法

1. 左右两个文本框分别粘贴 **旧 Schema（当前版本）** 和 **新 Schema（目标版本）**，也可以点「上传文件」选择本地 `.json`；
2. 点「**开始比对**」（想快速体验可点「**载入示例**」，示例覆盖 `$ref`、递归定义、枚举增减、类型变更、必填变更、边界收紧/放宽等场景）；
3. 在顶部切换「**读取方兼容 / 写入方兼容**」：
   - 路径树徽章、概览统计与迁移清单**即时稳定切换**，无需重新比对；
   - 「只看当前策略受影响项」可过滤双向兼容的变化；
4. 展开路径树中的任意节点，可看到该路径下每处变化的：
   - **判定结果**：读取方 / 写入方各自的等级；
   - **原因解释**：为什么这样判定；
   - **旧值 → 新值**预览，以及命中的 `$ref` 引用链；
5. 右侧（窄屏为下方）「有序迁移清单」按三个阶段给出可执行步骤，全局连续编号。

---

## 有效样本生成（接口联调）

输入区下方的「有效样本生成」模块独立于比对功能，可直接使用：

1. 选择「基于旧 Schema / 基于新 Schema」，点「**生成有效样本**」；
2. 生成结果以格式化 JSON 展示，点「**复制 JSON**」一键复制；
3. 想快速体验可点「**载入生成示例**」，会把一份覆盖全部支持特性的示例 Schema 写入当前所选输入框。

**生成规则（最小实例）**

- 对象只填 `required` 必填字段，选填字段一律不展开；
- 数组按 `minItems` 生成最少元素（未声明则为空数组）；
- 字符串用 `a` 补足 `minLength`；
- 整数取 `minimum`/`maximum` 范围内**最接近零**的值；
- `enum` 按数组顺序逐个用同节点**全部**约束完整复验（对象的 `properties`/`required`、数组的单一 `items`/`minItems`、文档内本地 `$ref` 都一并核对），返回第一个通过复验的取值；例如 `enum:[{"x":0},{"x":1}]` 且属性 `x` 要求整数且 `minimum:1` 时，会跳过 `{"x":0}` 选中 `{"x":1}`；`const` 直接采用固定值（同样需通过完整复验）；
- 布尔 Schema：`true` 生成 `null`（任意值均可），`false` 视为无解并说明路径；
- 可选路径上的自引用（如 `friends` 未列入 `required`）不会展开。

**支持范围**：draft-07 布尔 Schema、单一 `type`、`const`/`enum`、对象 `properties`/`required`、数组单一 `items`/`minItems`、字符串 `minLength`、整数 `minimum`/`maximum`、`additionalProperties` 布尔形式，以及文档内本地 `$ref`（`#/...`）。

**会拒绝生成并指出 Schema 路径的情况**：

- 其余断言关键字（如 `pattern`、`format`、`maxLength`、`uniqueItems`、`type` 类型数组、`items` 元组数组、`allOf/oneOf/anyOf/not` 等），会一次性列出全部位置；
- 必填路径上的 `$ref` 引用环（给出完整引用链）；
- 矛盾约束（如 `minimum > maximum`、`const` 与 `minLength` 冲突）；
- `enum` 全部候选都过不了同节点完整复验（`const` 固定值同理）时，错误定位到对应 `/enum`、`/const` Schema 路径；
- 无解 Schema（如布尔 `false`、`minItems>0` 但无 `items`）。

生成的实例会用随项目安装的 **Ajv**（draft-07）复验，**通过才显示**；编辑所选 Schema 后旧样本立即清空，避免误用过期实例。

---

## 存量实例迁移核验（找出升级后会被拒收的数据）

输入区下方的「存量实例迁移核验」模块独立于比对功能：

1. 在实例框粘贴一个 **JSON 数组**（`[ {...}, {...} ]`，最多 **100** 条；根节点非数组、空数组、非法 JSON、超量都会明确报错）；
2. 点「**开始核验**」，服务端用随项目安装的 **Ajv（draft-07）** 分别按当前旧、新两份 Schema 校验**每一条**数据——支持文档内本地 `$ref`（`#/definitions/...`、引用链、递归自引用），**不配置任何远程加载器、不获取远程引用**，外部引用在编译前直接报错；
3. 按以下四类汇总，并保留**输入顺序**逐条展示：
   - **新旧均通过**：升级后依然合法；
   - **仅旧版通过**（重点）：这些存量数据升级到新版后会被拒收，需要迁移；
   - **仅新版通过**：旧校验不认可、新校验放行的数据；
   - **两版均失败**：本来就不合规的脏数据；
4. 每条实例给出旧、新两版结论；失败时逐条列出中文原因。

**位置定位**：错误位置一律使用 **JSON Pointer**（RFC 6901）：

- 缺失必填项定位到缺失的具体字段（如 `/email`、嵌套 `/meta/x~0y`）；
- 多余属性定位到多余的具体字段（如 `/extra`）；
- 数组元素按下标定位（如 `/items/2/sku`）；
- 字段名中的 `~` 转义为 `~0`、`/` 转义为 `~1`；根节点错误显示为「（根节点）」；
- 每条错误同时附 Schema 侧指针（关键字所在位置，如 `#/definitions/M/required`）便于排查。

Schema 编译失败（如 `type` 取值非法）、实例输入不合法（非数组 / 空数组 / 非法 JSON / 超过 100 条）都会返回 `400` 与中文错误。**任一输入（旧 / 新 Schema 或实例文本）改变后，之前的核验结论立即清空**，避免误用过期结果。点「**载入核验示例**」可一键填入覆盖四种分类、含 `~` / `/` 字段名的示例 Schema 与 10 条实例。

---

## 两种兼容策略的含义

| 策略 | 提问 | 典型破坏变化 | 迁移顺序 |
|---|---|---|---|
| **读取方兼容**（Backward） | 旧版读取/消费代码，读新版数据会不会坏？ | 新增枚举值、放宽类型/边界、属性被移除、必填改选填 | ① 读取方先学会容忍新结构 → ② 写入方切换 → ③ 清理 |
| **写入方兼容**（Forward） | 旧版写入/生产代码继续写，能不能通过新版校验？ | 新增必填、枚举删值、收窄类型/边界、`uniqueItems` 开启 | ① 写入方先双发/收敛产出 → ② 读取方升级校验 → ③ 停止旧产出 |

判定口径为类型包含关系：某侧等级表示「该侧旧代码在演进后是否安全」。无法从语法上确定语义松紧的变化（如 `pattern` 改写、`format` 变化、`allOf/oneOf/anyOf` 组合）标记为 **风险/提示**，要求人工确认。

## 路径树徽章说明

- 红色「破坏」：该策略下必然不兼容，必须安排迁移；
- 橙色「风险」：大概率有问题或需人工确认（如必填改选填后的空值、边界放宽后的越界假设）；
- 绿色「兼容」：该策略下安全；
- 灰色「提示」：信息性条目（如检测到组合关键字）。
- 节点自身无变化但子树有时，显示灰色「子树:…」聚合徽章。

---

## 项目结构

```
.
├── server.js              # Express 入口：静态页 + POST /api/compare + /api/generate + /api/verify + GET /api/sample
├── src
│   ├── refs.js            # 本地 $ref 解析（JSON Pointer、引用链、循环保护）
│   ├── compare.js         # 递归差异引擎：reader/writer 双向等级判定
│   ├── migrate.js         # 两策略 × 三阶段的有序迁移清单生成
│   ├── tree.js            # findings -> JSON Pointer 路径树（子树最差级别聚合）
│   ├── generate.js        # 有效样本生成：最小实例构造 + Ajv 复验闸
│   └── verify.js          # 存量实例核验：Ajv 双版本逐条校验 + 中文错误 / JSON Pointer 归一化
├── public
│   ├── index.html         # 页面结构
│   ├── styles.css
│   └── app.js             # 原生 JS：输入、策略切换、树/清单渲染、样本生成、存量核验（无框架无构建）
├── samples
│   ├── old.schema.json    # 示例旧版（含 $ref、递归 Customer.friends）
│   ├── new.schema.json
│   ├── gen.schema.json    # 样本生成示例（仅使用生成器支持的关键字）
│   ├── verify.old.schema.json   # 存量核验示例旧版（含 $ref、~ 与 / 字段名）
│   ├── verify.new.schema.json
│   └── verify.instances.json    # 10 条覆盖四类结论的示例实例
├── Dockerfile
└── docker-compose.yml
```

### API

`POST /api/compare`

```json
{
  "oldSchema": "{ ...JSON 字符串... }",
  "newSchema": "{ ...JSON 字符串... }",
  "strategy": "reader"
}
```

返回 `findings`（带稳定 id 的全部变化）、`summary`、`plans.reader` / `plans.writer`（两种策略的迁移步骤，前端切换不重新请求）、`tree`（路径树）。非法 JSON、无法解析的 `$ref`、外部引用返回 `400` 与中文错误信息。

`POST /api/generate`

```json
{
  "oldSchema": "{ ...JSON 字符串... }",
  "newSchema": "{ ...JSON 字符串... }",
  "side": "old"
}
```

`side` 取 `"old"` / `"new"`，从对应输入框的 Schema 生成最小合法实例。成功返回 `instance` 与格式化好的 `instanceText`；失败返回 `400`，`code` 区分原因（`unsupported` 不支持的关键字并附 `problems` 路径明细、`ref_cycle` 必填引用环、`contradiction` 矛盾约束、`unsatisfiable` 无解、`invalid_schema` 非法 Schema、`verify_failed` 复验未过）。

`POST /api/verify`

```json
{
  "oldSchema": "{ ...JSON 字符串... }",
  "newSchema": "{ ...JSON 字符串... }",
  "instances": "[ { ... }, { ... } ]"
}
```

存量实例迁移核验。成功返回 `summary`（`{ total, both, oldOnly, newOnly, bothFail }`）与 `items`（按输入顺序，每项含 `index`、`category`、`old` / `new` 两版的 `valid` 与 `errors`；错误含实例侧 `instancePath`（JSON Pointer，`~0`/`~1` 已转义，required/additionalProperties 定位到具体字段）、Schema 侧 `schemaPath`、`keyword` 与中文 `message`）。失败返回 `400`，`code` 区分：`empty_instances` / `invalid_instances_json` / `instances_not_array` / `instances_empty` / `too_many_instances`（超过 100 条）/ `invalid_schema`（Ajv 编译失败）；外部 `$ref` 同样返回 `400`。

---

## 支持范围与限制

- 面向 **draft-07 风格**关键字；对 `type`（含类型数组）、`properties`/`required`/`additionalProperties`、`items`（单 schema 与元组数组）、`enum`/`const`、`minimum/maximum/exclusiveMinimum/exclusiveMaximum`、`minLength/maxLength`、`minItems/maxItems`、`pattern`、`format`、`uniqueItems` 做递归比对；
- 仅解析**本地 `$ref`**；外部引用（`http://...`、相对路径文件）会报错提示先内联；
- `$ref` 的兄弟关键字按 draft-07 习惯忽略（draft-2019-09 之后允许兄弟关键字，本工具不展开合并）；
- `allOf / oneOf / anyOf / not` 不做集合论推演，只给出需人工核对的提示条目；
- 纯语法启发式判定，不能替代完整的 JSON Schema 子包含（subschema containment）证明器。
