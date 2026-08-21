// AutoTyper installer.
//
// Clones the AutoTyper repo, builds it (git + npm must already be on PATH),
// and copies only the runtime output into Program Files. The same binary
// doubles as the uninstaller when invoked with /uninstall (a copy of it is
// dropped into the install directory for that purpose).
//
// Build (MSVC, from a "x64 Native Tools" prompt):
//   cl /EHsc /std:c++17 /DUNICODE /D_UNICODE main.cpp /link shell32.lib ole32.lib advapi32.lib uuid.lib /out:AutoTyperInstaller.exe
//
// Build (MinGW-w64):
//   g++ -std=c++17 -municode -DUNICODE -D_UNICODE main.cpp -o AutoTyperInstaller.exe -lshell32 -lole32 -ladvapi32 -luuid

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <windows.h>
#include <shlobj.h>
#include <shellapi.h>
#include <shobjidl.h>
#include <objbase.h>
#include <knownfolders.h>

#include <filesystem>
#include <string>
#include <vector>
#include <iostream>
#include <cstdint>

#ifdef _MSC_VER
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "uuid.lib")
#endif

namespace fs = std::filesystem;

static const wchar_t* kRepoUrl = L"https://github.com/AbhiramV010/AutoTyper.git";
static const wchar_t* kAppName = L"AutoTyper";
static const wchar_t* kRegistryKey = L"AutoTyper";
static const wchar_t* kPublisher = L"Abhiram Vadali";
static const wchar_t* kAppVersion = L"1.0.0";
static const wchar_t* kUninstallerName = L"Uninstall AutoTyper.exe";

// ---------- small utilities ----------

static void Log(const std::wstring& msg) {
    std::wcout << msg << std::endl;
}

[[noreturn]] static void Fail(const std::wstring& msg, int code = 1) {
    std::wcerr << L"\nERROR: " << msg << std::endl;
    std::wcerr << L"Press Enter to exit..." << std::endl;
    std::wcin.get();
    std::exit(code);
}

static std::wstring KnownFolder(REFKNOWNFOLDERID id) {
    PWSTR path = nullptr;
    std::wstring result;
    if (SUCCEEDED(SHGetKnownFolderPath(id, 0, nullptr, &path))) {
        result = path;
    }
    if (path) CoTaskMemFree(path);
    return result;
}

static std::wstring SelfPath() {
    wchar_t buf[MAX_PATH];
    DWORD len = GetModuleFileNameW(nullptr, buf, MAX_PATH);
    return std::wstring(buf, len);
}

static bool IsElevated() {
    BOOL isAdmin = FALSE;
    PSID adminGroup = nullptr;
    SID_IDENTIFIER_AUTHORITY ntAuthority = SECURITY_NT_AUTHORITY;
    if (AllocateAndInitializeSid(&ntAuthority, 2, SECURITY_BUILTIN_DOMAIN_RID,
                                  DOMAIN_ALIAS_RID_ADMINS, 0, 0, 0, 0, 0, 0, &adminGroup)) {
        CheckTokenMembership(nullptr, adminGroup, &isAdmin);
        FreeSid(adminGroup);
    }
    return isAdmin != FALSE;
}

// Runs a command via cmd.exe /c, sharing this process's console so the user
// sees git/npm progress live. Returns true on exit code 0.
static bool RunAndWait(const std::wstring& command, const std::wstring& workDir, DWORD* exitCodeOut = nullptr) {
    std::wstring full = L"cmd.exe /c " + command;

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};

    BOOL ok = CreateProcessW(
        nullptr, full.data(), nullptr, nullptr, TRUE,
        0, nullptr,
        workDir.empty() ? nullptr : workDir.c_str(),
        &si, &pi);

    if (!ok) return false;

    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    if (exitCodeOut) *exitCodeOut = code;
    return code == 0;
}

static bool CommandAvailable(const std::wstring& name) {
    DWORD code = 1;
    RunAndWait(L"where " + name + L" >nul 2>&1", L"", &code);
    return code == 0;
}

// Recursively copies src into dst, skipping any file whose extension is in excludeExt.
static void CopyFiltered(const fs::path& src, const fs::path& dst, const std::vector<std::wstring>& excludeExt) {
    fs::create_directories(dst);
    for (auto& entry : fs::directory_iterator(src)) {
        const fs::path name = entry.path().filename();
        if (entry.is_directory()) {
            CopyFiltered(entry.path(), dst / name, excludeExt);
            continue;
        }
        const std::wstring ext = entry.path().extension().wstring();
        bool skip = false;
        for (auto& e : excludeExt) {
            if (ext == e) { skip = true; break; }
        }
        if (!skip) {
            fs::copy_file(entry.path(), dst / name, fs::copy_options::overwrite_existing);
        }
    }
}

