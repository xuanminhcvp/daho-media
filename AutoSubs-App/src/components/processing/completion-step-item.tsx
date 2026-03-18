import { Button } from "@/components/ui/button"
import {
    Item,
    ItemContent,
    ItemDescription,
    ItemFooter,
    ItemTitle,
} from "@/components/ui/item"
import { Download, Plus, FileText } from "lucide-react"
import { AddToTimelineDialog } from "@/components/dialogs/add-to-timeline-dialog"
import { Settings, TimelineInfo } from "@/types/interfaces"
import { useTranslation } from "react-i18next"

export interface CompletionStepProps {
    onExportToFile: () => void;
    /** Callback tải file word-level timestamps (Whisper Words) */
    onExportWhisperWords: () => void;
    onAddToTimeline: (selectedOutputTrack: string, selectedTemplate: string) => Promise<void>;
    settings: Settings;
    timelineInfo: TimelineInfo;
}

export function CompletionStepItem({
    onExportToFile,
    onExportWhisperWords,
    onAddToTimeline,
    settings,
    timelineInfo
}: CompletionStepProps) {
    const { t } = useTranslation()

    return (
        <div className="flex w-full flex-col gap-2">
            <Item variant="default" className="bg-muted/30 border-muted-foreground/20">
                <ItemContent className="px-2">
                    <ItemTitle>
                        {t("completion.processingComplete")}
                    </ItemTitle>
                    <ItemDescription>
                        {t("completion.subtitlesReady")}
                    </ItemDescription>
                </ItemContent>
                <ItemFooter>
                    <div className="flex gap-2 flex-wrap">
                        {/* Nút export SRT */}
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={onExportToFile}
                            className="flex items-center gap-2"
                        >
                            <Download className="h-3 w-3" />
                            {t("completion.exportToFile")}
                        </Button>
                        {/* Nút tải Whisper Words (word-level timestamps) */}
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={onExportWhisperWords}
                            className="flex items-center gap-2"
                            title="Tải file word-level timestamps từ Whisper"
                        >
                            <FileText className="h-3 w-3" />
                            Whisper Words
                        </Button>
                        {/* Nút thêm vào Timeline DaVinci */}
                        <AddToTimelineDialog
                            settings={settings}
                            timelineInfo={timelineInfo}
                            onAddToTimeline={onAddToTimeline}
                        >
                            <Button
                                variant="outline"
                                size="sm"
                                className="flex items-center gap-2"
                            >
                                <Plus className="h-3 w-3" />
                                {t("completion.addToTimeline")}
                            </Button>
                        </AddToTimelineDialog>
                    </div>
                </ItemFooter>
            </Item>
        </div>
    )
}
