#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wchar.h>

/* Hancom automation calls this export before opening/saving a file. The DLL is
   installed beside the private jobs directory. Only the three fixed job paths are valid. */
static HMODULE self;
BOOL WINAPI DllMain(HINSTANCE module, DWORD event, LPVOID reserved) {
    if (event == DLL_PROCESS_ATTACH) self = module;
    return TRUE;
}

static BOOL plain_directory(const WCHAR *path) {
    DWORD attr = GetFileAttributesW(path);
    return attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY)
        && !(attr & FILE_ATTRIBUTE_REPARSE_POINT);
}

__declspec(dllexport) BOOL __stdcall IsAccessiblePath(HWND owner, LONG id, const WCHAR *path, const WCHAR *site) {
    WCHAR prefix[MAX_PATH];
    DWORD length = GetModuleFileNameW(self, prefix, MAX_PATH);
    if (!path || !length || length >= MAX_PATH || !wcschr(prefix, L'\\')) return FALSE;
    *wcsrchr(prefix, L'\\') = 0;
    if (!plain_directory(prefix) || wcslen(prefix) + 48 >= MAX_PATH) return FALSE;
    wcscat(prefix, L"\\jobs");
    if (!plain_directory(prefix)) return FALSE;
    wcscat(prefix, L"\\");
    int n = (int)wcslen(prefix);
    if (wcslen(path) < (size_t)n + 33 || CompareStringOrdinal(path, n, prefix, n, TRUE) != CSTR_EQUAL) return FALSE;
    const WCHAR *job = path + n;
    for (int i = 0; i < 32; ++i) {
        WCHAR c = job[i];
        if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'))) return FALSE;
    }
    if (lstrcmpiW(job + 32, L"\\input.hwp") && lstrcmpiW(job + 32, L"\\input.hwpx")
        && lstrcmpiW(job + 32, L"\\output.pdf")) return FALSE;
    wcsncat(prefix, job, 32);
    if (!plain_directory(prefix)) return FALSE;
    DWORD attr = GetFileAttributesW(path);
    return attr == INVALID_FILE_ATTRIBUTES || !(attr & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY));
}