static std::uintmax_t DirSizeBytes(const fs::path& dir) {
    std::uintmax_t total = 0;
    std::error_code ec;
    for (auto& entry : fs::recursive_directory_iterator(dir, fs::directory_options::skip_permission_denied, ec)) {
        if (entry.is_regular_file()) {
            std::error_code sizeEc;
            auto sz = entry.file_size(sizeEc);
            if (!sizeEc) total += sz;
        }
    }
    return total;
}

static bool CreateShortcut(const std::wstring& lnkPath, const std::wstring& target,
                            const std::wstring& args, const std::wstring& workDir,
                            const std::wstring& iconPath) {
    IShellLinkW* shellLink = nullptr;
    HRESULT hr = CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER,
                                   IID_IShellLinkW, reinterpret_cast<void**>(&shellLink));
    if (FAILED(hr)) return false;

    shellLink->SetPath(target.c_str());
    shellLink->SetArguments(args.c_str());
    shellLink->SetWorkingDirectory(workDir.c_str());
    if (!iconPath.empty()) shellLink->SetIconLocation(iconPath.c_str(), 0);

    IPersistFile* persistFile = nullptr;
    hr = shellLink->QueryInterface(IID_IPersistFile, reinterpret_cast<void**>(&persistFile));
    if (SUCCEEDED(hr)) {
        hr = persistFile->Save(lnkPath.c_str(), TRUE);
        persistFile->Release();
    }
    shellLink->Release();
    return SUCCEEDED(hr);
}

// ---------- registry ----------

static std::wstring UninstallSubKey() {
    return L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + std::wstring(kRegistryKey);
}

static void WriteUninstallInfo(const std::wstring& installDir, DWORD sizeKb) {
    HKEY key;
    if (RegCreateKeyExW(HKEY_LOCAL_MACHINE, UninstallSubKey().c_str(), 0, nullptr, 0,
                         KEY_WRITE | KEY_WOW64_64KEY, nullptr, &key, nullptr) != ERROR_SUCCESS) {
        Log(L"Warning: could not write uninstall registry entry.");
        return;
    }
    auto setStr = [&](const wchar_t* name, const std::wstring& value) {
        RegSetValueExW(key, name, 0, REG_SZ, reinterpret_cast<const BYTE*>(value.c_str()),
                        static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t)));
    };
    setStr(L"DisplayName", kAppName);
    setStr(L"DisplayVersion", kAppVersion);
    setStr(L"Publisher", kPublisher);
    setStr(L"InstallLocation", installDir);
    setStr(L"DisplayIcon", installDir + L"\\build\\icon.ico");
    setStr(L"UninstallString", L"\"" + installDir + L"\\" + kUninstallerName + L"\" /uninstall");

    DWORD noModify = 1, noRepair = 1;
    RegSetValueExW(key, L"NoModify", 0, REG_DWORD, reinterpret_cast<const BYTE*>(&noModify), sizeof(noModify));
    RegSetValueExW(key, L"NoRepair", 0, REG_DWORD, reinterpret_cast<const BYTE*>(&noRepair), sizeof(noRepair));
    RegSetValueExW(key, L"EstimatedSize", 0, REG_DWORD, reinterpret_cast<const BYTE*>(&sizeKb), sizeof(sizeKb));
    RegCloseKey(key);
}

static std::wstring ReadInstallLocation() {
    HKEY key;
    if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, UninstallSubKey().c_str(), 0,
                       KEY_READ | KEY_WOW64_64KEY, &key) != ERROR_SUCCESS) {
        return L"";
    }
    wchar_t buf[MAX_PATH * 2] = {};
    DWORD size = sizeof(buf);
    DWORD type = 0;
    std::wstring result;
    if (RegQueryValueExW(key, L"InstallLocation", nullptr, &type,
                          reinterpret_cast<BYTE*>(buf), &size) == ERROR_SUCCESS) {
        result = buf;
    }
    RegCloseKey(key);
    return result;
}

static void DeleteUninstallRegistryKey() {
    RegDeleteKeyExW(HKEY_LOCAL_MACHINE, UninstallSubKey().c_str(), KEY_WOW64_64KEY, 0);
}

