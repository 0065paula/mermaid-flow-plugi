# Mermaid Flow Plugin 工作机制与系统提示词

本文档说明插件的整体架构、数据流，以及调用 LLM 时使用的完整系统提示词。

---

## 一、架构概览

插件基于 [Create Figma Plugin](https://yuanqing.github.io/create-figma-plugin/) 构建，分为两个运行环境：

| 环境 | 文件 | 职责 |
|------|------|------|
| **主线程 (Main)** | `src/main.ts` | Figma 沙箱内运行：处理 UI 发来的消息、调用 LLM API、读写设置、插入 SVG、拉取 OpenRouter 模型列表等。 |
| **UI (iframe)** | `src/ui.tsx` | 在 iframe 中运行：自然语言输入、Mermaid 代码编辑、用 Mermaid 库实时渲染预览、API 设置与测试模型等。 |

两者通过 `emit` / `on` 进行单向消息通信（UI → Main 或 Main → UI）。

---

## 二、端到端流程

### 2.1 生成 Mermaid 代码

```
用户输入自然语言
    → 点击「生成 Mermaid 代码」
    → UI emit('CREATE_MERMAID', description)
    → Main 收到后 loadSettingsAsync 取 API Key / 提供商 / 模型
    → Main 调用 callLLM(systemPrompt, userPrompt) 请求 OpenAI / OpenRouter / Gemini / 自定义端点
    → LLM 返回纯 Mermaid 代码（或错误）
    → Main emit('MERMAID_RESULT', { mermaidCode } | { error })
    → UI 收到后 setMermaidCode / setError，并触发 Mermaid 渲染预览
```

- **超时**：主线程请求 LLM 时使用 120 秒 AbortController（若环境支持）；UI 另有 90 秒兜底提示。
- **错误**：网络失败、API 错误、超时等会通过 `MERMAID_RESULT.error` 回传，并在 UI 中展示。

### 2.2 插入到 Figma 画布

```
用户在预览区确认图表
    → 点击「插入到画布」
    → UI 将当前预览用 Mermaid 渲染得到的 SVG 与 mermaidCode 一起 emit('INSERT_SVG', { svg, mermaidCode })
    → Main 收到后：
        1. sanitizeSvgForFigma(svg) 做 Figma 兼容处理
        2. figma.createNodeFromSvg(sanitized) 生成矢量节点
        3. 将节点居中、选中、滚动到视口
        4. 若有 mermaidCode，写入 node.setPluginData('mermaidCode', …) 并 setRelaunchData({ edit: '编辑流程图' })
    → figma.notify('已插入流程图')
```

- **编辑流程图**：用户选中已插入的节点后，在属性面板点击「编辑流程图」会 relaunch 插件，并把之前保存的 `mermaidCode` 通过 `showUI(…, { editMermaidCode })` 传给 UI，用户可修改代码后再次插入。

### 2.3 其他功能

- **API 设置**：UI 通过 `READ_SETTINGS` / `SETTINGS_LOADED`、`SAVE_SETTINGS` 与 Main 的 `loadSettingsAsync` / `saveSettingsAsync` 同步。
- **测试模型**：UI emit `TEST_MODEL`（当前 API Key、提供商、模型、baseUrl），Main 用相同 callLLM 逻辑发一句简单请求（30 秒超时），再 emit `TEST_MODEL_RESULT`。
- **OpenRouter 模型列表**：UI emit `FETCH_OPENROUTER_MODELS`，Main 请求 `GET https://openrouter.ai/api/v1/models` 后 emit `OPENROUTER_MODELS_RESULT`；UI 支持按关键词模糊搜索并选择模型。

---

## 三、SVG 与 Figma 的兼容处理（sanitizeSvgForFigma）

Figma 的 `createNodeFromSvg` **不解析 SVG 内的 `<style>` 块**，若不做处理，所有元素会按默认 fill 渲染成黑块。插件在插入前对 Mermaid 输出的 SVG 做以下处理：

1. **移除不支持的标签**：`<foreignObject>`、`<script>`、`<title>`。
2. **解析 `<style>` 并内联**：从 `<style>` 中提取 `.className { prop: val; … }`，按元素的 `class` 把 `fill`、`stroke`、`stroke-width` 等写成元素上的属性或 `style="..."`，然后删除 `<style>`，避免 Figma 忽略类样式导致全黑。
3. **清理 filter / clipPath**：删除 `<filter>`、`<clipPath>` 及其引用，避免引用失效或解析异常；保留 `<marker>` 等用于箭头。
4. **currentColor**：将剩余的 `currentColor` 替换为 `#333333`，保证在 Figma 中可见。

这样连接线会得到 `fill="none"` + `stroke="…"`，节点会得到正确的 fill/stroke，插入后不再出现大面积黑色填充。

---

## 四、完整系统提示词

以下为当前在 `main.ts` 中用于「生成 Mermaid 代码」的**完整系统提示词**（一字不差）：

```
你是一个 Mermaid 图表专家。根据用户描述生成 flowchart 或 sequenceDiagram 的 Mermaid 代码。

规则：
1. 只返回纯 Mermaid 代码，不要包含 markdown 代码块标记（```）、解释或多余文字。
2. 优先使用 flowchart TB（自上而下）或 flowchart LR（从左到右）。
3. 节点 ID 必须是纯英文字母和数字（如 A, Step1, CheckState），不能含中文、空格或特殊字符。
4. 中文标签放在方括号内，且方括号必须成对：A[部署成功] --> B[下一步]
5. 菱形判断节点用花括号：C{是否完成}
6. 箭头上的标签用竖线包裹：A -->|是| B  和  A -->|否| C
7. 标签文字内不要出现 [ ] { } | 等 Mermaid 保留字符，如有需要可用引号包裹。
8. 每行只写一条边或节点定义，不要在一行内写多条。
9. 生成后请自行检查所有括号是否成对闭合。
```

**用户输入（user prompt）**：用户在插件输入框中填写的自然语言流程描述，例如「用户登录后选择产品，加入购物车，然后结账」。

LLM 的回复会被 `extractMermaidCode()` 处理：若被包在 ` ```mermaid ... ``` ` 中则只取代码块内容，否则取整段文本，再交给 UI 侧的 Mermaid 库渲染预览。

---

## 五、API 与模型

- **支持的提供商**：OpenAI、OpenRouter、Google Gemini、自定义端点（需在 manifest 的 `networkAccess.allowedDomains` 中配置域名）。
- **请求**：主线程使用 `fetch` 调用各家的 Chat Completions 风格 API；Gemini 使用独立的 `generateContent` 端点。
- **超时**：生成 Mermaid 为 120 秒，测试模型为 30 秒；若运行环境无 `AbortController`，则不挂 signal，仅依赖服务端/网络超时。

---

## 六、相关文件索引

| 文件 | 说明 |
|------|------|
| `src/main.ts` | 主线程：CREATE_MERMAID / INSERT_SVG / TEST_MODEL / FETCH_OPENROUTER_MODELS、callLLM、sanitizeSvgForFigma、edit relaunch。 |
| `src/ui.tsx` | UI：输入、生成按钮、Mermaid 代码编辑、预览、插入、API 设置、OpenRouter 模型下拉与模糊搜索、测试模型。 |
| `package.json` | `figma-plugin` 配置（editorType、networkAccess、relaunchButtons 等）。 |

如需调整生成质量或风格，只需修改 `main.ts` 中的 `systemPrompt` 并重新构建即可。
