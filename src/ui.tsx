import { render } from '@create-figma-plugin/ui'
import {
  Button,
  TextboxMultiline,
  Disclosure,
  Text,
  LoadingIndicator,
  VerticalSpace
} from '@create-figma-plugin/ui'
import { emit, on } from '@create-figma-plugin/utilities'
import { h } from 'preact'
import { useState, useEffect, useCallback, useRef } from 'preact/hooks'
import mermaid from 'mermaid'
import '!./output.css'

/** 模糊匹配：query 的每个字符按顺序出现在 text 中即视为匹配 */
function fuzzyMatch (query: string, text: string): boolean {
  const q = query.toLowerCase().trim()
  if (!q) return true
  const t = text.toLowerCase()
  let j = 0
  for (let i = 0; i < t.length && j < q.length; i++) {
    if (t[i] === q[j]) j++
  }
  return j === q.length
}

mermaid.initialize({
  startOnLoad: false,
  flowchart: { htmlLabels: false },
  sequence: { useMaxWidth: true },
  securityLevel: 'loose',
  theme: 'neutral'
})

let renderId = 0

function Plugin (props: { editMermaidCode?: string }) {
  const [description, setDescription] = useState('')
  const [mermaidCode, setMermaidCode] = useState(props.editMermaidCode || 'flowchart LR\n  A[开始] --> B[结束]')
  const [previewSvg, setPreviewSvg] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [apiProvider, setApiProvider] = useState('openai')
  const [model, setModel] = useState('gpt-4o-mini')
  const [baseUrl, setBaseUrl] = useState('')
  const [openRouterModels, setOpenRouterModels] = useState<Array<{ id: string; name: string }>>([])
  const [openRouterModelsLoading, setOpenRouterModelsLoading] = useState(false)
  const [openRouterModelsError, setOpenRouterModelsError] = useState<string | null>(null)
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false)
  const [modelSearchQuery, setModelSearchQuery] = useState('')
  const [testModelLoading, setTestModelLoading] = useState(false)
  const [testModelResult, setTestModelResult] = useState<{ success?: boolean; error?: string } | null>(null)
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const modelDropdownRef = useRef<HTMLDivElement>(null)

  const renderMermaid = useCallback(async (code: string) => {
    if (!code.trim()) {
      setPreviewSvg(null)
      setPreviewError(null)
      return
    }
    const id = `mermaid-${++renderId}`
    try {
      const { svg } = await mermaid.render(id, code)
      setPreviewSvg(svg)
      setPreviewError(null)
    } catch (err) {
      setPreviewSvg(null)
      setPreviewError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    renderMermaid(mermaidCode)
  }, [mermaidCode, renderMermaid])

  useEffect(() => {
    if (props.editMermaidCode) {
      setMermaidCode(props.editMermaidCode)
    }
  }, [props.editMermaidCode])

  useEffect(() => {
    const unsub = on('MERMAID_RESULT', (payload: { mermaidCode?: string; error?: unknown }) => {
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current)
        fallbackTimerRef.current = null
      }
      setLoading(false)
      if (payload.error !== undefined && payload.error !== null) {
        const errMsg = typeof payload.error === 'string'
          ? payload.error
          : payload.error instanceof Error
            ? payload.error.message
            : JSON.stringify(payload.error)
        setError(errMsg)
        return
      }
      if (payload.mermaidCode) {
        setMermaidCode(payload.mermaidCode)
        setError(null)
      }
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = on('SETTINGS_LOADED', (settings: Record<string, unknown> | undefined) => {
      if (settings) {
        setApiKey((settings.apiKey as string) || '')
        setApiProvider((settings.apiProvider as string) || 'openai')
        setModel((settings.model as string) || 'gpt-4o-mini')
        setBaseUrl((settings.baseUrl as string) || '')
      }
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = on('OPENROUTER_MODELS_RESULT', (payload: { models?: Array<{ id: string; name: string }>; error?: string }) => {
      setOpenRouterModelsLoading(false)
      if (payload.error) {
        setOpenRouterModelsError(payload.error)
        setOpenRouterModels([])
        return
      }
      setOpenRouterModelsError(null)
      if (payload.models) {
        setOpenRouterModels(payload.models)
      }
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = on('TEST_MODEL_RESULT', (payload: { success?: boolean; error?: string }) => {
      setTestModelLoading(false)
      setTestModelResult(payload.error ? { error: payload.error } : { success: true })
    })
    return unsub
  }, [])

  const handleTestModel = () => {
    setTestModelResult(null)
    setTestModelLoading(true)
    emit('TEST_MODEL', {
      apiKey,
      apiProvider,
      model,
      baseUrl: apiProvider === 'custom' ? baseUrl : undefined
    })
  }

  const handleFetchOpenRouterModels = () => {
    if (!apiKey.trim()) return
    setOpenRouterModelsLoading(true)
    setOpenRouterModelsError(null)
    emit('FETCH_OPENROUTER_MODELS', { apiKey: apiKey.trim() })
  }

  const filteredOpenRouterModels = openRouterModels.filter(
    (m) => fuzzyMatch(modelSearchQuery, m.id) || fuzzyMatch(modelSearchQuery, m.name)
  )

  const handleGenerate = () => {
    if (!description.trim()) {
      setError('请输入流程描述')
      return
    }
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current)
    }
    setLoading(true)
    setError(null)
    emit('CREATE_MERMAID', description.trim())
    // UI 超时设置为 90 秒，比 fetch 超时（120 秒）短，提前给用户反馈
    fallbackTimerRef.current = setTimeout(() => {
      setLoading((prev) => {
        if (prev) {
          setError('超过 90 秒未响应，请检查网络和 API Key 后重试')
          return false
        }
        return prev
      })
      fallbackTimerRef.current = null
    }, 90000)
  }

  const handleInsert = async () => {
    if (!previewSvg) {
      setError('无法插入：预览渲染失败')
      return
    }
    emit('INSERT_SVG', { svg: previewSvg, mermaidCode })
  }

  const handleCodeChange = (value: string) => {
    setMermaidCode(value)
  }

  const handleSaveSettings = () => {
    emit('SAVE_SETTINGS', {
      apiKey,
      apiProvider,
      model,
      baseUrl: apiProvider === 'custom' ? baseUrl : undefined
    })
    setSettingsOpen(false)
  }

  useEffect(() => {
    emit('READ_SETTINGS')
  }, [])

  return (
    <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
      <Text>用自然语言描述流程，生成 Mermaid 图表</Text>
      <TextboxMultiline
        value={description}
        onValueInput={setDescription}
        placeholder="例如：用户登录后选择产品，加入购物车，然后结账"
        rows={3}
      />
      <Button onClick={handleGenerate} disabled={loading}>
        {loading ? (
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <LoadingIndicator />
              生成中...
            </span>
            <Text style={{ fontSize: 11, color: 'var(--figma-color-text-tertiary)' }}>
              Kimi 等模型可能需 1–2 分钟，超时 90 秒自动停止
            </Text>
          </span>
        ) : (
          '生成 Mermaid 代码'
        )}
      </Button>

      {error && (
        <div style={{ color: 'var(--figma-color-text-danger)', fontSize: 12 }}>
          {typeof error === 'string' ? error : JSON.stringify(error)}
        </div>
      )}

      <VerticalSpace space="small" />
      <Text><strong>Mermaid 代码</strong></Text>
      <TextboxMultiline
        value={mermaidCode}
        onValueInput={handleCodeChange}
        placeholder="flowchart LR ..."
        rows={6}
      />

      <Text><strong>预览</strong></Text>
      <div
        style={{
          minHeight: 120,
          border: '1px solid var(--figma-color-border)',
          borderRadius: 6,
          padding: 12,
          background: 'var(--figma-color-bg)',
          overflow: 'auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        {previewError ? (
          <Text style={{ color: 'var(--figma-color-text-danger)', fontSize: 12 }}>{previewError}</Text>
        ) : previewSvg ? (
          <div dangerouslySetInnerHTML={{ __html: previewSvg }} />
        ) : (
          <Text style={{ color: 'var(--figma-color-text-tertiary)' }}>输入代码后显示预览</Text>
        )}
      </div>

      <Button onClick={handleInsert} disabled={!previewSvg}>
        插入到画布
      </Button>

      <VerticalSpace space="small" />
      <Disclosure
        open={settingsOpen}
        onClick={() => setSettingsOpen(!settingsOpen)}
        title="API 设置"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8 }}>
          <div>
            <Text>API Key</Text>
            <TextboxMultiline
              value={apiKey}
              onValueInput={setApiKey}
              placeholder="sk-..."
              rows={2}
            />
          </div>
          <div>
            <Text>提供商</Text>
            {apiProvider === 'openrouter' && (
              <Text style={{ fontSize: 11, color: 'var(--figma-color-text-tertiary)', marginBottom: 4 }}>
                使用 Kimi 请选此项，模型填 moonshotai/kimi-k2-thinking（需 OpenRouter API Key）
              </Text>
            )}
            <select
              value={apiProvider}
              onChange={(e) => setApiProvider((e.target as HTMLSelectElement).value)}
              style={{
                width: '100%',
                padding: 8,
                borderRadius: 6,
                border: '1px solid var(--figma-color-border)'
              }}
            >
              <option value="openai">OpenAI (GPT)</option>
              <option value="openrouter">OpenRouter (含 Kimi)</option>
              <option value="gemini">Google Gemini</option>
              <option value="custom">自定义端点</option>
            </select>
          </div>
          <div>
            <Text>模型</Text>
            {apiProvider === 'openrouter' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {openRouterModels.length > 0 ? (
                  <div ref={modelDropdownRef} style={{ position: 'relative' }}>
                    <input
                      type="text"
                      value={modelDropdownOpen ? modelSearchQuery : model}
                      onFocus={() => {
                        setModelDropdownOpen(true)
                        setModelSearchQuery(model)
                      }}
                      onBlur={() => {
                        setTimeout(() => {
                          setModelDropdownOpen(false)
                          setModelSearchQuery(model)
                        }, 150)
                      }}
                      onInput={(e) => {
                        const v = (e.target as HTMLInputElement).value
                        setModelSearchQuery(v)
                      }}
                      placeholder="输入关键词搜索模型，如 kimi、gpt-4"
                      style={{
                        width: '100%',
                        padding: 8,
                        borderRadius: 6,
                        border: '1px solid var(--figma-color-border)',
                        boxSizing: 'border-box'
                      }}
                    />
                    {modelDropdownOpen && (
                      <div
                        style={{
                          position: 'absolute',
                          left: 0,
                          right: 0,
                          top: '100%',
                          marginTop: 4,
                          maxHeight: 200,
                          overflow: 'auto',
                          background: 'var(--figma-color-bg)',
                          border: '1px solid var(--figma-color-border)',
                          borderRadius: 6,
                          zIndex: 10,
                          boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
                        }}
                      >
                        {filteredOpenRouterModels.length === 0 ? (
                          <div style={{ padding: 12, color: 'var(--figma-color-text-tertiary)', fontSize: 12 }}>
                            无匹配模型
                          </div>
                        ) : (
                          filteredOpenRouterModels.slice(0, 100).map((m) => (
                            <div
                              key={m.id}
                              role="option"
                              onMouseDown={(e) => {
                                e.preventDefault()
                                setModel(m.id)
                                setModelSearchQuery(m.id)
                                setModelDropdownOpen(false)
                              }}
                              style={{
                                padding: '8px 12px',
                                cursor: 'pointer',
                                fontSize: 12,
                                borderBottom: '1px solid var(--figma-color-border)',
                                background: m.id === model ? 'var(--figma-color-bg-selected)' : undefined
                              }}
                            >
                              <div style={{ fontWeight: 500 }}>{m.id}</div>
                              {m.name !== m.id && (
                                <div style={{ color: 'var(--figma-color-text-tertiary)', fontSize: 11 }}>{m.name}</div>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <input
                      type="text"
                      value={model}
                      onInput={(e) => setModel((e.target as HTMLInputElement).value)}
                      placeholder="moonshotai/kimi-k2-thinking 或 openai/gpt-4o"
                      style={{
                        width: '100%',
                        padding: 8,
                        borderRadius: 6,
                        border: '1px solid var(--figma-color-border)',
                        boxSizing: 'border-box'
                      }}
                    />
                    <Button onClick={handleFetchOpenRouterModels} disabled={openRouterModelsLoading || !apiKey.trim()}>
                      {openRouterModelsLoading ? (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <LoadingIndicator />
                          加载中...
                        </span>
                      ) : (
                        '从 OpenRouter 加载模型列表'
                      )}
                    </Button>
                    {openRouterModelsError && (
                      <Text style={{ color: 'var(--figma-color-text-danger)', fontSize: 11 }}>
                        {openRouterModelsError}
                      </Text>
                    )}
                  </div>
                )}
                {openRouterModels.length > 0 && (
                  <Button
                    secondary
                    onClick={() => {
                      setOpenRouterModels([])
                      setOpenRouterModelsError(null)
                    }}
                  >
                    重新加载模型列表
                  </Button>
                )}
              </div>
            ) : (
              <input
                type="text"
                value={model}
                onInput={(e) => setModel((e.target as HTMLInputElement).value)}
                placeholder={apiProvider === 'gemini' ? 'gemini-2.0-flash' : 'gpt-4o-mini'}
                style={{
                  width: '100%',
                  padding: 8,
                  borderRadius: 6,
                  border: '1px solid var(--figma-color-border)',
                  boxSizing: 'border-box'
                }}
              />
            )}
          </div>
          {apiProvider === 'custom' && (
            <div>
              <Text>API 端点</Text>
              <input
                type="text"
                value={baseUrl}
                onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)}
                placeholder="https://api.example.com/v1"
                style={{
                  width: '100%',
                  padding: 8,
                  borderRadius: 6,
                  border: '1px solid var(--figma-color-border)'
                }}
              />
            </div>
          )}
          <Button onClick={handleSaveSettings}>保存设置</Button>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Button
              secondary
              onClick={handleTestModel}
              disabled={testModelLoading || !apiKey.trim()}
            >
              {testModelLoading ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <LoadingIndicator />
                  测试中...
                </span>
              ) : (
                '测试模型'
              )}
            </Button>
            {testModelResult && (
              <div
                style={{
                  fontSize: 12,
                  padding: 8,
                  borderRadius: 6,
                  background: testModelResult.success
                    ? 'var(--figma-color-bg-success-tertiary)'
                    : 'var(--figma-color-bg-danger-tertiary)',
                  color: testModelResult.success
                    ? 'var(--figma-color-text-success)'
                    : 'var(--figma-color-text-danger)'
                }}
              >
                {testModelResult.success ? '连接成功，模型可用' : testModelResult.error}
              </div>
            )}
          </div>
        </div>
      </Disclosure>
    </div>
  )
}

function App (props: { editMermaidCode?: string }) {
  return <Plugin editMermaidCode={props?.editMermaidCode} />
}

export default render(App)
