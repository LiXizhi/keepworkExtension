import SwiftUI
import WidgetKit
import AIPetCore

struct PreviewEntry: TimelineEntry {
    let date: Date
    let hasPreview: Bool
    let locale: PetLocale
}
struct PreviewProvider: TimelineProvider {
    func placeholder(in context: Context) -> PreviewEntry { PreviewEntry(date: Date(), hasPreview: false, locale: .system(Locale.preferredLanguages)) }
    func getSnapshot(in context: Context, completion: @escaping (PreviewEntry) -> Void) {
        let snapshot = context.isPreview ? nil : DevelopmentWidgetBridge.readPreview()
        completion(PreviewEntry(date: Date(), hasPreview: snapshot != nil, locale: WidgetLanguage.resolve(authorizedSnapshot: snapshot, system: Locale.preferredLanguages, now: Date())))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<PreviewEntry>) -> Void) {
        let now = Date()
        let snapshot = DevelopmentWidgetBridge.readPreview()
        let entry = PreviewEntry(date: now, hasPreview: snapshot != nil, locale: WidgetLanguage.resolve(authorizedSnapshot: snapshot, system: Locale.preferredLanguages, now: now))
        // Explicit unavailable entry bounds display of the synthetic cached preview.
        let expires = snapshot?.updatedAt.addingTimeInterval(900) ?? now.addingTimeInterval(900)
        completion(Timeline(entries: [entry, PreviewEntry(date: expires, hasPreview: false, locale: .system(Locale.preferredLanguages))], policy: .never))
    }
}

@main struct AIPetDevelopmentWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: DevelopmentWidgetBridge.kind, provider: PreviewProvider()) { entry in
            VStack(alignment: .leading) {
                DeveloperPetView(pose: .idle, mouth: 0, locale: entry.locale).frame(height: 44)
                Text(DevelopmentCopy.text(entry.hasPreview ? .widgetReady : .widgetUnavailable, entry.locale))
                Text(DevelopmentCopy.text(.widgetOpen, entry.locale)).font(.caption)
            }
            .containerBackground(.fill.tertiary, for: .widget)
            .widgetURL(WidgetLink.preview)
            .privacySensitive()
        }
        .configurationDisplayName(Text(DevelopmentCopy.text(.title, .system(Locale.preferredLanguages))))
        .description(Text(DevelopmentCopy.text(.widgetDescription, .system(Locale.preferredLanguages))))
        .supportedFamilies([.systemSmall])
    }
}
