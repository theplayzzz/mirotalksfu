#ifdef _WIN32

#include <napi.h>

#include <Windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <winternl.h>
#include <wrl/client.h>

#include <atomic>
#include <iomanip>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

constexpr UINT32 kSampleRate = 48000;
constexpr WORD kChannels = 2;
constexpr WORD kBitsPerSample = 16;

struct AudioEvent {
    enum class Kind { Ready, Audio, Error, Stopped } kind;
    std::vector<uint8_t> pcm;
    std::string message;
};

std::string HResultMessage(const char* operation, HRESULT hr) {
    std::ostringstream out;
    out << operation << " falhou (HRESULT 0x" << std::hex << std::uppercase
        << static_cast<unsigned long>(hr) << ")";
    return out.str();
}

class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler {
  public:
    explicit ActivationHandler(HANDLE completed) : completed_(completed) {}

    STDMETHODIMP QueryInterface(REFIID iid, void** object) override {
        if (!object) return E_POINTER;
        if (iid == __uuidof(IUnknown) || iid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *object = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
            AddRef();
            return S_OK;
        }
        *object = nullptr;
        return E_NOINTERFACE;
    }

    STDMETHODIMP_(ULONG) AddRef() override { return ++references_; }

    STDMETHODIMP_(ULONG) Release() override {
        ULONG remaining = --references_;
        if (!remaining) delete this;
        return remaining;
    }

    STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
        ComPtr<IUnknown> activated;
        HRESULT activationResult = E_UNEXPECTED;
        HRESULT callResult = operation->GetActivateResult(&activationResult, &activated);
        result_ = FAILED(callResult) ? callResult : activationResult;
        if (SUCCEEDED(result_)) activated_ = activated;
        SetEvent(completed_);
        return S_OK;
    }

    HRESULT result() const { return result_; }
    ComPtr<IUnknown> activated() const { return activated_; }

  private:
    ~ActivationHandler() = default;
    std::atomic<ULONG> references_{1};
    HANDLE completed_ = nullptr;
    HRESULT result_ = E_PENDING;
    ComPtr<IUnknown> activated_;
};

class ProcessLoopbackCapture {
  public:
    ~ProcessLoopbackCapture() { Stop(); }

    bool Start(Napi::Env env, DWORD processId, Napi::Function callback, std::string& error) {
        std::lock_guard<std::mutex> lock(mutex_);
        if (running_ || thread_.joinable()) {
            error = "Já existe uma captura de áudio em andamento.";
            return false;
        }
        if (!processId) {
            error = "O processo selecionado é inválido.";
            return false;
        }

        stopEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!stopEvent_) {
            error = "Não foi possível criar o evento de encerramento.";
            return false;
        }