// ---------- elevation ----------

static bool RelaunchElevated(const std::vector<std::wstring>& args) {
    std::wstring exePath = SelfPath();
    std::wstring params;
    for (auto& a : args) params += L"\"" + a + L"\" ";

    SHELLEXECUTEINFOW sei{};
    sei.cbSize = sizeof(sei);
    sei.fMask = SEE_MASK_NOCLOSEPROCESS;
    sei.lpVerb = L"runas";
    sei.lpFile = exePath.c_str();
    sei.lpParameters = params.c_str();
    sei.nShow = SW_NORMAL;

    if (!ShellExecuteExW(&sei)) return false;
    if (sei.hProcess) {
        WaitForSingleObject(sei.hProcess, INFINITE);
        CloseHandle(sei.hProcess);
    }
    return true;
}

// ---------- install ----------

static void CleanupAndFail(const fs::path& tempDir, const std::wstring& msg) {
    std::error_code ec;
    fs::remove_all(tempDir, ec);
    Fail(msg);
}

static void DoInstall(const std::wstring& customDir) {
    Log(L"===== Installing " + std::wstring(kAppName) + L" =====\n");

    if (!CommandAvailable(L"git")) {
        Fail(L"git was not found on PATH. Install Git for Windows (https://git-scm.com) and try again.");
    }
    if (!CommandAvailable(L"npm")) {
        Fail(L"npm was not found on PATH. Install Node.js (https://nodejs.org) and try again.");
    }

    std::wstring installDir = customDir.empty()
        ? KnownFolder(FOLDERID_ProgramFiles) + L"\\AutoTyper"
        : customDir;

    fs::path tempDir = fs::temp_directory_path() / (L"AutoTyperInstall_" + std::to_wstring(GetCurrentProcessId()));
    std::error_code ec;
    fs::create_directories(tempDir, ec);
    fs::path repoDir = tempDir / L"repo";

    Log(L"Cloning " + std::wstring(kRepoUrl) + L" ...");
    DWORD code = 0;
    if (!RunAndWait(L"git clone --depth 1 " + std::wstring(kRepoUrl) + L" \"" + repoDir.wstring() + L"\"", L"", &code)) {
        CleanupAndFail(tempDir, L"git clone failed.");
    }

    Log(L"\nInstalling npm dependencies (this can take a few minutes)...");
    if (!RunAndWait(L"npm install", repoDir.wstring(), &code)) {
        CleanupAndFail(tempDir, L"npm install failed.");
    }

    Log(L"\nBuilding...");
    if (!RunAndWait(L"npm run build", repoDir.wstring(), &code)) {
        CleanupAndFail(tempDir, L"npm run build failed.");
    }

    // Sanity-check the build actually produced runtime files.
    if (!fs::exists(repoDir / L"main.js") || !fs::exists(repoDir / L"preload.js") ||
        !fs::exists(repoDir / L"renderer" / L"renderer.js")) {
        CleanupAndFail(tempDir, L"Build did not produce the expected output files.");
    }

    fs::path electronPkg = repoDir / L"node_modules" / L"electron";
    if (!fs::exists(electronPkg)) {
        CleanupAndFail(tempDir, L"node_modules/electron is missing after npm install.");
    }

    if (fs::exists(installDir)) {
        Log(L"\nExisting install found at " + installDir + L", removing it first...");
        fs::remove_all(installDir, ec);
    }

    Log(L"\nCopying files to " + installDir + L" ...");
    fs::create_directories(installDir, ec);

    for (const wchar_t* f : {L"main.js", L"main.js.map", L"preload.js", L"preload.js.map", L"package.json"}) {
        fs::path srcFile = repoDir / f;
        if (fs::exists(srcFile)) {
            fs::copy_file(srcFile, fs::path(installDir) / f, fs::copy_options::overwrite_existing);
        }
    }

    fs::create_directories(fs::path(installDir) / L"src", ec);
    fs::copy_file(repoDir / L"src" / L"typer.ps1", fs::path(installDir) / L"src" / L"typer.ps1",
                  fs::copy_options::overwrite_existing);

    CopyFiltered(repoDir / L"renderer", fs::path(installDir) / L"renderer", {L".ts"});

    fs::create_directories(fs::path(installDir) / L"build", ec);
    fs::copy_file(repoDir / L"build" / L"icon.ico", fs::path(installDir) / L"build" / L"icon.ico",
                  fs::copy_options::overwrite_existing);

    Log(L"Copying Electron runtime (this is the largest step)...");
    fs::create_directories(fs::path(installDir) / L"node_modules", ec);
    fs::copy(electronPkg, fs::path(installDir) / L"node_modules" / L"electron",
             fs::copy_options::recursive | fs::copy_options::overwrite_existing, ec);
    if (ec) {
        CleanupAndFail(tempDir, L"Failed to copy the Electron runtime: " + std::wstring(ec.message().begin(), ec.message().end()));
    }

    // Drop a copy of ourselves in as the uninstaller.
    fs::copy_file(SelfPath(), fs::path(installDir) / kUninstallerName, fs::copy_options::overwrite_existing, ec);

    Log(L"Creating shortcuts...");
    std::wstring electronExe = installDir + L"\\node_modules\\electron\\dist\\electron.exe";
    std::wstring iconPath = installDir + L"\\build\\icon.ico";

    std::wstring startMenuDir = KnownFolder(FOLDERID_CommonPrograms);
    if (!startMenuDir.empty()) {
        CreateShortcut(startMenuDir + L"\\AutoTyper.lnk", electronExe, L".", installDir, iconPath);
    }
    std::wstring desktopDir = KnownFolder(FOLDERID_PublicDesktop);
    if (!desktopDir.empty()) {
        CreateShortcut(desktopDir + L"\\AutoTyper.lnk", electronExe, L".", installDir, iconPath);
    }

    Log(L"Registering with Windows (Add/Remove Programs)...");
    DWORD sizeKb = static_cast<DWORD>(DirSizeBytes(installDir) / 1024);
    WriteUninstallInfo(installDir, sizeKb);

    Log(L"Cleaning up temporary files...");
    fs::remove_all(tempDir, ec);

    Log(L"\n" + std::wstring(kAppName) + L" installed to " + installDir);
    Log(L"A shortcut was added to the Start Menu and Desktop.\n");
    Log(L"Press Enter to exit...");
    std::wcin.get();
}

