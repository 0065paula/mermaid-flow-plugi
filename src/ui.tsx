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
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    fallbackTimerRef.current = setTimeout(() => {
      setLoading((prev) => {
        if (prev) {
          setError('超过 2 分钟未响应，请检查网络和 API Key 后重试')
          return false
        }
        return prev
      })
      fallbackTimerRef.current = null
    }, 120000)
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
            <input
              type="text"
              value={model}
              onInput={(e) => setModel((e.target as HTMLInputElement).value)}
              placeholder={apiProvider === 'openrouter' ? 'moonshotai/kimi-k2-thinking 或 openai/gpt-4o' : 'gpt-4o-mini'}
              style={{
                width: '100%',
                padding: 8,
                borderRadius: 6,
                border: '1px solid var(--figma-color-border)'
              }}
            />
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
        </div>
      </Disclosure>
    </div>
  )
}

function App (props: { editMermaidCode?: string }) {
  return <Plugin editMermaidCode={props?.editMermaidCode} />
}

export default render(App)
