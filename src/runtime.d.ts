export {}

declare global {
  type AssistantNetworkExposure = {
    openToLan: boolean
    openToWan: boolean
    localUrl: string
    lanUrls: string[]
    wanUrlHint: string
    remoteUiAvailable: boolean
  }

  interface Window {
    assistantRuntime?: {
      apiBaseUrl: string
      getNetworkExposure?: () => Promise<AssistantNetworkExposure>
      platform: string
      setNetworkExposure?: (value: {
        openToLan: boolean
        openToWan: boolean
      }) => Promise<AssistantNetworkExposure>
    }
  }
}