// ---------- uninstall ----------

static void DoUninstall() {
    Log(L"===== Uninstalling " + std::wstring(kAppName) + L" =====\n");

    std::wstring installDir = ReadInstallLocation();
    if (installDir.empty()) {
        installDir = KnownFolder(FOLDERID_ProgramFiles) + L"\\AutoTyper";
    }

    Log(L"Removing shortcuts...");
    std::error_code ec;
    std::wstring startMenuDir = KnownFolder(FOLDERID_CommonPrograms);
    if (!startMenuDir.empty()) fs::remove(startMenuDir + L"\\AutoTyper.lnk", ec);
    std::wstring desktopDir = KnownFolder(FOLDERID_PublicDesktop);
    if (!desktopDir.empty()) fs::remove(desktopDir + L"\\AutoTyper.lnk", ec);

    Log(L"Removing registry entries...");
    DeleteUninstallRegistryKey();

    Log(L"Removing installed files...");
    // We are likely running from inside installDir, so we cannot delete it
    // synchronously. Hand off to a detached cmd that waits for us to exit.
    std::wstring cmd = L"cmd.exe /c timeout /t 2 /nobreak >nul & rmdir /s /q \"" + installDir + L"\"";
    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    if (CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE,
                        CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS, nullptr, nullptr, &si, &pi)) {
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
    }

    Log(L"\n" + std::wstring(kAppName) + L" has been uninstalled.");
    Log(L"Press Enter to exit...");
    std::wcin.get();
}

// ---------- entry point ----------

int main() {
    int argc = 0;
    LPWSTR* argvRaw = CommandLineToArgvW(GetCommandLineW(), &argc);

    bool doUninstall = false;
    std::wstring customDir;
    std::vector<std::wstring> args;
    if (argvRaw) {
        for (int i = 1; i < argc; ++i) {
            std::wstring a = argvRaw[i];
            args.push_back(a);
            if (a == L"/uninstall") doUninstall = true;
            else if (a.rfind(L"/dir:", 0) == 0) customDir = a.substr(5);
        }
        LocalFree(argvRaw);
    }

    if (!IsElevated()) {
        Log(L"Administrator privileges are required. Requesting elevation...");
        if (!RelaunchElevated(args)) {
            std::wcerr << L"Elevation was cancelled or failed. Please run this program as Administrator." << std::endl;
            return 1;
        }
        return 0;
    }

    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    if (doUninstall) {
        DoUninstall();
    } else {
        DoInstall(customDir);
    }

    CoUninitialize();
    return 0;
}
