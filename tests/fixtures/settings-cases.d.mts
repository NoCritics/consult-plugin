export type SettingsCase = {
  name: string
  text: string
  expect: {
    raw: Record<string, string | number | boolean | null>
    notifyAfterS: number
    historySize: number
    summaryModel: 'haiku' | null
    warnings?: string[]
    runner?: string | null
  }
}
export declare const SETTINGS_CASES: SettingsCase[]
