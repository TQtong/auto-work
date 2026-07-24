Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$script:OcrScreenshotPath = $null
Import-Module (Join-Path $PSScriptRoot 'AutoWorkDesktopInput.psm1') -Force

function Write-Result([hashtable]$Result) {
    try {
        $parent = Split-Path -Parent $OutputPath
        if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        $json = $Result | ConvertTo-Json -Depth 12 -Compress
        $temporary = "$OutputPath.$PID.tmp"
        [System.IO.File]::WriteAllText($temporary, $json, [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $OutputPath -Force
    } finally {
        if (Get-Variable -Name ClipboardUsed -Scope Script -ErrorAction SilentlyContinue) {
            try { [System.Windows.Forms.Clipboard]::Clear() } catch { }
            Remove-Variable -Name ClipboardUsed -Scope Script -ErrorAction SilentlyContinue
        }
        if ($script:OcrScreenshotPath) {
            Remove-Item -LiteralPath $script:OcrScreenshotPath -Force -ErrorAction SilentlyContinue
            $script:OcrScreenshotPath = $null
        }
    }
}

function Normalize-Text([object]$Value) {
    if ($null -eq $Value) { return '' }
    return ([string]$Value -replace '\s+', '').Trim().ToLowerInvariant()
}

function Get-ConfigValue([object]$Object, [string]$Name, [object]$Default = $null) {
    if ($null -ne $Object -and $Object.PSObject.Properties.Name -contains $Name) {
        return $Object.$Name
    }
    return $Default
}

function Test-TextMatch([string]$Actual, [string[]]$Expected, [switch]$Contains) {
    $normalized = Normalize-Text $Actual
    foreach ($value in $Expected) {
        $candidate = Normalize-Text $value
        if (-not $candidate) { continue }
        if (($Contains -and $normalized.Contains($candidate)) -or (-not $Contains -and $normalized -eq $candidate)) {
            return $true
        }
    }
    return $false
}

function Get-DingTalkExecutable([object]$Request) {
    $configured = [string](Get-ConfigValue $Request 'executablePath' '')
    if ($configured) {
        if ([System.IO.Path]::GetFileName($configured) -notin @('DingTalk.exe', 'DingTalkLauncher.exe', 'DingTalkApp.exe')) {
            throw 'DINGTALK_DESKTOP_EXECUTABLE_INVALID|客户端路径必须指向钉钉官方可执行文件'
        }
        if (-not (Test-Path -LiteralPath $configured -PathType Leaf)) {
            throw 'DINGTALK_DESKTOP_EXECUTABLE_NOT_FOUND|配置的钉钉客户端路径不存在'
        }
        return $configured
    }
    $runningPath = Get-Process -Name 'DingTalk', 'DingTalkLauncher', 'DingTalkApp' -ErrorAction SilentlyContinue |
        ForEach-Object { try { $_.Path } catch { $null } } |
        Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
        Select-Object -First 1
    if ($runningPath) { return $runningPath }
    $registeredPaths = @(
        (Get-ItemPropertyValue -LiteralPath 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\DingTalk.exe' -Name '(default)' -ErrorAction SilentlyContinue),
        (Get-ItemPropertyValue -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths\DingTalk.exe' -Name '(default)' -ErrorAction SilentlyContinue)
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
    if ($registeredPaths.Count -gt 0) { return $registeredPaths | Select-Object -First 1 }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'DingTalk\main\current\DingTalk.exe'),
        (Join-Path $env:LOCALAPPDATA 'DingTalk\main\current_new\DingTalk.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\DingTalk\DingTalk.exe'),
        (Join-Path $env:ProgramFiles 'DingTalk\DingTalk.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'DingTalk\DingTalk.exe')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
    return $candidates | Select-Object -First 1
}

function Get-DingTalkProcess {
    $names = @('DingTalk', 'DingTalkLauncher', 'DingTalkApp')
    return Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $names -contains $_.ProcessName -and $_.MainWindowHandle -ne 0 } |
        Sort-Object StartTime |
        Select-Object -Last 1
}

function Minimize-DingTalkImagePreviews([System.Diagnostics.Process]$Process) {
    $desktopWindows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    foreach ($window in $desktopWindows) {
        try {
            if (
                $window.Current.ProcessId -eq $Process.Id -and
                $window.Current.ClassName -eq 'DingImgViewWnd' -and
                $window.Current.NativeWindowHandle -ne 0
            ) {
                Set-AutoWorkWindowMinimized -Handle ([IntPtr]$window.Current.NativeWindowHandle) | Out-Null
            }
        } catch {
            # The preview may disappear while enumerating. The main window activation below is
            # still authoritative and will fail safely if another window remains in the way.
        }
    }
}

function Get-DingTalkRoot([object]$Request, [int]$TimeoutSeconds) {
    $process = Get-DingTalkProcess
    if (-not $process) {
        $executable = Get-DingTalkExecutable $Request
        if (-not $executable) { throw 'DINGTALK_DESKTOP_EXECUTABLE_NOT_FOUND|未找到钉钉桌面客户端，请先安装或配置客户端路径' }
        Start-Process -FilePath $executable | Out-Null
    }
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $process = Get-DingTalkProcess
        if ($process -and $process.MainWindowHandle -ne 0) {
            Minimize-DingTalkImagePreviews $process
            if (-not (Show-AutoWorkWindow -Handle $process.MainWindowHandle)) {
                throw 'DINGTALK_DESKTOP_ACTIVATION_FAILED|无法将钉钉切换到前台；为避免操作错误窗口，已安全停止'
            }
            Start-Sleep -Milliseconds 500
            return @{
                Process = $process
                Root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
            }
        }
        Start-Sleep -Milliseconds 300
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw 'DINGTALK_DESKTOP_WINDOW_NOT_FOUND|钉钉已启动但找不到可交互主窗口'
}

function Get-AllElements([System.Windows.Automation.AutomationElement]$Root) {
    return $Root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )
}

function Find-AutomationIdElement(
    [System.Windows.Automation.AutomationElement]$Root,
    [string[]]$AutomationIds,
    [switch]$Contains,
    [System.Windows.Automation.ControlType[]]$ControlTypes = @()
) {
    foreach ($element in (Get-AllElements $Root)) {
        try {
            if ($ControlTypes.Count -gt 0 -and $ControlTypes -notcontains $element.Current.ControlType) { continue }
            $actual = [string]$element.Current.AutomationId
            foreach ($expected in $AutomationIds) {
                if (($Contains -and $actual.Contains($expected)) -or (-not $Contains -and $actual -eq $expected)) {
                    return $element
                }
            }
        } catch { continue }
    }
    return $null
}

function Find-NamedElement(
    [System.Windows.Automation.AutomationElement]$Root,
    [string[]]$Names,
    [switch]$Contains,
    [System.Windows.Automation.ControlType[]]$ControlTypes = @()
) {
    foreach ($element in (Get-AllElements $Root)) {
        try {
            if ($ControlTypes.Count -gt 0 -and $ControlTypes -notcontains $element.Current.ControlType) { continue }
            if (Test-TextMatch $element.Current.Name $Names -Contains:$Contains) { return $element }
        } catch { continue }
    }
    return $null
}

function Show-Element([System.Windows.Automation.AutomationElement]$Element) {
    if (-not $Element) { return }
    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern, [ref]$pattern)) {
        try { ([System.Windows.Automation.ScrollItemPattern]$pattern).ScrollIntoView() } catch { }
    }
    try { $Element.SetFocus() } catch { }
    Start-Sleep -Milliseconds 120
}

function Invoke-Element([System.Windows.Automation.AutomationElement]$Element) {
    if (-not $Element) { return $false }
    Show-Element $Element
    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
        return $true
    }
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
        ([System.Windows.Automation.SelectionItemPattern]$pattern).Select()
        return $true
    }
    try {
        $rectangle = $Element.Current.BoundingRectangle
        if ($rectangle.Width -le 0 -or $rectangle.Height -le 0) { return $false }
        $x = [int]($rectangle.Left + [Math]::Min($rectangle.Width / 2, 120))
        $y = [int]($rectangle.Top + $rectangle.Height / 2)
        Invoke-AutoWorkClick -X $x -Y $y
        return $true
    } catch { return $false }
}

