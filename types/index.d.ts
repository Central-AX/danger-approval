export type Danger = {
  /** 危険の種類（削除・外部送信 など） */
  label: string
  /** 何をしようとしているか（コマンドやツール名の先頭） */
  detail: string
  /** 対象の呼び出し。分からないときは undefined */
  id?: string
}

declare module 'claude-code' {
  interface PluginState {
    'danger-approval': {
      /** いま承認待ちの危険な操作 */
      pending: Danger | null
    }
  }
}
