export {}

declare global {
  interface Window {
    assistantRuntime?: {
      apiBaseUrl: string
      platform: string
    }
  }
}
