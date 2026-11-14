import SwiftUI
import WidgetKit
import AIPetCore

struct PreviewEntry: TimelineEntry {
    let date: Date
    let hasPreview: Bool
}
struct PreviewProvider: TimelineProvider {
    func placeholder(in context: Context) -> PreviewEntry { PreviewEntry(date: Date(), hasPreview: false) }
    func getSnapshot(in context: Context, completion: @escaping (PreviewEntry) -> Void) {
        completion(PreviewEntry(date: Date(), hasPreview: !context.isPreview && DevelopmentWidgetBridge.readPreview() != nil))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<PreviewEntry>) -> Void) {
        let now = Date()
        let snapshot = DevelopmentWidgetBridge.readPreview()
        let entry = PreviewEntry(date: now, hasPreview: snapshot != nil)
        // Explicit unavailable entry bounds display of the synthetic cached preview.
        let expires = snapshot?.updatedAt.addingTimeInterval(900) ?? now.addingTimeInterval(900)
        completion(Timeline(entries: [entry, PreviewEntry(date: expires, hasPreview: false)], policy: .never))
    }
}

@main struct AIPetDevelopmentWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: DevelopmentWidgetBridge.kind, provider: PreviewProvider()) { entry in
            VStack(alignment: .leading) {
                Label("AI Pet · Development", systemImage: "sparkles")
                Text(entry.hasPreview ? "Synthetic preview ready" : "Preview unavailable")
                Text("Open offline app").font(.caption)
            }
            .containerBackground(.fill.tertiary, for: .widget)
            .widgetURL(WidgetLink.preview)
            .privacySensitive()
        }
        .configurationDisplayName("AI Pet Development")
        .description("Offline synthetic preview. No microphone or service access.")
        .supportedFamilies([.systemSmall])
    }
}