function Wait-NamedElement(
    [System.Windows.Automation.AutomationElement]$Root,
    [string[]]$Names,
    [int]$TimeoutSeconds,
    [switch]$Contains,
    [System.Windows.Automation.ControlType[]]$ControlTypes = @()
) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $found = Find-NamedElement $Root $Names -Contains:$Contains -ControlTypes $ControlTypes
        if ($found) { return $found }
        Start-Sleep -Milliseconds 300
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    return $null
}

function Invoke-NavigationStep(
    [System.Windows.Automation.AutomationElement]$Root,
    [string[]]$Names,
    [int]$TimeoutSeconds,
    [string]$ErrorCode,
    [string]$ErrorMessage
) {
    $element = Wait-NamedElement $Root $Names $TimeoutSeconds -Contains
    if (-not $element -or -not (Invoke-Element $element)) { throw "$ErrorCode|$ErrorMessage" }
    Start-Sleep -Milliseconds 900
}

function Get-FieldLabels([object]$Request) {
    $custom = Get-ConfigValue $Request 'fieldLabels' $null
    if ($custom) {
        return @(
            @([string]$custom.reportDate),
            @([string]$custom.recentGoals),
            @([string]$custom.weeklyWork),
            @([string]$custom.nextWeekPlans),
            @([string]$custom.problems),
            @([string]$custom.other)
        )
    }
    return @(
        @('周报填写日期', '填写日期', 'Report date', 'Weekly report date'),
        @('近期工作目标', 'Recent work goals', 'Recent goals', 'Recent work objectives'),
        @(
            '本周工作内容（当前迭代任务及完成情况）',
            '本周工作内容',
            'Work completed this week',
            "This week's work",
            'Work this week'
        ),
        @('下周工作计划', 'Next week plan', "Next week's work plan", 'Next week work plan'),
        @(
            '需要协助或存在的问题',
            '需要协助',
            'Problems requiring assistance',
            'Assistance needed or existing problems',
            'Problems and risks'
        ),
        @('其他补充', 'Other notes', 'Additional notes', 'Other')
    )
}

function Get-InputCandidates([System.Windows.Automation.AutomationElement]$Root) {
    $types = @(
        [System.Windows.Automation.ControlType]::Edit,
        [System.Windows.Automation.ControlType]::Document,
        [System.Windows.Automation.ControlType]::ComboBox,
        [System.Windows.Automation.ControlType]::Custom
    )
    $items = @()
    foreach ($element in (Get-AllElements $Root)) {
        try {
            if ($types -notcontains $element.Current.ControlType -or -not $element.Current.IsEnabled) { continue }
            if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Custom) {
                $valuePattern = $null
                $textPattern = $null
                $supportsValue = $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)
                $supportsText = $element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)
                if (-not $supportsValue -and -not $supportsText) { continue }
            }
            $rect = $element.Current.BoundingRectangle
            if ($rect.Width -lt 35 -or $rect.Height -lt 18) { continue }
            $items += [pscustomobject]@{ Element = $element; Rect = $rect }
        } catch { continue }
    }
    return $items
}

function Find-InputForLabel(
    [System.Windows.Automation.AutomationElement]$Root,
    [System.Windows.Automation.AutomationElement]$Label,
    [System.Collections.Generic.HashSet[string]]$Used
) {
    $labelRect = $Label.Current.BoundingRectangle
    $ranked = Get-InputCandidates $Root | ForEach-Object {
        $rect = $_.Rect
        $runtimeId = [string]::Join('.', $_.Element.GetRuntimeId())
        if ($Used.Contains($runtimeId)) { return }
        $vertical = $rect.Top - $labelRect.Bottom
        if ($vertical -lt -8 -or $vertical -gt 240) { return }
        $horizontalPenalty = if ($rect.Right -lt $labelRect.Left - 20) { 1000 } else { [Math]::Abs($rect.Left - $labelRect.Left) / 8 }
        [pscustomobject]@{ Element = $_.Element; RuntimeId = $runtimeId; Score = $vertical + $horizontalPenalty; Rect = $rect }
    } | Sort-Object Score
    return $ranked | Select-Object -First 1
}

function Set-ElementValue([System.Windows.Automation.AutomationElement]$Element, [string]$Value) {
    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        try {
            ([System.Windows.Automation.ValuePattern]$pattern).SetValue($Value)
            return $true
        } catch { }
    }
    if (-not (Invoke-Element $Element)) { return $false }
    Start-Sleep -Milliseconds 150
    [System.Windows.Forms.Clipboard]::SetText($Value)
    Set-Variable -Name ClipboardUsed -Scope Script -Value $true
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    return $true
}

