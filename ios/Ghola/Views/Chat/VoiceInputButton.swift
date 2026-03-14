#if os(iOS)
import Speech
import SwiftUI

struct VoiceInputButton: View {
    let onTranscription: (String) -> Void

    @State private var isRecording = false
    @State private var recognizer: SFSpeechRecognizer?
    @State private var recognitionTask: SFSpeechRecognitionTask?
    @State private var audioEngine: AVAudioEngine?
    @State private var hasPermission = false

    var body: some View {
        Button {
            if isRecording {
                stopRecording()
            } else {
                startRecording()
            }
        } label: {
            Image(systemName: isRecording ? "mic.fill" : "mic")
                .font(.title3)
                .foregroundStyle(isRecording ? .red : Theme.textSecondary)
                .frame(width: 36, height: 36)
                .background(isRecording ? Color.red.opacity(0.15) : .clear)
                .clipShape(Circle())
        }
        .onAppear { requestPermission() }
    }

    private func requestPermission() {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                hasPermission = status == .authorized
            }
        }
    }

    private func startRecording() {
        guard hasPermission else { return }

        let recognizer = SFSpeechRecognizer(locale: .current)
        guard let recognizer, recognizer.isAvailable else { return }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = false

        let audioEngine = AVAudioEngine()
        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            return
        }

        let task = recognizer.recognitionTask(with: request) { result, error in
            if let result, result.isFinal {
                DispatchQueue.main.async {
                    onTranscription(result.bestTranscription.formattedString)
                    stopRecording()
                }
            }
            if error != nil {
                DispatchQueue.main.async { stopRecording() }
            }
        }

        self.recognizer = recognizer
        self.recognitionTask = task
        self.audioEngine = audioEngine
        isRecording = true
    }

    private func stopRecording() {
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        recognitionTask?.cancel()
        audioEngine = nil
        recognitionTask = nil
        isRecording = false
    }
}
#endif