        callback_ = Napi::ThreadSafeFunction::New(env, callback, "MiroTalkProcessAudio", 0, 1);
        running_ = true;
        thread_ = std::thread([this, processId] { CaptureThread(processId); });
        return true;
    }

    void Stop() {
        std::thread worker;
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (stopEvent_) SetEvent(stopEvent_);
            if (thread_.joinable()) worker = std::move(thread_);
        }
        if (worker.joinable() && worker.get_id() != std::this_thread::get_id()) worker.join();
        std::lock_guard<std::mutex> lock(mutex_);
        if (stopEvent_) {
            CloseHandle(stopEvent_);
            stopEvent_ = nullptr;
        }
        running_ = false;
    }

    bool running() const { return running_; }

  private:
    void Post(AudioEvent* event) {
        napi_status status = callback_.NonBlockingCall(event, [](Napi::Env env, Napi::Function callback, AudioEvent* item) {
            Napi::Object payload = Napi::Object::New(env);
            switch (item->kind) {
                case AudioEvent::Kind::Ready:
                    payload.Set("type", "ready");
                    payload.Set("sampleRate", kSampleRate);
                    payload.Set("channels", kChannels);
                    break;
                case AudioEvent::Kind::Audio:
                    payload.Set("type", "audio");
                    payload.Set("sampleRate", kSampleRate);
                    payload.Set("channels", kChannels);
                    payload.Set("data", Napi::Buffer<uint8_t>::Copy(env, item->pcm.data(), item->pcm.size()));
                    break;
                case AudioEvent::Kind::Error:
                    payload.Set("type", "error");
                    payload.Set("message", item->message);
                    break;
                case AudioEvent::Kind::Stopped:
                    payload.Set("type", "stopped");
                    break;
            }
            callback.Call({payload});
            delete item;
        });
        if (status != napi_ok) delete event;
    }

    HRESULT ActivateProcessAudio(DWORD processId, ComPtr<IAudioClient>& audioClient) {
        HANDLE completed = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        if (!completed) return HRESULT_FROM_WIN32(GetLastError());

        ActivationHandler* handler = new ActivationHandler(completed);
        AUDIOCLIENT_ACTIVATION_PARAMS params{};
        params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
        params.ProcessLoopbackParams.TargetProcessId = processId;
        params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

        PROPVARIANT activationParams{};
        activationParams.vt = VT_BLOB;
        activationParams.blob.cbSize = sizeof(params);
        activationParams.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

        ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
        HRESULT hr = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            __uuidof(IAudioClient),
            &activationParams,
            handler,
            &operation);

        if (SUCCEEDED(hr)) {
            DWORD wait = WaitForSingleObject(completed, 10000);
            if (wait == WAIT_OBJECT_0) {
                hr = handler->result();
                if (SUCCEEDED(hr)) hr = handler->activated().As(&audioClient);
            } else {
                hr = wait == WAIT_TIMEOUT ? HRESULT_FROM_WIN32(ERROR_TIMEOUT) : HRESULT_FROM_WIN32(GetLastError());
            }
        }

        handler->Release();
        CloseHandle(completed);
        return hr;
    }

    void CaptureThread(DWORD processId) {
        HRESULT comResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        bool uninitialize = SUCCEEDED(comResult);
        HRESULT hr = SUCCEEDED(comResult) || comResult == RPC_E_CHANGED_MODE ? S_OK : comResult;

        ComPtr<IAudioClient> audioClient;
        ComPtr<IAudioCaptureClient> captureClient;
        HANDLE audioEvent = nullptr;
        bool started = false;

        if (SUCCEEDED(hr)) hr = ActivateProcessAudio(processId, audioClient);

        WAVEFORMATEX format{};
        format.wFormatTag = WAVE_FORMAT_PCM;
        format.nChannels = kChannels;
        format.nSamplesPerSec = kSampleRate;
        format.wBitsPerSample = kBitsPerSample;
        format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
        format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;

        if (SUCCEEDED(hr)) {
            audioEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
            if (!audioEvent) hr = HRESULT_FROM_WIN32(GetLastError());
        }
        if (SUCCEEDED(hr)) {
            hr = audioClient->Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                0,
                0,
                &format,
                nullptr);
        }
        if (SUCCEEDED(hr)) hr = audioClient->GetService(IID_PPV_ARGS(&captureClient));
        if (SUCCEEDED(hr)) hr = audioClient->SetEventHandle(audioEvent);
        if (SUCCEEDED(hr)) hr = audioClient->Start();
        if (SUCCEEDED(hr)) {
            started = true;
            Post(new AudioEvent{AudioEvent::Kind::Ready});
        } else {
            Post(new AudioEvent{AudioEvent::Kind::Error, {}, HResultMessage("A captura WASAPI", hr)});
        }

        HANDLE waits[] = {stopEvent_, audioEvent};
        while (started) {
            DWORD wait = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
            if (wait == WAIT_OBJECT_0) break;
            if (wait != WAIT_OBJECT_0 + 1) {
                Post(new AudioEvent{AudioEvent::Kind::Error, {}, "A espera por amostras de áudio falhou."});
                break;
            }

            UINT32 packetFrames = 0;
            while (SUCCEEDED(hr = captureClient->GetNextPacketSize(&packetFrames)) && packetFrames > 0) {
                BYTE* data = nullptr;
                DWORD flags = 0;
                UINT64 devicePosition = 0;
                UINT64 qpcPosition = 0;
                hr = captureClient->GetBuffer(
                    &data, &packetFrames, &flags, &devicePosition, &qpcPosition);
                if (FAILED(hr)) break;

                size_t bytes = static_cast<size_t>(packetFrames) * format.nBlockAlign;
                auto* event = new AudioEvent{AudioEvent::Kind::Audio};
                event->pcm.resize(bytes);
                if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && data) {
                    memcpy(event->pcm.data(), data, bytes);
                }
                captureClient->ReleaseBuffer(packetFrames);
                Post(event);
            }

            if (FAILED(hr)) {
                Post(new AudioEvent{AudioEvent::Kind::Error, {}, HResultMessage("A leitura do áudio", hr)});
                break;
            }
        }

        if (started) audioClient->Stop();
        if (audioEvent) CloseHandle(audioEvent);
        if (uninitialize) CoUninitialize();

        running_ = false;
        Post(new AudioEvent{AudioEvent::Kind::Stopped});
        callback_.Release();
    }

    mutable std::mutex mutex_;
    std::atomic<bool> running_{false};
    HANDLE stopEvent_ = nullptr;
    std::thread thread_;
    Napi::ThreadSafeFunction callback_;
};