function Find-TemplateThroughGlobalSearch(
    [System.Windows.Automation.AutomationElement]$Root,
    [string]$Template,
    [int]$TimeoutSeconds
) {
    $searchButton = Find-AutomationIdElement $Root @('search_btn') -Contains
    if (-not $searchButton) {
        $searchButton = Find-NamedElement $Root @('搜索', 'Search') -Contains
    }
    if (-not $searchButton -or -not (Invoke-Element $searchButton)) { return $null }
    Start-Sleep -Milliseconds 350

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds([Math]::Min($TimeoutSeconds, 8))
    $searchEdit = $null
    do {
        $searchEdit = Find-AutomationIdElement $Root @('search_edit') -Contains -ControlTypes @([System.Windows.Automation.ControlType]::Edit)
        if ($searchEdit -and $searchEdit.Current.IsEnabled) { break }
        $searchEdit = Find-NamedElement $Root @('搜索', 'Search') -Contains -ControlTypes @([System.Windows.Automation.ControlType]::Edit)
        if ($searchEdit -and $searchEdit.Current.IsEnabled) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    if (-not $searchEdit -or -not $searchEdit.Current.IsEnabled) { return $null }
    Show-Element $searchEdit
    if (-not (Set-ElementValue $searchEdit $Template)) { return $null }
    Show-Element $searchEdit
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Milliseconds 900

    return Wait-NamedElement $Root @($Template) ([Math]::Min($TimeoutSeconds, 10)) -Contains -ControlTypes @(
        [System.Windows.Automation.ControlType]::Button,
        [System.Windows.Automation.ControlType]::ListItem,
        [System.Windows.Automation.ControlType]::Text,
        [System.Windows.Automation.ControlType]::Hyperlink,
        [System.Windows.Automation.ControlType]::Custom
    )
}

function Resolve-Form([System.Windows.Automation.AutomationElement]$Root, [object]$Request, [switch]$SetValues) {
    $labels = Get-FieldLabels $Request
    $values = @(
        [string](Get-ConfigValue $Request 'reportDate' ''),
        [string](Get-ConfigValue $Request 'recentGoals' ''),
        [string](Get-ConfigValue $Request 'weeklyWork' ''),
        [string](Get-ConfigValue $Request 'nextWeekPlans' ''),
        [string](Get-ConfigValue $Request 'problems' ''),
        [string](Get-ConfigValue $Request 'other' '')
    )
    $observed = @()
    $used = [System.Collections.Generic.HashSet[string]]::new()
    for ($index = 0; $index -lt $labels.Count; $index += 1) {
        $label = Wait-NamedElement $Root $labels[$index] 4 -Contains
        if (-not $label) { throw "DINGTALK_DESKTOP_FIELD_NOT_FOUND|找不到第 $($index + 1) 个周报字段：$($labels[$index][0])" }
        Show-Element $label
        $observed += $label.Current.Name
        # A submitted report detail page also shows the six labels. Requiring one unique,
        # enabled input after every label prevents a read-only detail page from passing probe.
        $candidate = Find-InputForLabel $Root $label $used
        if (-not $candidate) { throw "DINGTALK_DESKTOP_INPUT_NOT_FOUND|找不到字段输入控件：$($label.Current.Name)" }
        $used.Add($candidate.RuntimeId) | Out-Null
        if ($SetValues) {
            if (-not (Set-ElementValue $candidate.Element $values[$index])) { throw "DINGTALK_DESKTOP_INPUT_FAILED|无法填写字段：$($label.Current.Name)" }
            Start-Sleep -Milliseconds 180
        }
    }
    return $observed
}

function Save-WindowScreenshot([System.Diagnostics.Process]$Process, [string]$Directory, [string]$Name) {
    if (-not $Directory) { return $null }
    if (-not (Show-AutoWorkWindow -Handle $Process.MainWindowHandle)) {
        throw 'DINGTALK_DESKTOP_ACTIVATION_FAILED|OCR 前无法保持钉钉最大化并切换到前台，已安全停止'
    }
    New-Item -ItemType Directory -Force -Path $Directory | Out-Null
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Process.MainWindowHandle)
    $rect = $root.Current.BoundingRectangle
    if ($rect.Width -le 0 -or $rect.Height -le 0) { return $null }
    $path = Join-Path $Directory "$Name.png"
    $bitmap = [System.Drawing.Bitmap]::new([int]$rect.Width, [int]$rect.Height)
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try { $graphics.CopyFromScreen([int]$rect.Left, [int]$rect.Top, 0, 0, $bitmap.Size) }
        finally { $graphics.Dispose() }
        $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $bitmap.Dispose() }
    return $path
}

$script:AsTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1

function Wait-WinRtOperation([object]$Operation, [Type]$ResultType) {
    $task = $script:AsTaskMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.Wait()
    return $task.Result
}

function Get-OcrEngines {
    $engines = @()
    foreach ($languageTag in @('en-US', 'zh-Hans-CN')) {
        try {
            $language = [Windows.Globalization.Language]::new($languageTag)
            $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
            if ($engine) { $engines += $engine }
        } catch { continue }
    }
    $profileEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($profileEngine) { $engines += $profileEngine }
    if ($engines.Count -eq 0) {
        throw 'DINGTALK_DESKTOP_OCR_UNAVAILABLE|Windows OCR 不可用，请安装英文或简体中文 OCR 语言包'
    }
    return $engines
}

function Get-OcrEngine {
    return @(Get-OcrEngines)[0]
}

function Get-OcrResults([object]$Snapshot) {
    if ($Snapshot.PSObject.Properties['Results']) { return @($Snapshot.Results) }
    return @($Snapshot.Result)
}

function Get-WindowOcrSnapshot([System.Diagnostics.Process]$Process) {
    $directory = Join-Path ([System.IO.Path]::GetTempPath()) 'auto-work-dingtalk-ocr'
    $path = Save-WindowScreenshot $Process $directory "window-$PID"
    $script:OcrScreenshotPath = $path
    $file = Wait-WinRtOperation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Wait-WinRtOperation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $decoder = Wait-WinRtOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Wait-WinRtOperation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        try {
            $results = @(
                foreach ($engine in @(Get-OcrEngines)) {
                    Wait-WinRtOperation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
                }
            )
        }
        finally { if ($bitmap) { $bitmap.Dispose() } }
    } finally { if ($stream) { $stream.Dispose() } }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Process.MainWindowHandle)
    return [pscustomobject]@{
        Result = $results[0]
        Results = $results
        Text = [string](($results | ForEach-Object { $_.Text }) -join "`n")
        WindowRect = $root.Current.BoundingRectangle
        ScreenshotPath = $path
    }
}

