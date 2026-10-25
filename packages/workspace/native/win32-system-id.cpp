// Windows' documented system ID for an unpackaged app's publisher, for win32-process.c. C++/WinRT
// needs C++20 and links windowsapp.lib. On a thread with no COM apartment, C++/WinRT activates the
// API in the process's implicit multithreaded apartment, so Node's own thread is not initialized.
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Security.Cryptography.h>
#include <winrt/Windows.Storage.Streams.h>
#include <winrt/Windows.System.Profile.h>
#include <cstdint>
#include <cstring>

// Copy the ID into `id` and its SystemIdentificationSource into `source`, and return 0, or return the
// failing HRESULT. An ID longer than `capacity` reports its length and copies nothing.
extern "C" int32_t cotal_system_id(uint8_t *id, uint32_t capacity, uint32_t *length, int32_t *source) noexcept {
  try {
    using namespace winrt::Windows::System::Profile;
    SystemIdentificationInfo info = SystemIdentification::GetSystemIdForPublisher();
    *source = static_cast<int32_t>(info.Source());
    *length = 0;
    auto buffer = info.Id();
    if (!buffer) return 0;
    winrt::com_array<uint8_t> bytes;
    winrt::Windows::Security::Cryptography::CryptographicBuffer::CopyToByteArray(buffer, bytes);
    *length = bytes.size();
    if (bytes.size() <= capacity) std::memcpy(id, bytes.data(), bytes.size());
    return 0;
  } catch (winrt::hresult_error const &error) {
    return static_cast<int32_t>(error.code());
  } catch (...) {
    return -2147467259;  // E_FAIL
  }
}
