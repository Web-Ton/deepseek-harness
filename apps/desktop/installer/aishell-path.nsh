; AI Shell: register the `aishell` command on the user PATH (per-user,
; no elevation). Writes HKCU\Environment\Path, prepending an OUT-OF-INSTALL
; shim directory (D12 rev5, 2026-10-26). The shim (aishell.cmd) lives at
; $LOCALAPPDATA\Programs\aishell\bin\ and forwards to the real aishell.cmd
; shipped inside $INSTDIR\resources\runtime\cli\bin\ (where prepare-cli
; places it). PATH points at the shim dir, NOT the install dir.
;
; Why a shim outside the install dir (the cwd-lock incident,
; docs/win-upgrade-cwd-lock-incident.md §2.2): the NSIS upgrade swaps the
; install directory via MoveFileExW on the parent dir (dshPromoteDirectories).
; Windows fails that rename (error 5 ACCESS_DENIED) when ANY subprocess holds
; an open handle to a child of the renamed dir. External PATH-scanning
; processes (VS Code caches every PATH entry's directory handle at startup)
; therefore locked the install tree whenever PATH pointed inside it. Moving
; the PATH entry outside the install tree (shim dir) means those scanners can
; only ever hold the shim dir — the install tree's children stay free for the
; swap. D21 rev4's InstallerTerminateDirectoryProcesses is complementary: it
; reaps processes whose IMAGE is under the install dir; it cannot reap an
; external process (VS Code's image lives in Program Files) that merely holds
; a child-directory handle via PATH — only the shim eliminates that class.
;
; Design (aligns with Linux install.sh's ~/.local/bin prepend + the
; upstream command-path.ps1 registry approach):
;   - ReadRegStr/WriteRegStr go through the registry API directly, so
;     they are NOT capped by NSIS_MAX_STRLEN (1024) — user PATH can
;     exceed that. The upstream command-path.ps1 does the same.
;   - Idempotent: if the shim dir is already on PATH, skip the write.
;     The check is semicolon-aware and case-insensitive (NSIS string
;     compares are case-insensitive by default).
;   - An ownership marker (HKCU\Software\HuaweiCloudAIShell\Command\Directory)
;     records the exact directory we added, so uninstall removes only
;     that entry — not whatever happens to match today.
;   - The shim file is independently guarded: if it already exists the
;     install skips rewriting it. The shim forwards to a $INSTDIR-derived
;     ABSOLUTE path expanded at install time, and the install root
;     (%LOCALAPPDATA%\Programs\AI Shell) is path-stable across upgrades
;     (NSIS installs the same dir name; the old one is renamed .old-{GUID}),
;     so the shim's content is byte-stable across upgrades — a re-install
;     over a live VS Code holding the shim dir handle never conflicts on
;     the file write (it is skipped).
;   - WM_SETTINGCHANGE broadcast so new processes pick up the PATH;
;     already-running processes need a restart (Windows behavior).
;
; Included by installer.nsh via the D12 windows-aishell-command patch:
;   !include "${INSTALLER_SOURCE_DIR}\aishell-path.nsh"
;   !insertmacro InstallAishellCommand   (in customInstall)
;   !insertmacro un.RemoveAishellCommand (in customUnInstall)

!ifndef AISHELL_PATH_NSH
!define AISHELL_PATH_NSH

; ---------- install: write the shim + prepend its dir to user PATH ----------
!macro InstallAishellCommand
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $9
  ; Shim directory OUTSIDE the install tree (so external PATH scanners
  ; cannot lock any child of the install dir). Sibling of the AI Shell
  ; install dir under %LOCALAPPDATA%\Programs, user-scope, no elevation.
  StrCpy $0 "$LOCALAPPDATA\Programs\aishell\bin"
  ; The real command the shim forwards to (prepare-cli ships it here).
  ; Expanded at install time into an absolute path baked into the shim.
  StrCpy $6 "$INSTDIR\resources\runtime\cli\bin\aishell.cmd"

  ; --- shim file: ensure it exists (skip write if present) ---
  ; The shim content is forward-stable across upgrades (install root path
  ; is invariant), so rewriting it on every install would only risk a write
  ; conflict with a handle-holding scanner. Guard with IfFileExists.
  ${IfNot} ${FileExists} "$0\aishell.cmd"
    CreateDirectory "$0"
    ClearErrors
    FileOpen $9 "$0\aishell.cmd" w
    ${IfNot} ${Errors}
      FileWrite $9 "@echo off$\r$\n"
      ; $6 already holds the absolute real-cmd path (expanded above).
      ; $\" = an embedded double-quote (NSIS escape); % has no special
      ; meaning in NSIS string literals, so %* and %errorlevel% pass through.
      FileWrite $9 "call $\"$6$\" %*$\r$\n"
      FileWrite $9 "exit /b %errorlevel%$\r$\n"
      FileClose $9
    ${Else}
      ; Best-effort: a failed shim write is non-fatal — the PATH entry is
      ; still the right one and a future install retries. The real cmd
      ; remains usable directly from its install-dir location.
    ${EndIf}
  ${EndIf}

  ; --- PATH: prepend the shim dir if absent (idempotent) ---
  ReadRegStr $1 HKCU "Environment" "Path"
  StrCpy $2 "$1;"          ; trailing ';' so a sole/trailing segment matches
  StrCpy $3 ""             ; found flag
  StrLen $4 "$0;"
  StrLen $5 "$2"
  ${If} $5 >= $4
    StrCpy $R0 0
    ${Do}
      StrCpy $R1 "$2" $4 $R0
      ${If} $R1 == "$0;"
        StrCpy $3 "1"
        ${ExitDo}
      ${EndIf}
      IntOp $R0 $R0 + 1
      IntOp $R2 $5 - $R0
      ${If} $R2 < $4
        ${ExitDo}
      ${EndIf}
    ${Loop}
  ${EndIf}
  ${If} $3 == ""
    ; Not present: prepend (highest precedence, like Linux ~/.local/bin).
    WriteRegStr HKCU "Environment" "Path" "$0;$1"
    ; Ownership marker for clean uninstall (records the exact dir added).
    WriteRegStr HKCU "Software\HuaweiCloudAIShell\Command" "Directory" "$0"
  ${EndIf}
  ; Broadcast so new terminals/explorer pick up the changed PATH.
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=2000
  Pop $9
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

; ---------- uninstall: remove our shim dir + its PATH entry ----------
!macro un.RemoveAishellCommand
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  ; Read our ownership marker to find the directory we added (robust to
  ; the user changing $INSTDIR between install and uninstall — we remove
  ; what we actually put on PATH, not what $INSTDIR is now).
  ReadRegStr $0 HKCU "Software\HuaweiCloudAIShell\Command" "Directory"
  ${If} $0 != ""
    ReadRegStr $1 HKCU "Environment" "Path"
    ; Strip "$0;" or ";$0" from $1, rebuilding the string without our
    ; segment. Walk the semicolon-separated list, copying every segment
    ; that does not equal $0.
    StrCpy $2 ""          ; rebuilt PATH
    StrCpy $3 "$1;"       ; ensure trailing separator for uniform parsing
    StrCpy $4 0           ; cursor
    StrLen $5 "$3"
    ${Do}
      ; Find next ";" from cursor $4.
      StrCpy $6 -1
      ${For} $7 $4 $5
        StrCpy $R0 "$3" 1 $7
        ${If} $R0 == ";"
          StrCpy $6 $7
          ${ExitFor}
        ${EndIf}
      ${Next}
      ${If} $6 < 0
        ${ExitDo}
      ${EndIf}
      ; Segment is [$4, $6).
      IntOp $7 $6 - $4
      ${If} $7 > 0
        StrCpy $R0 "$3" $7 $4
        ${If} $R0 != "$0"
          ${If} $2 == ""
            StrCpy $2 "$R0"
          ${Else}
            StrCpy $2 "$2;$R0"
          ${EndIf}
        ${EndIf}
      ${EndIf}
      IntOp $4 $6 + 1
      ${If} $4 > $5
        ${ExitDo}
      ${EndIf}
    ${Loop}
    ; Write the cleaned PATH back (only if it changed).
    ${If} $2 != "$1"
      WriteRegStr HKCU "Environment" "Path" "$2"
    ${EndIf}
    ; Remove the shim file + its (now hopefully empty) directory.
    Delete "$0\aishell.cmd"
    RMDir "$0"
    ; Clean up our ownership marker.
    DeleteRegValue HKCU "Software\HuaweiCloudAIShell\Command" "Directory"
    DeleteRegKey /ifempty HKCU "Software\HuaweiCloudAIShell\Command"
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=2000
  ${EndIf}
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!endif ; AISHELL_PATH_NSH