function Get-OcrHits([object]$Snapshot, [string[]]$Names, [switch]$Exact) {
    $hits = @()
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($line in @(Get-OcrResults $Snapshot | ForEach-Object { $_.Lines })) {
        $lineText = [string]$line.Text
        $normalizedLine = Normalize-Text $lineText
        $matched = $false
        foreach ($name in $Names) {
            $normalizedName = Normalize-Text $name
            if (-not $normalizedName) { continue }
            if (($Exact -and $normalizedLine -eq $normalizedName) -or (-not $Exact -and $normalizedLine.Contains($normalizedName))) {
                $matched = $true
                break
            }
        }
        if (-not $matched -or @($line.Words).Count -eq 0) { continue }
        $left = ($line.Words | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
        $top = ($line.Words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
        $right = ($line.Words | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
        $bottom = ($line.Words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
        $key = "$(Normalize-Text $lineText)|$([Math]::Round($left / 4))|$([Math]::Round($top / 4))"
        if (-not $seen.Add($key)) { continue }
        $hits += [pscustomobject]@{
            Text = $lineText
            Left = [double]$left
            Top = [double]$top
            Right = [double]$right
            Bottom = [double]$bottom
            Width = [double]($right - $left)
            Height = [double]($bottom - $top)
        }
    }
    return $hits
}

function Get-OcrWordHits([object]$Snapshot, [string[]]$Names) {
    $hits = @()
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($line in @(Get-OcrResults $Snapshot | ForEach-Object { $_.Lines })) {
        foreach ($word in $line.Words) {
            if (-not (Test-TextMatch ([string]$word.Text) $Names)) { continue }
            $rect = $word.BoundingRect
            $key = "$(Normalize-Text ([string]$word.Text))|$([Math]::Round($rect.X / 4))|$([Math]::Round($rect.Y / 4))"
            if (-not $seen.Add($key)) { continue }
            $hits += [pscustomobject]@{
                Text = [string]$word.Text
                Left = [double]$rect.X
                Top = [double]$rect.Y
                Right = [double]($rect.X + $rect.Width)
                Bottom = [double]($rect.Y + $rect.Height)
                Width = [double]$rect.Width
                Height = [double]$rect.Height
            }
        }
    }
    return $hits
}

function Find-OcrHit([object]$Snapshot, [string[]]$Names, [switch]$Exact) {
    return Get-OcrHits $Snapshot $Names -Exact:$Exact | Select-Object -First 1
}

function Test-OcrText([object]$Snapshot, [string[]]$Names) {
    $actual = Normalize-Text $Snapshot.Text
    foreach ($name in $Names) {
        $expected = Normalize-Text $name
        if ($expected -and $actual.Contains($expected)) { return $true }
    }
    return $false
}

function Invoke-WindowPoint([object]$Snapshot, [double]$X, [double]$Y) {
    $screenX = [int]($Snapshot.WindowRect.Left + $X)
    $screenY = [int]($Snapshot.WindowRect.Top + $Y)
    Invoke-AutoWorkClick -X $screenX -Y $screenY
    Start-Sleep -Milliseconds 180
}

function Invoke-OcrHit([object]$Snapshot, [object]$Hit) {
    if (-not $Hit) { return $false }
    Invoke-WindowPoint $Snapshot ($Hit.Left + ($Hit.Width / 2)) ($Hit.Top + ($Hit.Height / 2))
    return $true
}

function Wait-OcrHit(
    [System.Diagnostics.Process]$Process,
    [string[]]$Names,
    [int]$TimeoutSeconds,
    [switch]$Exact
) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $snapshot = Get-WindowOcrSnapshot $Process
        $hit = Find-OcrHit $snapshot $Names -Exact:$Exact
        if ($hit) { return [pscustomobject]@{ Snapshot = $snapshot; Hit = $hit } }
        Start-Sleep -Milliseconds 350
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    return $null
}

function Test-OcrReportForm([object]$Snapshot, [string]$Template) {
    return (Test-OcrText $Snapshot @($Template)) -and
        (Test-OcrText $Snapshot @('周报填写日期', '近期工作目标', '本周工作内容', '下周工作计划', '需要协助或存在的问题', '其他补充', 'Choose time', 'Please enter'))
}

function Move-OcrReportFormToTop([System.Diagnostics.Process]$Process, [object]$Snapshot) {
    Invoke-WindowPoint $Snapshot ($Snapshot.WindowRect.Width * 0.72) ($Snapshot.WindowRect.Height * 0.50)
    [System.Windows.Forms.SendKeys]::SendWait('^{HOME}')
    Start-Sleep -Milliseconds 500
    return Get-WindowOcrSnapshot $Process
}

function Open-ReportFormWithOcr([System.Diagnostics.Process]$Process, [object]$Request, [int]$TimeoutSeconds) {
    $organization = [string](Get-ConfigValue $Request 'organizationName' '')
    $template = [string](Get-ConfigValue $Request 'templateName' '')
    if (-not $organization -or -not $template) { throw 'DINGTALK_DESKTOP_CONFIGURATION_REQUIRED|必须配置公司名称和周报模板名称' }

    $snapshot = Get-WindowOcrSnapshot $Process
    $organizationVisible = Test-OcrText $snapshot @($organization)
    if (-not $organizationVisible) {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($Process.MainWindowHandle)
        $organizationVisible = $null -ne (Find-NamedElement $root @($organization) -Contains)
    }
    if (-not $organizationVisible) {
        throw "DINGTALK_DESKTOP_ORGANIZATION_NOT_VISIBLE|当前钉钉客户端中未识别到公司：$organization"
    }
    if (Test-OcrReportForm $snapshot $template) { return }
    if (Test-OcrText $snapshot @('Submit', '提交')) {
        $snapshot = Move-OcrReportFormToTop $Process $snapshot
        if (Test-OcrReportForm $snapshot $template) { return }
    }

    # 固定按真实桌面路径进入，不能点击左侧“最近使用”里的 Create/Report，
    # 否则会落到应用中心或错误的日志入口。
    # 英文界面常把左侧图标识别成同一行的“00 Workplace”，因此优先点击
    # 单词级命中，不能要求整行必须恰好等于 Workplace。
    $workplace = Get-OcrWordHits $snapshot @('Workplace', '工作台') |
        Sort-Object Top, Left |
        Select-Object -First 1
    if ($workplace) {
        Invoke-OcrHit $snapshot $workplace | Out-Null
    } else {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($Process.MainWindowHandle)
        $workplaceElement = Find-NamedElement $root @('Workplace', '工作台') -Contains
        if (-not $workplaceElement -or -not (Invoke-Element $workplaceElement)) {
            throw 'DINGTALK_DESKTOP_WORKPLACE_NOT_FOUND|找不到钉钉工作台入口（已尝试英文 Workplace 和中文 工作台）'
        }
    }
    Start-Sleep -Milliseconds 1200

    $mySection = Wait-OcrHit $Process @('My', '我的', '我的应用') $TimeoutSeconds -Exact
    if (-not $mySection) { throw 'DINGTALK_DESKTOP_MY_SECTION_NOT_FOUND|工作台中找不到“我的”应用区域' }
    $snapshot = $mySection.Snapshot
    $forAll = Get-OcrHits $snapshot @('For All', 'All', '全员', '全部应用') -Exact |
        Where-Object { $_.Top -gt $mySection.Hit.Bottom } |
        Sort-Object Top, Left |
        Select-Object -First 1
    $reportCandidates = @(Get-OcrHits $snapshot @('Report', 'Reports', '日志', '周报') -Exact | Where-Object {
        $_.Top -gt $mySection.Hit.Bottom -and (-not $forAll -or $_.Top -lt $forAll.Top)
    } | Sort-Object Top, Left)
    if ($reportCandidates.Count -eq 0) {
        # 英文版工作台偶尔只识别 My 标题而漏掉卡片内第一个 Report 文本。
        # 产品布局把 Report 固定为 My 卡片首个应用；坐标同时受 My 与 For All
        # 两个已识别标题约束，点击后还会继续验证 DingTalk Report 页标题。
        $fallbackX = $mySection.Hit.Left + 105
        $fallbackY = $mySection.Hit.Bottom + 70
        if ($forAll -and $fallbackY -ge $forAll.Top) {
            throw 'DINGTALK_DESKTOP_REPORT_APP_NOT_FOUND|工作台 My 区域边界异常，无法安全定位 Report 应用'
        }
        Invoke-WindowPoint $snapshot $fallbackX $fallbackY
    } else {
        Invoke-OcrHit $snapshot $reportCandidates[0] | Out-Null
    }
    Start-Sleep -Milliseconds 1200

    $createDeadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    $createSnapshot = $null
    $reportHeading = $null
    do {
        $candidateSnapshot = Get-WindowOcrSnapshot $Process
        # 只允许完整的 Report 页面标题作为锚点，不能用泛化的 Report，
        # 否则可能把左侧 Recently Used 的 Report 当成页面标题。
        $reportHeading = Find-OcrHit $candidateSnapshot @('DingTalk Report', '钉钉日志') -Exact
        if (-not $reportHeading) {
            $reportHeading = Find-OcrHit $candidateSnapshot @('DingTalk Report', '钉钉日志')
        }
        if ($reportHeading) {
            $createSnapshot = $candidateSnapshot
            break
        }
        Start-Sleep -Milliseconds 350
    } while ([DateTimeOffset]::UtcNow -lt $createDeadline)
    if (-not $reportHeading) {
        throw 'DINGTALK_DESKTOP_REPORT_PAGE_NOT_FOUND|点击 Report 后未识别到 DingTalk Report 页面标题'
    }
    # Create 是 DingTalk Report 左栏标题正下方的固定主按钮。以标题为锚点
    # 点击按钮中心，不再依赖 OCR 把“+ Create”拆成什么文本。
    $createX = $reportHeading.Left + [Math]::Max(125, $reportHeading.Width * 0.75)
    $createY = $reportHeading.Bottom + [Math]::Max(52, $reportHeading.Height * 2.2)
    if ($createX -ge ($createSnapshot.WindowRect.Width * 0.45) -or $createY -ge ($createSnapshot.WindowRect.Height * 0.38)) {
        throw 'DINGTALK_DESKTOP_CREATE_POSITION_INVALID|DingTalk Report 标题位置异常，无法安全点击 Create'
    }
    Invoke-WindowPoint $createSnapshot $createX $createY
    Start-Sleep -Milliseconds 1000

    # 某些版本会直接打开上次模板；确认确实是目标六字段表单后才可继续。
    $afterCreate = Get-WindowOcrSnapshot $Process
    if (Test-OcrText $afterCreate @('Submit', '提交')) {
        $afterCreate = Move-OcrReportFormToTop $Process $afterCreate
        if (Test-OcrReportForm $afterCreate $template) { return }
    }

    $templateDeadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    $templateSnapshot = $null
    $templateHit = $null
    do {
        $candidateSnapshot = Get-WindowOcrSnapshot $Process
        $templateHit = Find-OcrHit $candidateSnapshot @($template) -Exact
        if (-not $templateHit) { $templateHit = Find-OcrHit $candidateSnapshot @($template) }
        if ($templateHit) { $templateSnapshot = $candidateSnapshot; break }
        Start-Sleep -Milliseconds 350
    } while ([DateTimeOffset]::UtcNow -lt $templateDeadline)
    if (-not $templateHit) { throw "DINGTALK_DESKTOP_TEMPLATE_NOT_FOUND|Create 页面中找不到周报模板：$template" }
    Invoke-OcrHit $templateSnapshot $templateHit | Out-Null
    Start-Sleep -Milliseconds 1400

    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $snapshot = Get-WindowOcrSnapshot $Process
        if (Test-OcrReportForm $snapshot $template) { return }
        Start-Sleep -Milliseconds 400
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    throw "DINGTALK_DESKTOP_FORM_NOT_FOUND|已选择模板，但未识别到周报填写页：$template"
}

function Get-OcrInputHint([object]$Snapshot, [object]$LabelHit, [switch]$DateField) {
    $names = if ($DateField) { @('Choose time', '选择时间', '请选择日期') } else { @('Please enter', '请输入') }
    $candidates = Get-OcrHits $Snapshot $names -Exact | Where-Object {
        $_.Top -ge ($LabelHit.Bottom - 4) -and $_.Top -le ($LabelHit.Bottom + 150)
    } | Sort-Object Top, Left
    return $candidates | Select-Object -First 1
}

function Get-CalendarMonthInfo([object]$Snapshot) {
    $monthNames = @(
        @('jan', 'january'), @('feb', 'february'), @('mar', 'march'), @('apr', 'april'),
        @('may'), @('jun', 'june'), @('jul', 'july'), @('aug', 'august'),
        @('sep', 'sept', 'september'), @('oct', 'october'), @('nov', 'november'), @('dec', 'december')
    )
    foreach ($line in @(Get-OcrResults $Snapshot | ForEach-Object { $_.Lines })) {
        $normalized = Normalize-Text $line.Text
        for ($month = 1; $month -le 12; $month += 1) {
            foreach ($name in $monthNames[$month - 1]) {
                if ($normalized -match "^$name(20\d{2})$") {
                    return [pscustomobject]@{
                        Year = [int]$Matches[1]
                        Month = $month
                        Hit = Find-OcrHit $Snapshot @([string]$line.Text) -Exact
                    }
                }
            }
            if ($normalized -match "^(20\d{2})年0?${month}月$") {
                return [pscustomobject]@{
                    Year = [int]$Matches[1]
                    Month = $month
                    Hit = Find-OcrHit $Snapshot @([string]$line.Text) -Exact
                }
            }
        }
    }
    return $null
}

function Get-CalendarWeekHeader([object]$Snapshot) {
    foreach ($line in @(Get-OcrResults $Snapshot | ForEach-Object { $_.Lines })) {
        $normalized = Normalize-Text $line.Text
        if ($normalized.Contains('sumotuwethfrsa') -or $normalized.Contains('日一二三四五六')) {
            $hit = Find-OcrHit $Snapshot @([string]$line.Text) -Exact
            if ($hit) { return [pscustomobject]@{ Hit = $hit; Line = $line } }
        }
    }
    return $null
}

function Select-OcrCalendarDate([System.Diagnostics.Process]$Process, [DateTime]$RequestedDate) {
    for ($attempt = 0; $attempt -lt 37; $attempt += 1) {
        $calendar = Get-WindowOcrSnapshot $Process
        $monthInfo = Get-CalendarMonthInfo $calendar
        # The blue "Today" link is frequently recognized as T0day/Töday, so it is only an
        # optional lower-bound hint. The month heading is the authoritative picker identity.
        $today = Find-OcrHit $calendar @('Today', 'T0day', 'Töday', '今天') -Exact
        if (-not $monthInfo -or -not $monthInfo.Hit) {
            throw 'DINGTALK_DESKTOP_DATE_PICKER_FAILED|日期控件结构无法识别'
        }
        $monthDelta = (($RequestedDate.Year - $monthInfo.Year) * 12) + ($RequestedDate.Month - $monthInfo.Month)
        if ($monthDelta -eq 0) {
            # DingTalk's calendar is rendered in column-oriented OCR lines on some Windows
            # builds, so the weekday header is not reliably returned as one seven-word line.
            # Select the exact day word inside the bounded calendar panel instead.
            $horizontalRadius = [Math]::Max(170, $monthInfo.Hit.Width * 2.8)
            $calendarBottom = if ($today) { $today.Top } else { $monthInfo.Hit.Bottom + 360 }
            $dayHits = @(
                Get-OcrWordHits $calendar @([string]$RequestedDate.Day) | Where-Object {
                    ($_.Left + ($_.Width / 2)) -ge (($monthInfo.Hit.Left + ($monthInfo.Hit.Width / 2)) - $horizontalRadius) -and
                    ($_.Left + ($_.Width / 2)) -le (($monthInfo.Hit.Left + ($monthInfo.Hit.Width / 2)) + $horizontalRadius) -and
                    $_.Top -gt $monthInfo.Hit.Bottom -and $_.Bottom -lt $calendarBottom
                }
            )
            if ($dayHits.Count -ne 1) { throw 'DINGTALK_DESKTOP_DATE_PICKER_FAILED|日期控件目标日期无法唯一识别' }
            Invoke-WindowPoint $calendar ($dayHits[0].Left + ($dayHits[0].Width / 2)) ($dayHits[0].Top + ($dayHits[0].Height / 2))
            Start-Sleep -Milliseconds 300
            $selected = Get-WindowOcrSnapshot $Process
            $dateCandidates = @(
                $RequestedDate.ToString('yyyy-MM-dd'),
                $RequestedDate.ToString('yyyy/MM/dd'),
                $RequestedDate.ToString('MM/dd/yyyy'),
                $RequestedDate.ToString('M/d/yyyy'),
                $RequestedDate.ToString('MMM d, yyyy', [Globalization.CultureInfo]::GetCultureInfo('en-US')),
                "$($RequestedDate.Year)年$($RequestedDate.Month)月$($RequestedDate.Day)日"
            )
            if (-not (Test-OcrText $selected $dateCandidates)) {
                throw 'DINGTALK_DESKTOP_DATE_SELECTION_UNVERIFIED|日期点击后未识别到目标日期，已停止提交'
            }
            return
        }
        $monthOffset = [Math]::Max(120, $monthInfo.Hit.Width * 1.8)
        $direction = if ($monthDelta -gt 0) { 1 } else { -1 }
        Invoke-WindowPoint $calendar ($monthInfo.Hit.Left + ($monthInfo.Hit.Width / 2) + ($direction * $monthOffset)) ($monthInfo.Hit.Top + ($monthInfo.Hit.Height / 2))
        Start-Sleep -Milliseconds 220
    }
    throw 'DINGTALK_DESKTOP_DATE_OUT_OF_RANGE|目标日期超出自动日期控件支持范围'
}

function Set-OcrInputValue([object]$Snapshot, [object]$Hint, [string]$Value, [switch]$DateField) {
    Invoke-WindowPoint $Snapshot ($Hint.Left + [Math]::Min(35, $Hint.Width / 2)) ($Hint.Top + ($Hint.Height / 2))
    if ($DateField) {
        try { $requestedDate = [DateTime]::ParseExact($Value, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) }
        catch { throw 'DINGTALK_DESKTOP_REPORT_DATE_INVALID|周报填写日期必须是 yyyy-MM-dd' }
        Start-Sleep -Milliseconds 250
        Select-OcrCalendarDate (Get-DingTalkProcess) $requestedDate
        return
    }
    [System.Windows.Forms.Clipboard]::SetText($Value)
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 180
}

function Resolve-FormWithOcr(
    [System.Diagnostics.Process]$Process,
    [object]$Request,
    [switch]$SetValues
) {
    $labels = Get-FieldLabels $Request
    $values = @(
        [string](Get-ConfigValue $Request 'reportDate' ''),
        [string](Get-ConfigValue $Request 'recentGoals' ''),
        [string](Get-ConfigValue $Request 'weeklyWork' ''),
        [string](Get-ConfigValue $Request 'nextWeekPlans' ''),
        [string](Get-ConfigValue $Request 'problems' ''),
        [string](Get-ConfigValue $Request 'other' '')
    )
    $completed = [System.Collections.Generic.HashSet[int]]::new()

    $snapshot = Get-WindowOcrSnapshot $Process
    Invoke-WindowPoint $snapshot ($snapshot.WindowRect.Width * 0.87) ($snapshot.WindowRect.Height * 0.52)
    [System.Windows.Forms.SendKeys]::SendWait('^{HOME}')
    Start-Sleep -Milliseconds 350

    for ($page = 0; $page -lt 20; $page += 1) {
        $snapshot = Get-WindowOcrSnapshot $Process
        $filledOnThisPass = $false
        for ($index = 0; $index -lt $labels.Count; $index += 1) {
            if ($completed.Contains($index)) { continue }
            $label = Find-OcrHit $snapshot $labels[$index]
            if (-not $label) { continue }
            $hint = Get-OcrInputHint $snapshot $label -DateField:($index -eq 0)
            if (-not $hint) { continue }
            if ($SetValues) {
                Set-OcrInputValue $snapshot $hint $values[$index] -DateField:($index -eq 0)
                $filledOnThisPass = $true
            }
            $completed.Add($index) | Out-Null
            # Multiline values can expand the form and move every following field. Capture a
            # fresh OCR snapshot before locating the next input instead of reusing stale bounds.
            if ($filledOnThisPass) { break }
        }
        if ($completed.Count -eq $labels.Count) { break }
        if ($filledOnThisPass) { continue }
        Invoke-WindowPoint $snapshot ($snapshot.WindowRect.Width * 0.87) ($snapshot.WindowRect.Height * 0.75)
        [System.Windows.Forms.SendKeys]::SendWait('{PGDN}')
        Start-Sleep -Milliseconds 350
    }
    if ($completed.Count -ne $labels.Count) {
        $missing = for ($index = 0; $index -lt $labels.Count; $index += 1) {
            if (-not $completed.Contains($index)) { $labels[$index][0] }
        }
        throw "DINGTALK_DESKTOP_FIELD_NOT_FOUND|OCR 未识别到全部周报字段：$($missing -join '、')"
    }
    return @(
        for ($index = 0; $index -lt $labels.Count; $index += 1) {
            if ($completed.Contains($index)) { [string]$labels[$index][0] }
        }
    )
}

function Find-RecipientSubmitAreaWithOcr(
    [System.Diagnostics.Process]$Process,
    [string]$Recipient,
    [int]$TimeoutSeconds
) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $snapshot = Get-WindowOcrSnapshot $Process
        $recipientVisible = (-not $Recipient) -or (Test-OcrText $snapshot @($Recipient))
        $submit = Find-OcrHit $snapshot @('Submit', '提交') -Exact
        if ($recipientVisible -and $submit) {
            return [pscustomobject]@{ Snapshot = $snapshot; Submit = $submit; RecipientVisible = $recipientVisible }
        }
        Invoke-WindowPoint $snapshot ($snapshot.WindowRect.Width * 0.87) ($snapshot.WindowRect.Height * 0.78)
        [System.Windows.Forms.SendKeys]::SendWait('{PGDN}')
        Start-Sleep -Milliseconds 350
    } while ([DateTimeOffset]::UtcNow -lt $deadline)
    if ($Recipient) {
        throw "DINGTALK_DESKTOP_RECIPIENT_NOT_VISIBLE|提交前未识别到接收群：$Recipient"
    }
    throw 'DINGTALK_DESKTOP_SUBMIT_BUTTON_NOT_FOUND|找不到日志提交按钮'
}

function Open-ReportForm([System.Windows.Automation.AutomationElement]$Root, [object]$Request, [int]$TimeoutSeconds) {
    $organization = [string](Get-ConfigValue $Request 'organizationName' '')
    $template = [string](Get-ConfigValue $Request 'templateName' '')
    if (-not $organization -or -not $template) { throw 'DINGTALK_DESKTOP_CONFIGURATION_REQUIRED|必须配置公司名称和周报模板名称' }

    $organizationElement = Find-NamedElement $Root @($organization) -Contains
    if (-not $organizationElement) {
        $switcher = Find-AutomationIdElement $Root @('org_switch_view') -Contains
        if (-not $switcher) {
            $switcher = Find-NamedElement $Root @('切换企业', '切换组织', 'Switch organization', 'Organizations') -Contains
        }
        if ($switcher) {
            Invoke-Element $switcher | Out-Null
            Start-Sleep -Milliseconds 500
            $organizationElement = Wait-NamedElement $Root @($organization) 5 -Contains
            if ($organizationElement) { Invoke-Element $organizationElement | Out-Null; Start-Sleep -Milliseconds 900 }
        }
    }
    if (-not (Find-NamedElement $Root @($organization) -Contains)) {
        throw "DINGTALK_DESKTOP_ORGANIZATION_NOT_VISIBLE|当前钉钉客户端中未识别到公司：$organization"
    }

    $existingTemplate = Find-NamedElement $Root @($template) -Contains
    if (-not $existingTemplate) {
        $workbench = Wait-NamedElement $Root @('工作台', 'Workbench') 3 -Contains
        if ($workbench -and (Invoke-Element $workbench)) {
            Start-Sleep -Milliseconds 900
            $reportApp = Wait-NamedElement $Root @('日志', 'Reports', 'Report') $TimeoutSeconds -Contains
            if ($reportApp -and (Invoke-Element $reportApp)) {
                Start-Sleep -Milliseconds 900
                $existingTemplate = Wait-NamedElement $Root @($template) $TimeoutSeconds -Contains
            }
        }
    }
    if (-not $existingTemplate) {
        # Some DingTalk builds expose navigation items without accessible names. Global search
        # is the deterministic fallback and still resolves the configured template by name.
        $existingTemplate = Find-TemplateThroughGlobalSearch $Root $template $TimeoutSeconds
    }
    if (-not $existingTemplate) { throw "DINGTALK_DESKTOP_TEMPLATE_NOT_FOUND|找不到周报模板：$template" }
    Invoke-Element $existingTemplate | Out-Null
    Start-Sleep -Milliseconds 800

    $writeButton = Find-NamedElement $Root @('写日志', '填写日志', 'Write Report', 'Create report') -Contains
    if (-not $writeButton) {
        # The report detail page shown by DingTalk places "Write Report" in the top-right
        # overflow menu. Prefer an exact accessible name to avoid clicking unrelated controls.
        $moreButton = Find-NamedElement $Root @('更多', 'More', '…', '...') -ControlTypes @(
            [System.Windows.Automation.ControlType]::Button,
            [System.Windows.Automation.ControlType]::MenuItem
        )
        if (-not $moreButton) {
            $moreButton = Find-NamedElement $Root @('更多操作', 'More actions') -Contains -ControlTypes @(
                [System.Windows.Automation.ControlType]::Button,
                [System.Windows.Automation.ControlType]::MenuItem
            )
        }
        if ($moreButton -and (Invoke-Element $moreButton)) {
            Start-Sleep -Milliseconds 400
            $writeButton = Wait-NamedElement $Root @('写日志', '填写日志', 'Write Report', 'Create report') 5 -Contains
        }
    }
    if ($writeButton) { Invoke-Element $writeButton | Out-Null; Start-Sleep -Milliseconds 800 }
}

function Invoke-DingTalkDesktopAutomation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$InputPath,
        [Parameter(Mandatory = $true)][string]$OutputPath
    )

