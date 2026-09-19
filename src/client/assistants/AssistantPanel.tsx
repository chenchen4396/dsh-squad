import { useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AssistantView, CatalogView } from '../../transport/contracts.js'
import css from '../AgentTeam.module.css'
import { AnimatedModal, Empty } from '../shared.js'
import { AssistantBuilderConversation } from './AssistantBuilder.js'
import { AssistantCard } from './AssistantCard.js'
import { AssistantForm } from './AssistantForm.js'

const ASSISTANT_FORM_ID = 'agent-team-assistant-form'
const ASSISTANT_EDIT_FORM_ID = 'agent-team-assistant-edit-form'

export function AssistantPanel({
  catalog,
  assistants,
  onChanged,
}: {
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  onChanged: () => Promise<void>
}): JSX.Element {
  const [creating, setCreating] = useState(false)
  const [editingAssistant, setEditingAssistant] = useState<AssistantView>()
  const [builderOpen, setBuilderOpen] = useState(false)
  const [assistantSaving, setAssistantSaving] = useState(false)
  return (
    <section className={css.section}>
      <div className={css.sectionHeader}>
        <div>
          <h2 className={css.sectionHeading}>助手模板 <span className={css.count}>{assistants.length}</span></h2>
          <p className={css.sectionDescription}>助手是可复用模板，解散团队不会删除助手。</p>
        </div>
        <div className={css.sectionHeaderActions}>
          <Button variant="primary" onClick={() => { setCreating(true) }}>手动新建</Button>
        </div>
      </div>
      <article className={css.assistantBuilderCard}>
        <div className={css.assistantBuilderAvatar} aria-hidden="true">AI</div>
        <div className={css.assistantBuilderCopy}>
          <span className={css.assistantBuilderEyebrow}>内置 · 默认</span>
          <strong>团队 Agent 小助手</strong>
          <p>描述你需要的角色，它会询问必要参数、整理长期提示词，并在确认后创建助手。</p>
        </div>
        <Button variant="primary" onClick={() => { setBuilderOpen(true) }}>开始对话</Button>
      </article>
      {assistants.length === 0
        ? <Empty text="还没有助手模板" hint="创建助手后，就可以把它作为 Leader 或普通成员加入不同团队。" />
        : (
            <div className={css.cardGrid}>
              {assistants.map(assistant => (
                <AssistantCard
                  key={assistant.id}
                  assistant={assistant}
                  onEdit={() => { setEditingAssistant(assistant) }}
                  onChanged={onChanged}
                />
              ))}
            </div>
          )}
      <AnimatedModal
        open={builderOpen}
        onClose={() => { setBuilderOpen(false) }}
        title="团队 Agent 小助手"
        closeLabel="关闭"
        description="通过对话设计助手，完整配置会在你确认后保存到助手模板库。"
        className={css.assistantBuilderDialog ?? ''}
        contentClassName={css.assistantBuilderDialogContent ?? ''}
      >
        {builderOpen && <AssistantBuilderConversation catalog={catalog} />}
      </AnimatedModal>
      <AnimatedModal
        open={creating}
        onClose={() => { setCreating(false) }}
        title="新建助手"
        closeLabel="关闭"
        description="配置可复用的模型、权限与长期规则。具体任务在团队启动后发送。"
        className={css.assistantDialog ?? ''}
        contentClassName={css.modalScrollContent ?? ''}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setCreating(false) }} disabled={assistantSaving}>取消</Button>
            <Button
              variant="primary"
              type="submit"
              form={ASSISTANT_FORM_ID}
              disabled={assistantSaving}
            >
              {assistantSaving ? '保存中…' : '保存助手'}
            </Button>
          </>
        )}
      >
        <AssistantForm
          catalog={catalog}
          formId={ASSISTANT_FORM_ID}
          saving={assistantSaving}
          setSaving={setAssistantSaving}
          onSaved={async () => { setCreating(false); await onChanged() }}
        />
      </AnimatedModal>
      <AnimatedModal
        open={editingAssistant !== undefined}
        onClose={() => { setEditingAssistant(undefined) }}
        title="编辑助手"
        closeLabel="关闭"
        description="更新助手模板只影响之后启动的团队成员，不修改已有成员快照。"
        className={css.assistantDialog ?? ''}
        contentClassName={css.modalScrollContent ?? ''}
        footer={editingAssistant === undefined
          ? undefined
          : (
              <>
                <Button variant="outline" onClick={() => { setEditingAssistant(undefined) }} disabled={assistantSaving}>取消</Button>
                <Button
                  variant="primary"
                  type="submit"
                  form={ASSISTANT_EDIT_FORM_ID}
                  disabled={assistantSaving}
                >
                  {assistantSaving ? '保存中…' : '保存修改'}
                </Button>
              </>
            )}
      >
        {editingAssistant !== undefined && (
          <AssistantForm
            key={`${editingAssistant.id}:${editingAssistant.revision}`}
            catalog={catalog}
            formId={ASSISTANT_EDIT_FORM_ID}
            assistant={editingAssistant}
            saving={assistantSaving}
            setSaving={setAssistantSaving}
            onSaved={async () => { setEditingAssistant(undefined); await onChanged() }}
          />
        )}
      </AnimatedModal>
    </section>
  )
}

