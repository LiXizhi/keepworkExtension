import SwiftUI
import AIPetCore
import WidgetKit

/// Offline shell: contains no audio implementation, service client, or credentials.
@main
struct AIPetDevelopmentApp: App {
    var body: some Scene {
        WindowGroup { DevelopmentView() }
    }
}

struct DevelopmentView: View {
    @AppStorage(LanguagePreference.key) private var localeID = ""
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visible = false
    @State private var pose: DemoPose = .idle
    @State private var mouth = 0.35
    private var locale: PetLocale { LanguagePreference.resolve(localeID, system: Locale.preferredLanguages) }
    private func copy(_ key: CopyKey) -> String { DevelopmentCopy.text(key, locale) }
    @State private var snapshotStore: WidgetSnapshotStore?
    @State private var widgetStatus: CopyKey = .sharingUnavailable
    private let context = ConversationContext(accountID: "dev-account", homeRegion: "dev-region", personaID: "dev-persona", conversationID: "dev-conversation")

    private func prepareWidget() {
        guard snapshotStore == nil, let directory = DevelopmentWidgetBridge.directory() else { return }
        do {
            let store = WidgetSnapshotStore(storage: try FileWidgetStorage(directory: directory))
            snapshotStore = store
            widgetStatus = store.lastStorageError == nil ? .sharingReady : .cleanupFailed
            WidgetCenter.shared.reloadTimelines(ofKind: DevelopmentWidgetBridge.kind)
        } catch { widgetStatus = .storageUnavailable }
    }

    private func publishPreview() {
        guard let store = snapshotStore else { return }
        store.select(context)
        let value = WidgetSnapshot(personaID: "dev-persona", appearanceID: "dev-shape", conversationID: "dev-conversation", locale: locale, updatedAt: Date())
        widgetStatus = store.publish(value, scopeToken: store.scopeToken) ? .saved : .writeFailed
        WidgetCenter.shared.reloadTimelines(ofKind: DevelopmentWidgetBridge.kind)
    }

    private func clearPreview() {
        snapshotStore?.signOut()
        widgetStatus = snapshotStore?.lastStorageError == nil ? .cleared : .removalFailed
        WidgetCenter.shared.reloadTimelines(ofKind: DevelopmentWidgetBridge.kind)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section(copy(.offline)) {
                    Text("AI Pet \(Development.version)")
                    Text(copy(.offlineDetail))
                }
                Section(copy(.language)) {
                    Picker(copy(.language), selection: Binding(get: { locale }, set: { localeID = $0.rawValue })) {
                        ForEach(PetLocale.allCases, id: \.self) { Text($0.nativeName).tag($0) }
                    }.accessibilityIdentifier("language-picker")
                    Text(copy(.languageNote))
                }
                Section(copy(.pet)) {
                    DeveloperPetView(pose: pose, mouth: DemoPresentation.mouthOpening(mouth, pose: pose, sceneActive: scenePhase == .active, reduceMotion: reduceMotion, visible: visible), locale: locale)
                        .frame(height: 160)
                        .animation(DemoPresentation.allowsMotion(reduceMotion: reduceMotion, sceneActive: scenePhase == .active, visible: visible) ? .easeInOut(duration: 0.18) : nil, value: pose)
                    Text(copy(.petNote))
                    Picker(copy(.pose), selection: $pose) {
                        ForEach(DemoPose.allCases, id: \.self) { Text(copy($0.labelKey)).tag($0) }
                    }.accessibilityIdentifier("pose-picker")
                    Slider(value: $mouth, in: 0...1) { Text(copy(.mouth)) }
                        .disabled(pose != .speaking || !DemoPresentation.allowsMotion(reduceMotion: reduceMotion, sceneActive: scenePhase == .active, visible: visible))
                        .accessibilityLabel(copy(.mouth))
                        .accessibilityValue(mouth.formatted(.percent.precision(.fractionLength(0))))
                    if reduceMotion || scenePhase != .active { Text(copy(.motionPaused)) }
                }
                Section(copy(.widget)) {
                    Text(copy(widgetStatus)).accessibilityIdentifier("widget-status")
                    Button(copy(.publish), action: publishPreview).disabled(snapshotStore == nil)
                    Button(copy(.clear), action: clearPreview).disabled(snapshotStore == nil)
                }
                Section(copy(.voice)) { Text(copy(.voiceDetail)) }
            }
            .navigationTitle(copy(.title))
            .environment(\.locale, Locale(identifier: locale.rawValue))
            .onAppear { visible = true }
            .onDisappear { visible = false }
            .task { prepareWidget() }
            .onOpenURL { url in
                guard WidgetLink.accepts(url) else { widgetStatus = .unsupported; return }
                widgetStatus = snapshotStore?.snapshot == nil ? .previewMissing : .previewOpened
            }
        }
    }
}
