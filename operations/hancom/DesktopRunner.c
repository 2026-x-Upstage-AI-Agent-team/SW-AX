#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

/* No SwitchDesktop: conversion windows must never enter the input desktop. */
int wmain(void) {
    DWORD result = 1;
    HANDLE job = NULL;
    HDESK desktop = NULL;
    PROCESS_INFORMATION child = {0};
    STARTUPINFOW startup = {0};
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    WCHAR name[96];
    WCHAR *args = GetCommandLineW(), *command = NULL;
    if (*args == L'"') {
        args = wcschr(args + 1, L'"');
        if (!args) return 1;
        ++args;
    } else {
        while (*args && *args != L' ' && *args != L'\t') ++args;
    }
    while (*args == L' ' || *args == L'\t') ++args;
    if (!*args) return 1;
    command = _wcsdup(args);
    if (!command) return 1;
    swprintf(name, 96, L"SWAX-Hancom-%lu-%llu", GetCurrentProcessId(), GetTickCount64());
    desktop = CreateDesktopW(name, NULL, NULL, 0,
        DESKTOP_CREATEWINDOW | DESKTOP_READOBJECTS | DESKTOP_WRITEOBJECTS | DESKTOP_ENUMERATE, NULL);
    if (!desktop || !SetEnvironmentVariableW(L"SWAX_HANCOM_DESKTOP", name)) goto failed;
    job = CreateJobObjectW(NULL, NULL);
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
    if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) goto failed;
    startup.cb = sizeof(startup);
    startup.lpDesktop = name;
    startup.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
    startup.wShowWindow = SW_HIDE;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    if (!CreateProcessW(NULL, command, NULL, NULL, TRUE, CREATE_NO_WINDOW | CREATE_SUSPENDED,
            NULL, NULL, &startup, &child)) goto failed;
    if (!AssignProcessToJobObject(job, child.hProcess) || ResumeThread(child.hThread) == (DWORD)-1) goto failed;
    if (WaitForSingleObject(child.hProcess, INFINITE) != WAIT_OBJECT_0 || !GetExitCodeProcess(child.hProcess, &result)) goto failed;
    goto cleanup;
failed:
    result = 1;
    fwprintf(stderr, L"Private conversion desktop failed (Windows error %lu).\n", GetLastError());
    if (child.hProcess) TerminateProcess(child.hProcess, 1);
cleanup:
    if (child.hThread) CloseHandle(child.hThread);
    if (job) CloseHandle(job);
    if (child.hProcess) {
        WaitForSingleObject(child.hProcess, 10000);
        CloseHandle(child.hProcess);
    }
    if (desktop) CloseDesktop(desktop);
    free(command);
    return (int)result;
}
