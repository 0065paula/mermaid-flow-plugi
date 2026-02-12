import {
  on,
  showUI,
  emit,
  loadSettingsAsync,
  saveSettingsAsync
} from '@create-figma-plugin/utilities'

function registerHandlers() {
  on('CREATE_MERMAID', async (description: unknown) => {
    const desc = typeof description === 'string' ? description.trim() : ''
    if (!desc) {
      emit('MERMAID_RESULT', { error: '请先输入流程描述' })
      return
    }
    const settings = await loadSettingsAsync({ apiKey: '', apiProvider: 'openai', model: 'gpt-4o-mini', baseUrl: '' })
    const apiKey = settings?.apiKey as string | undefined
    const apiProvider = (settings?.apiProvider as string) || 'openai'
    const model = (settings?.model as string) || 'gpt-4o-mini'
    const baseUrl = settings?.baseUrl as string | undefined

    if (!apiKey || apiKey.trim() === '') {
      emit('MERMAID_RESULT', {
        error: '请先在设置中配置 API Key'
      })
      return
    }

    const systemPrompt = `你是一个 Mermaid 图表专家。根据用户描述生成 flowchart 或 sequenceDiagram 的 Mermaid 代码。

规则：
1. 只返回纯 Mermaid 代码，不要包含 markdown 代码块标记（\`\`\`）、解释或多余文字。
2. 优先使用 flowchart TB（自上而下）或 flowchart LR（从左到右）。
3. 节点 ID 必须是纯英文字母和数字（如 A, Step1, CheckState），不能含中文、空格或特殊字符。
4. 中文标签放在方括号内，且方括号必须成对：A[部署成功] --> B[下一步]
5. 菱形判断节点用花括号：C{是否完成}
6. 箭头上的标签用竖线包裹：A -->|是| B  和  A -->|否| C
7. 标签文字内不要出现 [ ] { } | 等 Mermaid 保留字符，如有需要可用引号包裹。
8. 每行只写一条边或节点定义，不要在一行内写多条。
9. 生成后请自行检查所有括号是否成对闭合。`

    const requestStartTime = Date.now()
    const doCall = () =>
      callLLM({
        apiKey,
        apiProvider,
        model,
        baseUrl,
        systemPrompt,
        userPrompt: desc
      })
    const isEmptyContentError = (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e)
      return msg.startsWith('API 返回空内容') || msg.startsWith('Gemini 返回空内容')
    }
    try {
      let mermaidCode: string
      try {
        mermaidCode = await doCall()
      } catch (firstErr) {
        if (!isEmptyContentError(firstErr)) throw firstErr
        mermaidCode = await doCall()
      }
      emit('MERMAID_RESULT', { mermaidCode })
    } catch (err) {
      // 改进错误处理：更完善的类型检查和错误信息提取
      let message: string
      if (err instanceof Error) {
        message = err.message
      } else if (typeof err === 'string') {
        message = err
      } else if (err && typeof err === 'object') {
        // 尝试提取对象的所有属性，避免 JSON.stringify 返回 {}
        try {
          message = JSON.stringify(err, Object.getOwnPropertyNames(err))
        } catch {
          message = String(err)
        }
      } else if (err === null) {
        message = '返回 null 错误'
      } else if (err === undefined) {
        message = '返回 undefined 错误'
      } else {
        message = '未知错误类型'
      }

      const elapsedMs = Date.now() - requestStartTime
      let userMsg = message
      if (message === 'Failed to fetch' || message.includes('Failed to fetch')) {
        userMsg = '网络请求失败。请检查：1) 是否使用「自定义端点」？若使用，需在 manifest 的 networkAccess 中添加该域名；2) 若在中国大陆，api.openai.com 可能被阻断，建议使用 OpenRouter 或配置代理。'
      } else if (err instanceof Error && err.name === 'AbortError') {
        if (elapsedMs < 10000) {
          userMsg = '请求被中止（未发出或很快失败）。请检查：1) 网络是否可用；2) API Key 与模型是否正确；3) 若用代理/VPN 请确保 Figma 能访问 API 域名（如 openrouter.ai）。'
        } else {
          userMsg = '请求超时（120 秒）。Kimi 等思考模型较慢，可缩短描述后重试。'
        }
      } else if (message.toLowerCase().includes('abort')) {
        userMsg = '请求被中止。请检查网络与 API 设置后重试。'
      } else if (message.startsWith('API 返回空内容') || message.startsWith('Gemini 返回空内容')) {
        userMsg = 'API 返回空内容（已自动重试一次仍失败，请再次点击「生成 Mermaid 代码」）'
      }
      emit('MERMAID_RESULT', { error: userMsg })
    }
  })

  on('INSERT_SVG', async (payload: { svg: string; mermaidCode?: string }) => {
    let { svg, mermaidCode } = payload
    if (!svg || svg.trim() === '') {
      figma.notify('没有可插入的图表')
      return
    }
    const nodeLabels = mermaidCode?.trim() ? parseMermaidNodeLabels(mermaidCode) : {}
    const keys = Object.keys(nodeLabels)
    const tryInsert = (sanitizedSvg: string) => {
      let toInsert = sanitizedSvg
      if (keys.length > 0) {
        toInsert = injectNodeLabelsIntoMermaidSvg(sanitizedSvg, nodeLabels)
      } else {
        toInsert = injectNodeLabelsFromSvgIds(sanitizedSvg)
      }
      const node = figma.createNodeFromSvg(toInsert)
      node.x = figma.viewport.center.x - node.width / 2
      node.y = figma.viewport.center.y - node.height / 2
      figma.currentPage.appendChild(node)
      figma.currentPage.selection = [node]
      figma.viewport.scrollAndZoomIntoView([node])
      if (mermaidCode) {
        node.setPluginData('mermaidCode', mermaidCode)
        node.setRelaunchData({ edit: '编辑流程图' })
      }
      figma.notify('已插入流程图')
    }
    try {
      tryInsert(sanitizeSvgForFigma(svg))
    } catch (err) {
      try {
        tryInsert(sanitizeMinimalForFigma(svg))
      } catch (err2) {
        const msg = err2 instanceof Error ? err2.message : String(err2)
        figma.notify('插入失败：' + msg, { error: true })
        emit('INSERT_ERROR', { error: msg })
      }
    }
  })

  on('EXPORT_SVG', (payload: { svg: string; mermaidCode?: string }) => {
    let svg = payload?.svg?.trim()
    if (!svg) {
      emit('EXPORT_SVG_RESULT', { error: '没有可导出的预览' })
      return
    }
    const mermaidCode = payload?.mermaidCode?.trim()
    const nodeLabels = mermaidCode ? parseMermaidNodeLabels(mermaidCode) : {}
    const keys = Object.keys(nodeLabels)
    try {
      let sanitized = sanitizeSvgForFigma(svg)
      if (keys.length > 0) {
        sanitized = injectNodeLabelsIntoMermaidSvg(sanitized, nodeLabels)
      } else {
        sanitized = injectNodeLabelsFromSvgIds(sanitized)
      }
      emit('EXPORT_SVG_RESULT', { svg: sanitized })
    } catch (err) {
      emit('EXPORT_SVG_RESULT', { error: String(err instanceof Error ? err.message : err) })
    }
  })

  on('SAVE_SETTINGS', async (settings: Record<string, unknown>) => {
    await saveSettingsAsync(settings)
  })

  on('READ_SETTINGS', async () => {
    const settings = await loadSettingsAsync({ apiKey: '', apiProvider: 'openai', model: 'gpt-4o-mini', baseUrl: '' })
    emit('SETTINGS_LOADED', settings || {})
  })

  on('TEST_MODEL', async (payload: { apiKey: string; apiProvider: string; model: string; baseUrl?: string }) => {
    const { apiKey, apiProvider, model, baseUrl } = payload || {}
    if (!apiKey?.trim()) {
      emit('TEST_MODEL_RESULT', { error: '请先填写 API Key' })
      return
    }
    try {
      await callLLM({
        apiKey: apiKey.trim(),
        apiProvider: apiProvider || 'openai',
        model: model || 'gpt-4o-mini',
        baseUrl: baseUrl?.trim() || undefined,
        systemPrompt: 'You are a test. Reply with exactly: OK',
        userPrompt: 'test'
      }, 30000)
      emit('TEST_MODEL_RESULT', { success: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit('TEST_MODEL_RESULT', { error: message })
    }
  })

  on('FETCH_OPENROUTER_MODELS', async (payload: { apiKey: string }) => {
    const apiKey = payload?.apiKey?.trim()
    if (!apiKey) {
      emit('OPENROUTER_MODELS_RESULT', { error: '请先填写 API Key' })
      return
    }
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` }
      })
      if (!response.ok) {
        const err = await response.json().catch(() => ({})) as { error?: { message?: string } }
        emit('OPENROUTER_MODELS_RESULT', {
          error: err?.error?.message || `请求失败: ${response.status}`
        })
        return
      }
      const data = (await response.json()) as { data?: Array<{ id: string; name?: string }> }
      const list = data.data || []
      const models = list.map((m) => ({ id: m.id, name: m.name || m.id }))
      emit('OPENROUTER_MODELS_RESULT', { models })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emit('OPENROUTER_MODELS_RESULT', {
        error: message === 'Failed to fetch' ? '网络请求失败，请检查网络' : message
      })
    }
  })
}

export default function () {
  registerHandlers()
  showUI({ height: 520, width: 360 })
}

export function edit() {
  registerHandlers()
  let initialMermaid = ''
  const selection = figma.currentPage.selection
  if (selection.length === 1) {
    const node = selection[0] as SceneNode & { getPluginData?: (k: string) => string }
    if (node.getPluginData) {
      initialMermaid = node.getPluginData('mermaidCode') || ''
    }
  }
  showUI(
    { height: 520, width: 360 },
    { editMermaidCode: initialMermaid }
  )
}

/** 从 Mermaid 流程图/序列图源码中解析节点 id -> 显示标签（用于补全 SVG 中缺失的节点文字） */
function parseMermaidNodeLabels(mermaidCode: string): Record<string, string> {
  const map: Record<string, string> = {}
  const code = mermaidCode.replace(/^\s*%%[^\n]*\n/gm, '').trim()
  // 矩形/圆角: A[标签] 或 A(标签)
  const patterns = [
    /(\w+)\s*\[([^\]]*)\]/g,
    /(\w+)\s*\(([^)]*)\)/g,
    /(\w+)\s*\{([^}]*)\}/g,
    /(\w+)\s*\[\[([^\]]*)\]\]/g,
    /(\w+)\s*\(\(([^)]*)\)\)/g,
    /(\w+)\s*\[\(([^)]*)\)\]/g,
    /(\w+)\s*\{\{([^}]*)\}\}/g,
    /(\w+)\s*\/\[([^\]]*)\]\//g,
    /(\w+)\s*\/\(([^)]*)\)\//g
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(code)) !== null) {
      const id = m[1]
      const label = m[2].trim()
      if (label && !map[id]) map[id] = label
    }
  }
  return map
}

/** 为 Mermaid flowchart 节点补全缺失的 <text> 标签（保留可编辑文本，不转 path） */
function injectNodeLabelsIntoMermaidSvg(svg: string, nodeLabels: Record<string, string>): string {
  if (Object.keys(nodeLabels).length === 0) return svg
  return injectNodeLabelsIntoMermaidSvgInner(svg, (nodeId: string) => nodeLabels[nodeId])
}

/** 无 Mermaid 源码时，用 SVG 中的节点 id 作为标签注入（保证至少显示节点 id） */
function injectNodeLabelsFromSvgIds(svg: string): string {
  return injectNodeLabelsIntoMermaidSvgInner(svg, (nodeId: string) => nodeId)
}

function injectNodeLabelsIntoMermaidSvgInner(svg: string, getLabel: (nodeId: string) => string | undefined): string {
  const escapeXml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const nodeRe = /(<g\s+[^>]*id="flowchart-([^-"]+)-\d+"[^>]*>)/gi
  const parts = svg.split(nodeRe)
  if (parts.length < 3) return svg
  let result = parts[0]
  for (let i = 1; i < parts.length; i += 3) {
    const openTag = parts[i]
    const nodeId = parts[i + 1]
    let inner = parts[i + 2] || ''
    const label = getLabel(nodeId)
    if (label) {
      const textEl = `<text x="0" y="0" dy="-0.08em" text-anchor="middle" dominant-baseline="middle" fill="#333333" font-size="14" font-family="sans-serif">${escapeXml(label)}</text>`
      inner = inner.replace(
        /(<g\s+class="label"[^>]*>\s*<rect[^>]*>\s*<\/rect>)(\s*<\/g>)/i,
        (_: string, prefix: string, suffix: string) => prefix + textEl + suffix
      )
    }
    result += openTag + inner
  }
  return result
}

/**
 * Figma 的 createNodeFromSvg 不解析 <style> 块里的 CSS 类，
 * 导致所有元素失去样式而按 SVG 默认 fill=black 渲染。
 * 核心做法：从 <style> 里提取 CSS 规则，内联到元素的 style 属性上，然后删除 <style>。
 * 同时清理 filter、foreignObject 等 Figma 不支持的内容。
 */
function sanitizeSvgForFigma(svg: string): string {
  let result = svg

  // 移除 Figma 不支持的标签
  result = result.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
  result = result.replace(/<script[\s\S]*?<\/script>/gi, '')
  result = result.replace(/<title>[\s\S]*?<\/title>/gi, '')

  // 规范化属性之间的空白+换行（避免属性值内换行导致解析错误）
  result = result.replace(/\s+\n\s*/g, ' ')

  // 修复 Mermaid 输出的非法 font-family：""trebuchet ms",..." 导致 XML 属性解析错误（未转义内层引号；值中可有换行）
  result = result.replace(
    /font-family\s*=\s*""([^"]*)"\s*,\s*([\s\S]*?)"\s*/gi,
    (_, first: string, rest: string) => `font-family="'${first}',${rest.trim().replace(/\s+/g, ' ')}" `
  )

  // ---- 1. 解析 <style> 块，提取 CSS class 规则 ----
  const classStyles: Record<string, Record<string, string>> = {}
  const styleBlockRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi
  let styleMatch
  while ((styleMatch = styleBlockRegex.exec(result)) !== null) {
    const css = styleMatch[1]
    // 匹配形如 .className { prop: val; ... } 和 .a .b { ... } 等
    const ruleRegex = /([^{}]+)\{([^}]*)\}/g
    let ruleMatch
    while ((ruleMatch = ruleRegex.exec(css)) !== null) {
      const selectorGroup = ruleMatch[1].trim()
      const declarations = ruleMatch[2].trim()
      if (!declarations) continue
      // 解析属性
      const props: Record<string, string> = {}
      declarations.split(';').forEach(decl => {
        const colonIdx = decl.indexOf(':')
        if (colonIdx < 0) return
        const prop = decl.substring(0, colonIdx).trim()
        const val = decl.substring(colonIdx + 1).trim().replace(/!important/gi, '').trim()
        if (prop && val) props[prop] = val
      })
      // 把每个选择器里的类名都记录下来（取最后一个类名用于简化匹配）
      selectorGroup.split(',').forEach(sel => {
        const parts = sel.trim().split(/\s+/)
        // 取最后一个 .className
        for (let i = parts.length - 1; i >= 0; i--) {
          const dotClasses = parts[i].match(/\.([a-zA-Z0-9_-]+)/g)
          if (dotClasses) {
            dotClasses.forEach(dc => {
              const clsName = dc.substring(1)
              if (!classStyles[clsName]) classStyles[clsName] = {}
              Object.assign(classStyles[clsName], props)
            })
            break
          }
        }
      })
    }
  }

  // 移除 <style> 块
  result = result.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')

  // ---- 2. 把 CSS 属性内联到带 class 的元素上 ----
  // CSS 属性名 → SVG 属性名映射（部分属性既可做 CSS 也可做 SVG attr）
  const cssToSvgAttr: Record<string, string> = {
    'fill': 'fill',
    'stroke': 'stroke',
    'stroke-width': 'stroke-width',
    'stroke-dasharray': 'stroke-dasharray',
    'stroke-dashoffset': 'stroke-dashoffset',
    'stroke-linecap': 'stroke-linecap',
    'stroke-linejoin': 'stroke-linejoin',
    'stroke-miterlimit': 'stroke-miterlimit',
    'stroke-opacity': 'stroke-opacity',
    'fill-opacity': 'fill-opacity',
    'fill-rule': 'fill-rule',
    'opacity': 'opacity',
    'font-family': 'font-family',
    'font-size': 'font-size',
    'font-weight': 'font-weight',
    'font-style': 'font-style',
    'text-anchor': 'text-anchor',
    'dominant-baseline': 'dominant-baseline',
    'text-decoration': 'text-decoration',
    'visibility': 'visibility',
    'display': 'display',
  }

  result = result.replace(/<(\w+)([^>]*)>/g, (fullMatch, tagName, attrs) => {
    const classMatch = attrs.match(/\bclass\s*=\s*["']([^"']+)["']/)
    if (!classMatch) return fullMatch
    const classNames = classMatch[1].split(/\s+/)
    // 收集此元素应有的 CSS 属性
    const merged: Record<string, string> = {}
    classNames.forEach((cn: string) => {
      if (classStyles[cn]) Object.assign(merged, classStyles[cn])
    })
    if (Object.keys(merged).length === 0) return fullMatch

    // 把已有的 inline style 解析出来（优先级高于类样式）；(*) 允许空值，避免 style="" 未匹配导致重复追加 style
    const existingStyleMatch = attrs.match(/\bstyle\s*=\s*["']([^"']*)["']/)
    const existingInline: Record<string, string> = {}
    if (existingStyleMatch) {
      existingStyleMatch[1].split(';').forEach((decl: string) => {
        const ci = decl.indexOf(':')
        if (ci < 0) return
        const p = decl.substring(0, ci).trim()
        const v = decl.substring(ci + 1).trim()
        if (p && v) existingInline[p] = v
      })
    }

    let newAttrs = attrs
    // 把可作为 SVG 属性的 CSS props 写成属性（仅当元素上还没有同名属性时）
    for (const [cssProp, val] of Object.entries(merged)) {
      const svgAttr = cssToSvgAttr[cssProp]
      if (svgAttr) {
        // 如果元素上已有此属性或 inline style 里已有，跳过
        const attrRegex = new RegExp(`\\b${svgAttr}\\s*=`, 'i')
        if (!attrRegex.test(newAttrs) && !existingInline[cssProp]) {
          newAttrs += ` ${svgAttr}="${val}"`
        }
      }
    }

    // 剩余非 SVG 属性放到 style 里
    const remainingStyles: string[] = []
    for (const [cssProp, val] of Object.entries(merged)) {
      if (!cssToSvgAttr[cssProp] && !existingInline[cssProp]) {
        remainingStyles.push(`${cssProp}:${val}`)
      }
    }
    if (remainingStyles.length > 0) {
      if (existingStyleMatch) {
        const existingPart = existingStyleMatch[1].replace(/;?\s*$/, '').trim()
        const combined = existingPart ? existingPart + ';' + remainingStyles.join(';') : remainingStyles.join(';')
        newAttrs = newAttrs.replace(existingStyleMatch[0], `style="${combined}"`)
      } else {
        newAttrs += ` style="${remainingStyles.join(';')}"`
      }
    }

    return `<${tagName}${newAttrs}>`
  })

  // ---- 3. 清理 defs 中的 filter（保留 marker 用于箭头） ----
  // 只删 filter 和 clipPath 定义，保留 marker
  result = result.replace(/<filter\b[\s\S]*?<\/filter>/gi, '')
  result = result.replace(/<clipPath\b[\s\S]*?<\/clipPath>/gi, '')
  // 移除引用
  result = result.replace(/\s*filter\s*=\s*["']url\([^"']+\)["']/gi, '')
  result = result.replace(/\s*clip-path\s*=\s*["']url\([^"']+\)["']/gi, '')

  // 如果 defs 变空了，删掉空 defs
  result = result.replace(/<defs[^>]*>\s*<\/defs>/gi, '')

  // ---- 4. currentColor 替换 ----
  result = result.replace(/\bcurrentColor\b/g, '#333333')

  // ---- 5. 确保所有文字元素有显式 fill，否则 Figma 中易丢失或不可见 ----
  result = result.replace(/(<text\b)([^>]*)(>)/gi, (_, open, attrs, close) => {
    if (!/\bfill\s*=/i.test(attrs)) return open + attrs + ' fill="#333333"' + close
    return open + attrs + close
  })
  result = result.replace(/(<tspan\b)([^>]*)(>)/gi, (_, open, attrs, close) => {
    if (!/\bfill\s*=/i.test(attrs)) return open + attrs + ' fill="#333333"' + close
    return open + attrs + close
  })

  // ---- 5b. 节点框去掉描边（仅对 flowchart 节点 <g id="flowchart-...">） ----
  result = result.replace(
    /(<g\s+[^>]*id="flowchart-[^"]+"[^>]*)\s+stroke="[^"]*"/gi,
    '$1 stroke="none"'
  )
  result = result.replace(
    /(<g\s+[^>]*id="flowchart-[^"]+"[^>]*)\s+stroke-width="[^"]*"/gi,
    ''
  )

  // ---- 6. 确保根 <svg> 有 xmlns，避免 Figma 转换失败 ----
  if (!/<svg\b[^>]*\bxmlns\s*=/i.test(result)) {
    result = result.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  }

  return result
}

/**
 * 极简清理：当完整清理后仍无法被 createNodeFromSvg 转换时使用。
 * 移除 style/defs，为 path 设 fill=none stroke，为形状设 fill+stroke，保证可解析。
 */
function sanitizeMinimalForFigma(svg: string): string {
  let r = svg
  r = r.replace(/font-family\s*=\s*""([^"]*)"\s*,\s*([\s\S]*?)"\s*/gi, (_, first: string, rest: string) => `font-family="'${first}',${rest.trim().replace(/\s+/g, ' ')}" `)
  r = r.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
  r = r.replace(/<defs[\s\S]*?<\/defs>/gi, '')
  r = r.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
  r = r.replace(/\s*filter\s*=\s*["']url\([^"']+\)["']/gi, '')
  r = r.replace(/\s*clip-path\s*=\s*["']url\([^"']+\)["']/gi, '')
  r = r.replace(/\bcurrentColor\b/g, '#333333')
  r = r.replace(/(<path\b)([^>]*)(>)/gi, (_, open, attrs, close) => {
    let a = attrs
    if (!/\bfill\s*=/i.test(a)) a += ' fill="none"'
    if (!/\bstroke\s*=/i.test(a)) a += ' stroke="#333333"'
    return open + a + close
  })
  r = r.replace(/(<(?:rect|circle|ellipse|polygon)\b)([^>]*)(>)/gi, (_, open, attrs, close) => {
    let a = attrs
    if (!/\bfill\s*=/i.test(a)) a += ' fill="#f5f5f5"'
    if (!/\bstroke\s*=/i.test(a)) a += ' stroke="#333333"'
    return open + a + close
  })
  r = r.replace(/(<text\b)([^>]*)(>)/gi, (_, open, attrs, close) => {
    if (!/\bfill\s*=/i.test(attrs)) return open + attrs + ' fill="#333333"' + close
    return open + attrs + close
  })
  r = r.replace(/(<tspan\b)([^>]*)(>)/gi, (_, open, attrs, close) => {
    if (!/\bfill\s*=/i.test(attrs)) return open + attrs + ' fill="#333333"' + close
    return open + attrs + close
  })
  if (!/<svg\b[^>]*\bxmlns\s*=/i.test(r)) {
    r = r.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  }
  return r
}

async function callLLM(params: {
  apiKey: string
  apiProvider: string
  model: string
  baseUrl?: string
  systemPrompt: string
  userPrompt: string
}, timeoutMs = 120000): Promise<string> {
  const { apiKey, apiProvider, model, baseUrl, systemPrompt, userPrompt } = params

  if (apiProvider === 'gemini') {
    return callGemini(apiKey, model, systemPrompt, userPrompt, timeoutMs)
  }

  const url = apiProvider === 'custom' && baseUrl
      ? `${baseUrl.replace(/\/$/, '')}/chat/completions`
      : apiProvider === 'openrouter'
        ? 'https://openrouter.ai/api/v1/chat/completions'
        : 'https://api.openai.com/v1/chat/completions'

  const body: Record<string, unknown> = {
    model: model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.3,
    max_tokens: 2048
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  }
  if (apiProvider === 'openrouter') {
    headers['HTTP-Referer'] = 'figma://mermaid-flow-plugin'
    headers['X-Title'] = 'Mermaid Flow Plugin'
  }

  const hasAbort = typeof AbortController !== 'undefined'
  const controller = hasAbort ? new AbortController() : null
  const timeoutId = controller ? setTimeout(() => controller!.abort(), timeoutMs) : null

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    ...(controller ? { signal: controller.signal } : {})
  })
  if (timeoutId) clearTimeout(timeoutId)

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: { message?: string } }
    const msg = err?.error?.message || `API 错误: ${response.status}`
    if (response.status === 504 || response.status === 408) {
      throw new Error(`服务端超时 (${response.status})，请稍后重试`)
    }
    throw new Error(msg)
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = data.choices?.[0]?.message?.content
  if (!content || typeof content !== 'string') {
    const finishReason = (data.choices?.[0] as { finish_reason?: string } | undefined)?.finish_reason
    const hint = finishReason ? ` (finish_reason: ${finishReason})` : ''
    throw new Error('API 返回空内容' + hint)
  }

  return extractMermaidCode(content)
}

async function callGemini(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs = 120000
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || 'gemini-2.0-flash'}:generateContent?key=${apiKey}`
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: `${systemPrompt}\n\n${userPrompt}` }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 2048
    }
  }
  const hasAbort = typeof AbortController !== 'undefined'
  const controller = hasAbort ? new AbortController() : null
  const timeoutId = controller ? setTimeout(() => controller!.abort(), timeoutMs) : null
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(controller ? { signal: controller.signal } : {})
  })
  if (timeoutId) clearTimeout(timeoutId)

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: { message?: string } }
    throw new Error(err?.error?.message || `Gemini API 错误: ${response.status}`)
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) {
    const blockReason = (data.candidates?.[0] as { finishReason?: string } | undefined)?.finishReason
    const hint = blockReason ? ` (finishReason: ${blockReason})` : ''
    throw new Error('Gemini 返回空内容' + hint)
  }
  return extractMermaidCode(text)
}

function extractMermaidCode(text: string): string {
  const trimmed = text.trim()
  const mdBlock = trimmed.match(/```(?:mermaid)?\s*([\s\S]*?)```/)
  if (mdBlock) {
    return mdBlock[1].trim()
  }
  return trimmed
}
