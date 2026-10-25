// Windows API probe: SystemIdentification.GetSystemIdForPublisher from an unpackaged desktop
// process. Diagnostic only, run through run.mjs. Prints the Source the ID came from and a SHA-256
// of the ID, never the ID itself, twice per run to show it is stable within a process.
//
// Build from a VsDevCmd prompt (x64 or arm64):
//   cl /nologo /O2 /MT /EHsc /std:c++17 /permissive- /W4 /I "%WindowsSdkDir%Include\%WindowsSDKVersion%cppwinrt" /Fe:sysid.exe sysid.cpp /link windowsapp.lib
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Security.Cryptography.h>
#include <winrt/Windows.Security.Cryptography.Core.h>
#include <winrt/Windows.Storage.Streams.h>
#include <winrt/Windows.System.Profile.h>
#include <cstdint>
#include <cstdio>

using namespace winrt::Windows::Security::Cryptography;
using namespace winrt::Windows::Security::Cryptography::Core;
using namespace winrt::Windows::System::Profile;

static const char *source_name(SystemIdentificationSource source) {
  switch (source) {
    case SystemIdentificationSource::None: return "None";
    case SystemIdentificationSource::Tpm: return "Tpm";
    case SystemIdentificationSource::Uefi: return "Uefi";
    case SystemIdentificationSource::Registry: return "Registry";
    default: return "unknown";
  }
}

int main() {
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
  } catch (winrt::hresult_error const &error) {
    std::printf("S0 FAIL init_apartment hresult=0x%08X\n", static_cast<uint32_t>(static_cast<int32_t>(error.code())));
    return 1;
  }
  int failed = 0;
  for (int call = 1; call <= 2; call++) {
    try {
      SystemIdentificationInfo info = SystemIdentification::GetSystemIdForPublisher();
      auto id = info.Id();
      if (!id) {
        std::printf("S%d INFO source=%d(%s) id=null\n", call, static_cast<int>(info.Source()), source_name(info.Source()));
        continue;
      }
      auto digest = HashAlgorithmProvider::OpenAlgorithm(HashAlgorithmNames::Sha256()).HashData(id);
      std::printf("S%d INFO source=%d(%s) bytes=%u id_sha256=%ls\n", call, static_cast<int>(info.Source()), source_name(info.Source()),
                  id.Length(), CryptographicBuffer::EncodeToHexString(digest).c_str());
    } catch (winrt::hresult_error const &error) {
      failed++;
      std::printf("S%d FAIL hresult=0x%08X message=%ls\n", call, static_cast<uint32_t>(static_cast<int32_t>(error.code())), error.message().c_str());
    }
    std::fflush(stdout);
  }
  return failed ? 1 : 0;
}
