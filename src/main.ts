import {
  on,
  showUI,
  emit,
  loadSettingsAsync,
  saveSettingsAsync
} from '@create-figma-plugin/utilities'

function registerHandlers() {
  on('CREATE_MERMAID', async (description: string) => {
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
只返回纯 Mermaid 代码，不要包含 markdown 代码块标记、解释或多余文字。
优先使用 flowchart LR 或 flowchart TB。节点 ID 使用英文，标签可中英文。`

    try {
      const mermaidCode = await callLLM({
        apiKey,
        apiProvider,
        model,
        baseUrl,
        systemPrompt,
        userPrompt: description
      })
      emit('MERMAID_RESULT', { mermaidCode })
    } catch (err) {
      const message = err instanceof Error ? err.message : (typeof err === 'string' ? err : JSON.stringify(err))
      let userMsg = String(message)
      if (message === 'Failed to fetch' || (typeof message === 'string' && message.includes('Failed to fetch'))) {
        userMsg = '网络请求失败。请检查：1) 是否使用「自定义端点」？若使用，需在 manifest 的 networkAccess 中添加该域名；2) 若在中国大陆，api.openai.com 可能被阻断，建议使用 OpenRouter 或配置代理。'
      } else if ((err instanceof Error && err.name === 'AbortError') || (typeof message === 'string' && message.toLowerCase().includes('abort'))) {
        userMsg = '请求超时（90 秒）。Kimi 等思考模型较慢，可缩短描述后重试。'
      }
      emit('MERMAID_RESULT', { error: userMsg })
    }
  })

  on('INSERT_SVG', async (payload: { svg: string; mermaidCode?: string }) => {
    const { svg, mermaidCode } = payload
    if (!svg || svg.trim() === '') {
      figma.notify('没有可插入的图表')
      return
    }
    try {
      const sanitized = sanitizeSvgForFigma(svg)
      const node = figma.createNodeFromSvg(sanitized)
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
    } catch (err) {
      figma.notify('插入失败：' + (err instanceof Error ? err.message : String(err)), {
        error: true
      })
      emit('INSERT_ERROR', { error: String(err) })
    }
  })

  on('SAVE_SETTINGS', async (settings: Record<string, unknown>) => {
    await saveSettingsAsync(settings)
  })

  on('READ_SETTINGS', async () => {
    const settings = await loadSettingsAsync({ apiKey: '', apiProvider: 'openai', model: 'gpt-4o-mini', baseUrl: '' })
    emit('SETTINGS_LOADED', settings || {})
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

function sanitizeSvgForFigma(svg: string): string {
  let result = svg
  result = result.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
  result = result.replace(/<script[\s\S]*?<\/script>/gi, '')
  result = result.replace(/<title>[\s\S]*?<\/title>/gi, '')
  return result
}

async function callLLM(params: {
  apiKey: string
  apiProvider: string
  model: string
  baseUrl?: string
  systemPrompt: string
  userPrompt: string
}): Promise<string> {
  const { apiKey, apiProvider, model, baseUrl, systemPrompt, userPrompt } = params

  if (apiProvider === 'gemini') {
    return callGemini(apiKey, model, systemPrompt, userPrompt)
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

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 120000)

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: controller.signal
  })
  clearTimeout(timeoutId)

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
    throw new Error('API 返回空内容')
  }

  return extractMermaidCode(content)
}

async function callGemini(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
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
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 120000)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal
  })
  clearTimeout(timeoutId)

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: { message?: string } }
    throw new Error(err?.error?.message || `Gemini API 错误: ${response.status}`)
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) {
    throw new Error('Gemini 返回空内容')
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