ProcessLoopbackCapture capture;

Napi::Value Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() != 2 || !info[0].IsNumber() || !info[1].IsFunction()) {
        Napi::TypeError::New(env, "start requer processId e callback").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string error;
    bool ok = capture.Start(env, info[0].As<Napi::Number>().Uint32Value(), info[1].As<Napi::Function>(), error);
    if (!ok) {
        Napi::Error::New(env, error).ThrowAsJavaScriptException();
        return env.Undefined();
    }
    return Napi::Boolean::New(env, true);
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
    capture.Stop();
    return info.Env().Undefined();
}

Napi::Value GetWindowProcessId(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() != 1 || !info[0].IsString()) return Napi::Number::New(env, 0);
    std::string id = info[0].As<Napi::String>().Utf8Value();
    if (id.rfind("window:", 0) != 0) return Napi::Number::New(env, 0);
    size_t end = id.find(':', 7);
    if (end == std::string::npos) return Napi::Number::New(env, 0);
    std::string handleText = id.substr(7, end - 7);
    char* parseEnd = nullptr;
    unsigned long long rawHandle = _strtoui64(handleText.c_str(), &parseEnd, 10);
    if (!parseEnd || *parseEnd != '\0' || rawHandle == 0) return Napi::Number::New(env, 0);
    DWORD processId = 0;
    GetWindowThreadProcessId(reinterpret_cast<HWND>(static_cast<uintptr_t>(rawHandle)), &processId);
    return Napi::Number::New(env, processId);
}

Napi::Value GetWindowsBuild(const Napi::CallbackInfo& info) {
    using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
    auto ntdll = GetModuleHandleW(L"ntdll.dll");
    auto rtlGetVersion = reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion"));
    RTL_OSVERSIONINFOW version{};
    version.dwOSVersionInfoSize = sizeof(version);
    if (!rtlGetVersion || rtlGetVersion(&version) != 0) return info.Env().Null();
    Napi::Object result = Napi::Object::New(info.Env());
    result.Set("major", version.dwMajorVersion);
    result.Set("minor", version.dwMinorVersion);
    result.Set("build", version.dwBuildNumber);
    return result;
}

Napi::Object Initialize(Napi::Env env, Napi::Object exports) {
    exports.Set("start", Napi::Function::New(env, Start));
    exports.Set("stop", Napi::Function::New(env, Stop));
    exports.Set("getWindowProcessId", Napi::Function::New(env, GetWindowProcessId));
    exports.Set("getWindowsBuild", Napi::Function::New(env, GetWindowsBuild));
    return exports;
}

}  // namespace

NODE_API_MODULE(process_loopback, Initialize)

#else
#error process_loopback is only supported on Windows
#endif
