import { Tabs, TabsList, TabsTrigger } from "@/components/ui/animated-tabs"
import { useTranslation } from "react-i18next"
import { Model } from "@/types/interfaces"
import * as React from "react"
import { UploadIcon, type UploadIconHandle } from "@/components/ui/icons/upload"
import { ModelPicker } from "@/components/settings/model-picker"


export function WorkspaceHeader({
  modelsState,
  selectedModelIndex,
  selectedLanguage,
  onSelectModel,
  downloadingModel,
  downloadProgress,
  openModelSelector,
  onOpenModelSelectorChange,
  isSmallScreen,
  isStandaloneMode,
  onStandaloneModeChange,
}: {
  modelsState: Model[]
  selectedModelIndex: number
  selectedLanguage: string
  onSelectModel: (modelIndex: number) => void
  downloadingModel: string | null
  downloadProgress: number
  openModelSelector: boolean
  onOpenModelSelectorChange: (open: boolean) => void
  isSmallScreen: boolean
  isStandaloneMode: boolean
  onStandaloneModeChange: (standalone: boolean) => void
}) {
  const { t } = useTranslation()
  const uploadIconRef = React.useRef<UploadIconHandle>(null)

  return (
    <div className="sticky top-0 z-10 flex items-center justify-between p-4 pb-3 bg-transparent">
      {/* Left side: Model Management */}
      <div className="flex items-center gap-2">
        {/* Model Selector */}
        <ModelPicker
          modelsState={modelsState}
          selectedModelIndex={selectedModelIndex}
          selectedLanguage={selectedLanguage}
          onSelectModel={onSelectModel}
          downloadingModel={downloadingModel}
          downloadProgress={downloadProgress}
          open={openModelSelector}
          onOpenChange={onOpenModelSelectorChange}
          isSmallScreen={isSmallScreen}
        />
      </div>

        {/* Right side: File/Timeline Mode Tabs */}
        <Tabs
          value={isStandaloneMode ? "file" : "timeline"}
          onValueChange={(value) => onStandaloneModeChange(value === "file")}
        >
          <TabsList className="p-1 h-auto">
            <TabsTrigger
              value="file"
              className="text-sm"
              onMouseEnter={() => uploadIconRef.current?.startAnimation()}
              onMouseLeave={() => uploadIconRef.current?.stopAnimation()}
            >
              <UploadIcon ref={uploadIconRef} size={14} />
              {t("actionBar.mode.fileInput")}
            </TabsTrigger>
            <TabsTrigger
              value="timeline"
              className="text-sm px-4"
            >
              <img
                src="/davinci-resolve-logo.png"
                alt={t("titlebar.resolve.productName")}
                className="w-5 h-5"
              />
              {t("actionBar.mode.timeline")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
  )
}
