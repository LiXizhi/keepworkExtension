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
    @State private var locale: PetLocale = .english
    @State private var selected = false
    @State private var snapshotStore: WidgetSnapshotStore?
    @State private var widgetStatus = "App Group sharing is not configured."
    private let context = ConversationContext(accountID: "dev-account", homeRegion: "dev-region", personaID: "dev-persona", conversationID: "dev-conversation")

    private func prepareWidget() {
        guard snapshotStore == nil, let directory = DevelopmentWidgetBridge.directory() else { return }
        do {
            let store = WidgetSnapshotStore(storage: try FileWidgetStorage(directory: directory))
            snapshotStore = store
            widgetStatus = store.lastStorageError == nil ? "Synthetic sharing ready." : "Snapshot cleanup failed; sharing is disabled."
            WidgetCenter.shared.reloadTimelines(ofKind: DevelopmentWidgetBridge.kind)
        } catch { widgetStatus = "Snapshot storage unavailable." }
    }

    private func publishPreview() {
        guard let store = snapshotStore else { return }
        store.select(context)
        let value = WidgetSnapshot(personaID: "dev-persona", appearanceID: "dev-shape", conversationID: "dev-conversation", locale: locale, updatedAt: Date())
        widgetStatus = store.publish(value, scopeToken: store.scopeToken) ? "Synthetic snapshot saved." : "Snapshot write failed; sharing is disabled."
        WidgetCenter.shared.reloadTimelines(ofKind: DevelopmentWidgetBridge.kind)
    }

    private func clearPreview() {
        snapshotStore?.signOut()
        selected = false
        widgetStatus = snapshotStore?.lastStorageError == nil ? "Snapshot cleared." : "Snapshot removal failed; retry required."
        WidgetCenter.shared.reloadTimelines(ofKind: DevelopmentWidgetBridge.kind)
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("Offline development") {
                    Text("AI Pet \(Development.version)")
                    Text("Synthetic preview only. Login, official catalog, conversation and voice services are not connected.")
                }
                Section("Language identifier") {
                    Picker("Language", selection: $locale) {
                        ForEach(PetLocale.allCases, id: \.self) { locale in
                            Text(locale.rawValue).tag(locale)
                        }
                    }
                    Text("Six locale identifiers are available; translated product copy and speech quality remain unverified.")
                }
                Section("Development preview") {
                    Image(systemName: "sparkles")
                        .font(.largeTitle)
                        .accessibilityLabel("Synthetic development placeholder")
                    Text(selected ? "Local preview selected" : "No preview selected")
                    Button(selected ? "Clear local preview" : "Select local preview") { selected.toggle() }
                }
                Section("Widget development") {
                    Text(widgetStatus)
                    Button("Publish synthetic widget snapshot", action: publishPreview).disabled(snapshotStore == nil)
                    Button("Clear snapshot / development sign-out", action: clearPreview).disabled(snapshotStore == nil)
                }
                Section("Voice unavailable") {
                    Text("This build never requests microphone access or opens a service connection. Native policy is verified separately by Swift Package tests.")
                }
            }
            .navigationTitle("AI Pet · Development")
            .task { prepareWidget() }
            .onOpenURL { url in
                guard WidgetLink.accepts(url) else { widgetStatus = "Unsupported link."; return }
                widgetStatus = snapshotStore?.snapshot == nil ? "No current authorized development preview." : "Opened current synthetic preview."
            }
        }
    }
}
