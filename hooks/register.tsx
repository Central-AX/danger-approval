import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Danger } from '../types'

const pending = atom(
  { plugin: 'danger-approval', key: 'pending' } as const,
  null,
)
const auto = atom({ plugin: 'danger-approval', key: 'auto' } as const, [])


// ── 危険の判定 ────────────────────────────────────────────
// 足し引きはこの2つの表を直す。上から順に見て、最初に当たったものを使う。

/** シェル（Bash / PowerShell）のコマンドに対する判定 */
const COMMAND_RULES: readonly (readonly [RegExp, string])[] = [
  [/\bgit\s+push\b[^\n]*(--force|-f\b)/i, '強制push'],
  [/\bgit\s+(reset\s+--hard|clean\s+-|branch\s+-D|checkout\s+--\s)/i, 'gitの取り消せない操作'],
  [/\bgit\s+push\b/i, 'git push'],
  [/\bgh\s+(pr\s+merge|repo\s+delete|release\s+delete)\b/i, 'GitHubのマージ・削除'],
  [/(^|[\s;&|(])(rm|rmdir|del|rd)\s/i, '削除'],
  [/\b(Remove-Item|Clear-Content|Clear-RecycleBin|Format-Volume)\b/i, '削除'],
  [/\b(wrangler\s+(deploy|publish)|vercel\b[^\n]*--prod|npm\s+run\s+deploy|clasp\s+(push|deploy))\b/i, '本番への反映'],
  [/\b(DROP\s+(TABLE|DATABASE)|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i, 'データの削除'],
  [/\b(shutdown|Stop-Computer|Restart-Computer|reg\s+delete)\b/i, 'PC本体への操作'],
]

/** MCPツールなど、ツール名（最後の `__` より後ろ）に対する判定 */
const TOOL_RULES: readonly (readonly [RegExp, string])[] = [
  [/^freee_api_(post|put|patch|delete|bulk_write)$/i, 'freeeへの書き込み'],
  [/(^|_)(delete|trash|remove)(_|$)|^Delete[A-Z]/, '削除'],
  [/send_message$|^slack_schedule_message$|^reply$|^forward$|chatwork.*(send|post)|post_message/i, '外部への送信'],
  [/^share_file$|^Share[A-Z]|share_connector|share_live_queries/, '共有設定の変更'],
  [/^merge_pull_request$|^push_files$|^create_or_update_file$/, 'GitHubへの反映'],
  [/^buy_domain$|^create_or_transfer_domain$/, '購入'],
  [/^(request_promote|request_rollback|create_deployment)$/, '本番への反映'],
]

const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

/** 人に承認を求めない許可モード */
const SILENT_MODES = new Set(['auto', 'bypassPermissions', 'dontAsk'])

// 長いパスは末尾のファイル名だけにする（帯が1行に収まるように）
const shortenPaths = (text: string) =>
  text.replace(
    /(?:[A-Za-z]:)?[\\/](?:[^\s"'\\/]+[\\/]){2,}([^\s"'\\/]+)/g,
    '…/$1',
  )

const clip = (text: string, max = 60) => {
  const line = shortenPaths(text).replace(/\s+/g, ' ').trim()

  return line.length > max ? `${line.slice(0, max)}…` : line
}

const commandOf = (input: unknown) => {
  if (typeof input !== 'object' || input === null) {
    return ''
  }

  const command = (input as { command?: unknown }).command

  return typeof command === 'string' ? command : ''
}

export const classify = (tool: string, input: unknown): Danger | null => {
  if (SHELL_TOOLS.has(tool)) {
    const command = commandOf(input)
    const hit = COMMAND_RULES.find(([pattern]) => pattern.test(command))

    return hit ? { label: hit[1], detail: clip(command) } : null
  }

  const name = tool.split('__').pop() ?? tool
  const hit = TOOL_RULES.find(([pattern]) => pattern.test(name))

  return hit ? { label: hit[1], detail: name } : null
}

const keyOf = (tool: string, input: unknown) => {
  try {
    return `${tool}\n${JSON.stringify(input)}`
  } catch {
    return tool
  }
}

// ── フック ────────────────────────────────────────────────

export const register: Register = on => {
  // 危険な呼び出しの id を控えておく（承認ダイアログの下に1行出すため）
  const ids = new Map<string, string>()

  // 承認ダイアログを経た呼び出し（自動実行と区別するため）
  const asked = new Set<string>()

  // いまの許可モード。人に聞かないモードでは、承認待ちの帯と通知を出さない。
  let mode: string | undefined

  on('classic.UserPromptSubmit', ($, e, next) => {
    mode = e.permission_mode

    return next(e)
  })

  // 自動モードの判定役に回った呼び出しは、人への承認ではない
  on('tool.judge', async ($, e, next) => {
    mode = 'auto'

    const now = await read($, pending)

    if (now !== null && now.id === e.tool_use_id) {
      asked.delete(e.tool_use_id)
      await update($, pending, () => null)
    }

    return next(e)
  })

  // 判定には手を出さず、「人に承認を求める」結果になった危険な操作を目立たせる
  on('tool.check', async ($, e, next) => {
    const danger = classify(e.tool, e.input)
    const verdict = await next(e)
    const id = e.tool_use_id

    if (danger === null || id === undefined) {
      return verdict
    }

    ids.set(keyOf(e.tool, e.input), id)

    const isPersonAsked =
      verdict.decision === 'ask' &&
      e.approver === 'person' &&
      !SILENT_MODES.has(mode ?? '')

    if (isPersonAsked && !asked.has(id)) {
      asked.add(id)
      await update($, pending, () => ({ ...danger, id }))
      void $.ui
        .notify(`${danger.label}：${danger.detail}`, {
          title: '⚠ 危険な承認',
          key: 'danger-approval',
        })
        .catch(() => undefined)
    }

    return verdict
  })

  // 承認ダイアログが出る瞬間を直接聞ける環境では、こちらでも拾う（二重には出さない）
  on('classic.PermissionRequest', async ($, e, next) => {
    const danger = classify(e.tool_name, e.tool_input)

    if (danger !== null) {
      const id = ids.get(keyOf(e.tool_name, e.tool_input))
      const isNew = id === undefined || !asked.has(id)

      if (id !== undefined) {
        asked.add(id)

        try {
          $.ui.notice(id, `⚠ 危険な操作（${danger.label}）です。内容を読んでから許可してください。`)
        } catch {
          // ダイアログがまだ開いていない surface では出せない。帯と通知で足りる。
        }
      }

      if (isNew) {
        await update($, pending, () => ({ ...danger, id }))
        void $.ui
          .notify(`${danger.label}：${danger.detail}`, {
            title: '⚠ 危険な承認',
            key: 'danger-approval',
          })
          .catch(() => undefined)
      }
    }

    return next(e)
  })

  // 許可されて実行に入った／拒否された／ターンが終わった、で帯を消す
  on('tool.run', async ($, e, next) => {
    const now = await read($, pending)

    if (now !== null && (now.id === undefined || now.id === e.tool_use_id)) {
      await update($, pending, () => null)
    }

    // 承認を求められずに通った危険な操作は、実行したことを赤で残す
    const danger = classify(e.tool, e)
    const wasAsked =
      now !== null || (e.tool_use_id !== undefined && asked.has(e.tool_use_id))

    if (danger !== null && !wasAsked) {
      await update($, auto, list => [...list, danger].slice(-20))
      $.ui.toast(`⚠ 危険な操作を自動で実行：${danger.label}　${danger.detail}`, {
        timeoutMs: 10000,
      })
    }

    return next(e)
  })

  on('classic.PermissionDenied', async ($, e, next) => {
    if ((await read($, pending)) !== null) {
      await update($, pending, () => null)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if ((await read($, pending)) !== null) {
      await update($, pending, () => null)
    }
    ids.clear()
    asked.clear()

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if ((await read($, auto)).length > 0) {
      await update($, auto, () => [])
    }

    if ((await read($, pending)) !== null) {
      await update($, pending, () => null)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const danger = await read($, pending)
    const ran = await read($, auto)

    if (e.props.hasSurvey || (danger === null && ran.length === 0)) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    if (danger === null) {
      const latest = ran[ran.length - 1]

      return (
        <Box backgroundColor="#7f1d1d" paddingX={1}>
          <Text color="#ffffff">
            <Text color="#ffffff" bold>
              ⚠ 自動で実行された危険な操作 {ran.length}件
            </Text>
            {` ｜ 最新：${latest?.label ?? ''} ｜ ${latest?.detail ?? ''}`}
          </Text>
        </Box>
      )
    }

    return (
      <Box backgroundColor="#b91c1c" paddingX={1}>
        <Text color="#ffffff">
          <Text color="#ffffff" bold>
            ⚠ 危険な承認：{danger.label}
          </Text>
          {` ｜ ${danger.detail}`}
        </Text>
      </Box>
    )
  })
}