try {
    if (-not [Environment]::UserInteractive) { throw 'DINGTALK_DESKTOP_INTERACTIVE_SESSION_REQUIRED|桌面自动化必须运行在已登录且未锁屏的 Windows 会话中' }
    $request = Get-Content -LiteralPath $InputPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $operation = [string](Get-ConfigValue $request 'operation' '')
    if ($operation -eq 'selftest') {
        $ocrEngine = Get-OcrEngine
        $showWindowCommand = Get-Command Show-AutoWorkWindow -ErrorAction Stop
        $clickCommand = Get-Command Invoke-AutoWorkClick -ErrorAction Stop
        Write-Result @{
            success = $true
            status = 'healthy'
            runId = [string](Get-ConfigValue $request 'runId' 'desktop-runner-selftest')
            message = 'DingTalk desktop runner JSON and process isolation self-test passed.'
            ocrAvailable = $null -ne $ocrEngine
            nativeInputModuleAvailable = $null -ne $showWindowCommand -and $null -ne $clickCommand
        }
        exit 0
    }
    if ($operation -notin @('probe', 'submit')) {
        throw 'DINGTALK_DESKTOP_OPERATION_INVALID|不支持的桌面自动化操作'
    }
    if ($operation -eq 'submit') {
        $requestedRunId = [string](Get-ConfigValue $request 'runId' '')
        if ($requestedRunId -notmatch '^[A-Za-z0-9._-]{1,120}$') {
            throw 'DINGTALK_DESKTOP_RUN_ID_INVALID|提交运行标识格式无效'
        }
    }
    $timeoutSeconds = [int](Get-ConfigValue $request 'timeoutSeconds' 30)
    if ($timeoutSeconds -lt 5 -or $timeoutSeconds -gt 180) { $timeoutSeconds = 30 }
    $context = Get-DingTalkRoot $request $timeoutSeconds
    # DingTalk 8.x renders the report editor in a Chromium "Legacy Window" that does not
    # expose its DOM controls through Windows UI Automation. Windows OCR reads the visible
    # client exactly as the user sees it, while UI Automation remains responsible for safe
    # process/window activation and organization identity.
    Open-ReportFormWithOcr $context.Process $request $timeoutSeconds
    $observedFields = Resolve-FormWithOcr $context.Process $request -SetValues:($operation -eq 'submit')
    $recipient = [string](Get-ConfigValue $request 'recipientGroupName' '')
    $submitArea = @(
        Find-RecipientSubmitAreaWithOcr $context.Process $recipient $timeoutSeconds
    ) | Where-Object { $_.PSObject.Properties['RecipientVisible'] } | Select-Object -Last 1
    if (-not $submitArea) {
        throw 'DINGTALK_DESKTOP_SUBMIT_AREA_INVALID|接收群与提交区域识别结果无效'
    }

    if ($operation -eq 'probe') {
        Write-Result @{
            success = $true
            status = 'healthy'
            processId = $context.Process.Id
            windowTitle = $context.Process.MainWindowTitle
            organizationVisible = $true
            templateVisible = $true
            recipientVisible = $submitArea.RecipientVisible
            observedFields = $observedFields
        }
        exit 0
    }
    $evidenceDirectory = [string](Get-ConfigValue $request 'evidenceDirectory' '')
    $runId = [string](Get-ConfigValue $request 'runId' ([Guid]::NewGuid().ToString('N')))
    $beforeScreenshot = Save-WindowScreenshot $context.Process $evidenceDirectory "$runId-before"
    if (-not (Invoke-OcrHit $submitArea.Snapshot $submitArea.Submit)) { throw 'DINGTALK_DESKTOP_SUBMIT_CLICK_FAILED|无法点击日志提交按钮' }

    $success = Wait-OcrHit $context.Process @('提交成功', '发送成功', 'Report submitted', 'Submitted successfully', '我发出的') $timeoutSeconds
    $afterScreenshot = Save-WindowScreenshot $context.Process $evidenceDirectory "$runId-after"
    if (-not $success) {
        Write-Result @{
            success = $false
            status = 'unknown'
            errorCode = 'DINGTALK_DESKTOP_SUBMISSION_RESULT_UNKNOWN'
            message = '已点击提交，但未识别到成功提示；禁止自动重试，请在钉钉中人工核对'
            runId = $runId
            beforeScreenshot = $beforeScreenshot
            afterScreenshot = $afterScreenshot
            observedFields = $observedFields
        }
        exit 3
    }
    Write-Result @{
        success = $true
        status = 'succeeded'
        runId = $runId
        receipt = "desktop:$runId"
        successText = $success.Hit.Text
        beforeScreenshot = $beforeScreenshot
        afterScreenshot = $afterScreenshot
        observedFields = $observedFields
    }
    exit 0
} catch {
    $parts = [string]$_.Exception.Message -split '\|', 2
    $code = if ($parts.Count -gt 1) { $parts[0] } else { 'DINGTALK_DESKTOP_AUTOMATION_FAILED' }
    $message = if ($parts.Count -gt 1) { $parts[1] } else { [string]$_.Exception.Message }
    Write-Result @{ success = $false; status = 'failed'; errorCode = $code; message = $message }
    exit 2
}
}

Export-ModuleMember -Function Invoke-DingTalkDesktopAutomation
