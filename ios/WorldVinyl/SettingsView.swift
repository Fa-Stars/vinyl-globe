import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var server: ServerModel
    @Environment(\.dismiss) private var dismiss
    @State private var draft: String = ""

    var body: some View {
        NavigationView {
            Form {
                Section {
                    TextField("192.168.1.23:3000", text: $draft)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                        .keyboardType(.URL)
                        .font(.system(.body, design: .monospaced))
                } header: {
                    Text("服务器地址")
                } footer: {
                    Text("在电脑上运行 node web/server.js 后，填入电脑的局域网 IP。端口默认 3000，不写也可以。")
                }

                Section {
                    Button("保存并连接") {
                        server.save(draft)
                        dismiss()
                    }
                    .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)

                    if !server.address.isEmpty {
                        Button("清除地址", role: .destructive) {
                            server.clear()
                            draft = ""
                            dismiss()
                        }
                    }
                }

                Section {
                    Text("当前：\(server.address.isEmpty ? "未设置" : server.address)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("World Vinyl")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
        }
        .onAppear { draft = server.address }
    }
}
