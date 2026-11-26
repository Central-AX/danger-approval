import { expect, test } from 'claude-code/testing'

import { classify } from './register'

const BAND = {
  plugin: 'danger-approval',
  component: 'AbovePrompt',
  surface: 'desktop',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: true,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('危険な操作だけを拾う', () => {
  expect(classify('Bash', { command: 'rm -rf build' })?.label).toBe('削除')
  expect(classify('PowerShell', { command: 'Remove-Item x -Recurse' })?.label).toBe('削除')
  expect(classify('Bash', { command: 'git reset --hard HEAD~1' })?.label).toBe('gitの取り消せない操作')
  expect(classify('mcp__abc__send_message', {})?.label).toBe('外部への送信')
  expect(classify('mcp__abc__share_file', {})?.label).toBe('共有設定の変更')
  expect(classify('mcp__freee__freee_api_post', {})?.label).toBe('freeeへの書き込み')
  expect(classify('mcp__abc__trash_file', {})?.label).toBe('削除')

  expect(classify('Bash', { command: 'git status' })).toBe(null)
  // ふつうの git push は赤くしない（2026-11-26 松浦）
  expect(classify('Bash', { command: 'git push origin main' })).toBe(null)
  expect(classify('Bash', { command: 'git commit -m x && git push -u origin b' })).toBe(null)
  // GitHubへの反映（マージ・push系）も赤くしない（2026-11-26 松浦）
  expect(classify('Bash', { command: 'gh pr merge 1 --squash' })).toBe(null)
  expect(classify('Bash', { command: 'git push --force origin main' })).toBe(null)
  expect(classify('mcp__github__merge_pull_request', {})).toBe(null)
  expect(classify('mcp__github__push_files', {})).toBe(null)
  expect(classify('mcp__github__create_or_update_file', {})).toBe(null)
  expect(classify('Bash', { command: 'gh repo delete x/y' })?.label).toBe('GitHubの削除')
  expect(classify('mcp__github__delete_file', {})?.label).toBe('削除')
  expect(classify('Bash', { command: 'npm run format' })).toBe(null)
  expect(classify('mcp__freee__freee_api_get', {})).toBe(null)
  expect(classify('mcp__abc__search_files', {})).toBe(null)
  expect(classify('Edit', { file_path: 'a.md' })).toBe(null)

  // 長いパスはファイル名だけに縮める
  expect(classify('Bash', { command: 'rm "/c/Users/someone/AppData/Local/Temp/x/test.txt"' })?.detail).toBe(
    'rm "…/test.txt"',
  )
})

test('承認なしで通った危険な操作は、あとから赤くしない', async ($, on) => {
  const toasts: string[] = []

  on('tool.run', () => ({ result: {} }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.tool.run({ tool: 'Bash', tool_use_id: 't2', command: 'rm -rf build' })
  expect(toasts.length).toBe(0)

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /⚠/ })).toBe(undefined)
  await ui.unmount()
})

test('選択肢で質問してきたときは、ダイアログの上に赤い帯が出る', async $ => {
  const ui = await $.ui.mount({
    plugin: 'danger-approval',
    component: 'AskUserQuestion',
    surface: 'desktop',
    props: { tool: 'AskUserQuestion', questions: [] },
  })
  expect((await ui.find({ type: 'Text', text: /^⚠ 確認が必要です/ }))?.text).toBe(
    '⚠ 確認が必要です：選んで答えてください',
  )
  await ui.unmount()
})

test('危険な承認のときだけ赤い帯が出て、通知が飛ぶ', async ($, on) => {
  const notified: string[] = []

  on('classic.PermissionRequest', () => ({}))
  on('ui.notify', (_, e) => {
    notified.push(`${e.title}|${e.text}`)

    return { value: { isSent: true, channel: 'client' } }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  // ふつうの承認：帯は出ない
  await $.classic.PermissionRequest({
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  })

  let ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /危険な承認/ })).toBe(undefined)
  await ui.unmount()
  expect(notified.length).toBe(0)

  // 危険な承認：帯と通知
  await $.classic.PermissionRequest({
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf build' },
  })

  ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /^⚠ 危険な承認：削除$/ }))?.text).toBe(
    '⚠ 危険な承認：削除',
  )
  await ui.unmount()
  expect(notified).toEqual(['⚠ 危険な承認|削除：rm -rf build'])
})

test('人に承認を求める判定になった危険な操作は、その時点で赤い帯と通知が出る', async ($, on) => {
  const notified: string[] = []

  on('tool.check', () => ({ decision: 'ask' }))
  on('ui.notify', (_, e) => {
    notified.push(`${e.title}|${e.text}`)

    return { value: { isSent: true, channel: 'client' } }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  await $.tool.check({
    tool: 'Bash',
    input: { command: 'git reset --hard HEAD~1' },
    tool_use_id: 'c1',
    approver: 'person',
  })

  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /^⚠ 危険な承認：gitの取り消せない操作$/ }))?.text).toBe(
    '⚠ 危険な承認：gitの取り消せない操作',
  )
  await ui.unmount()
  expect(notified).toEqual(['⚠ 危険な承認|gitの取り消せない操作：git reset --hard HEAD~1'])
})
