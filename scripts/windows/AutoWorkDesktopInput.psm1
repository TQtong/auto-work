Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function New-AutoWorkNativeType {
    $existing = [Type]::GetType('AutoWorkDesktopNative', $false)
    if ($existing) { return $existing }
    $assemblyName = New-Object System.Reflection.AssemblyName('AutoWorkDesktopNativeAssembly')
    $assemblyBuilder = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
        $assemblyName,
        [System.Reflection.Emit.AssemblyBuilderAccess]::Run
    )
    $moduleBuilder = $assemblyBuilder.DefineDynamicModule('AutoWorkDesktopNativeModule')
    $typeBuilder = $moduleBuilder.DefineType(
        'AutoWorkDesktopNative',
        [System.Reflection.TypeAttributes]'Public,Sealed,Abstract'
    )
    $attributes = [System.Reflection.MethodAttributes]'Public,Static,PinvokeImpl'
    $calling = [System.Reflection.CallingConventions]::Standard
    $nativeCalling = [System.Runtime.InteropServices.CallingConvention]::Winapi
    $charset = [System.Runtime.InteropServices.CharSet]::Auto
    $definitions = @(
        @('SetForegroundWindow', [bool], @([IntPtr])),
        @('ShowWindow', [bool], @([IntPtr], [int])),
        @('IsIconic', [bool], @([IntPtr])),
        @('IsZoomed', [bool], @([IntPtr])),
        @('GetForegroundWindow', [IntPtr], @()),
        @('GetWindowThreadProcessId', [uint32], @([IntPtr], [IntPtr])),
        @('GetCurrentThreadId', [uint32], @(), 'kernel32.dll'),
        @('AttachThreadInput', [bool], @([uint32], [uint32], [bool])),
        @('BringWindowToTop', [bool], @([IntPtr])),
        @('SetActiveWindow', [IntPtr], @([IntPtr])),
        @('SetFocus', [IntPtr], @([IntPtr])),
        @('keybd_event', [void], @([byte], [byte], [uint32], [UIntPtr])),
        @('SetCursorPos', [bool], @([int], [int])),
        @('mouse_event', [void], @([uint32], [uint32], [uint32], [uint32], [UIntPtr]))
    )
    foreach ($definition in $definitions) {
        $library = if ($definition.Count -gt 3) { [string]$definition[3] } else { 'user32.dll' }
        $method = $typeBuilder.DefinePInvokeMethod(
            [string]$definition[0],
            $library,
            $attributes,
            $calling,
            [Type]$definition[1],
            [Type[]]$definition[2],
            $nativeCalling,
            $charset
        )
        $method.SetImplementationFlags(
            $method.GetMethodImplementationFlags() -bor [System.Reflection.MethodImplAttributes]::PreserveSig
        )
    }
    return $typeBuilder.CreateType()
}

$script:NativeType = New-AutoWorkNativeType

function Show-AutoWorkWindow([IntPtr]$Handle) {
    if ($Handle -eq [IntPtr]::Zero) { return $false }
    $native = $script:NativeType
    # SW_RESTORE (9) restores a maximized window to its previous normal size. That changes
    # DingTalk's responsive layout and invalidates all OCR coordinates. Only restore an
    # actually minimized window, then ensure the main window is maximized. If it is already
    # maximized, do not call ShowWindow at all.
    $isMinimized = [bool]$native.GetMethod('IsIconic').Invoke($null, @($Handle))
    if ($isMinimized) {
        $native.GetMethod('ShowWindow').Invoke($null, @($Handle, 9)) | Out-Null
        Start-Sleep -Milliseconds 180
    }
    $isMaximized = [bool]$native.GetMethod('IsZoomed').Invoke($null, @($Handle))
    if (-not $isMaximized) {
        $native.GetMethod('ShowWindow').Invoke($null, @($Handle, 3)) | Out-Null
        Start-Sleep -Milliseconds 250
    }

    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        $foreground = [IntPtr]$native.GetMethod('GetForegroundWindow').Invoke($null, @())
        if ($foreground -eq $Handle) { return $true }

        $currentThread = [uint32]$native.GetMethod('GetCurrentThreadId').Invoke($null, @())
        $foregroundThread = if ($foreground -ne [IntPtr]::Zero) {
            [uint32]$native.GetMethod('GetWindowThreadProcessId').Invoke($null, @($foreground, [IntPtr]::Zero))
        } else { [uint32]0 }
        $targetThread = [uint32]$native.GetMethod('GetWindowThreadProcessId').Invoke(
            $null,
            @($Handle, [IntPtr]::Zero)
        )
        $attachedForeground = $false
        $attachedTarget = $false
        try {
            if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
                $attachedForeground = [bool]$native.GetMethod('AttachThreadInput').Invoke(
                    $null,
                    @($currentThread, $foregroundThread, $true)
                )
            }
            if ($targetThread -ne 0 -and $targetThread -ne $currentThread) {
                $attachedTarget = [bool]$native.GetMethod('AttachThreadInput').Invoke(
                    $null,
                    @($currentThread, $targetThread, $true)
                )
            }

            # Windows may reject SetForegroundWindow for a background process. A synthetic Alt
            # transition plus attached input queues gives this interactive user process a legal
            # foreground transition without using a global hotkey or hard-coded window order.
            $keybd = $native.GetMethod('keybd_event')
            $null = $keybd.Invoke($null, @([byte]0x12, [byte]0, [uint32]0, [UIntPtr]::Zero))
            $null = $keybd.Invoke(
                $null,
                @([byte]0x12, [byte]0, [uint32]0x0002, [UIntPtr]::Zero)
            )
            $native.GetMethod('BringWindowToTop').Invoke($null, @($Handle)) | Out-Null
            $native.GetMethod('SetActiveWindow').Invoke($null, @($Handle)) | Out-Null
            $native.GetMethod('SetFocus').Invoke($null, @($Handle)) | Out-Null
            $native.GetMethod('SetForegroundWindow').Invoke($null, @($Handle)) | Out-Null
        } finally {
            if ($attachedTarget) {
                $native.GetMethod('AttachThreadInput').Invoke(
                    $null,
                    @($currentThread, $targetThread, $false)
                ) | Out-Null
            }
            if ($attachedForeground) {
                $native.GetMethod('AttachThreadInput').Invoke(
                    $null,
                    @($currentThread, $foregroundThread, $false)
                ) | Out-Null
            }
        }
        Start-Sleep -Milliseconds 200
    }

    return [IntPtr]$native.GetMethod('GetForegroundWindow').Invoke($null, @()) -eq $Handle
}

function Invoke-AutoWorkClick([int]$X, [int]$Y) {
    $script:NativeType.GetMethod('SetCursorPos').Invoke($null, @($X, $Y)) | Out-Null
    $mouse = $script:NativeType.GetMethod('mouse_event')
    $null = $mouse.Invoke(
        $null,
        @([uint32]0x0002, [uint32]0, [uint32]0, [uint32]0, [UIntPtr]::Zero)
    )
    $null = $mouse.Invoke(
        $null,
        @([uint32]0x0004, [uint32]0, [uint32]0, [uint32]0, [UIntPtr]::Zero)
    )
}

function Set-AutoWorkWindowMinimized([IntPtr]$Handle) {
    if ($Handle -eq [IntPtr]::Zero) { return $false }
    $script:NativeType.GetMethod('ShowWindow').Invoke($null, @($Handle, 6)) | Out-Null
    return $true
}

Export-ModuleMember -Function Show-AutoWorkWindow, Set-AutoWorkWindowMinimized, Invoke-AutoWorkClick
