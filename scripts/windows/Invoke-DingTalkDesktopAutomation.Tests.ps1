$modulePath = Join-Path $PSScriptRoot 'Invoke-DingTalkDesktopAutomation.psm1'
Import-Module $modulePath -Force

Describe 'DingTalk desktop report date OCR' {
    InModuleScope Invoke-DingTalkDesktopAutomation {
        function New-DateSnapshot([string]$Text, [double]$Left = 120, [double]$Top = 150) {
            $word = [pscustomobject]@{
                Text = $Text
                BoundingRect = [pscustomobject]@{ X = $Left; Y = $Top; Width = 150; Height = 24 }
            }
            $line = [pscustomobject]@{ Text = $Text; Words = @($word) }
            $result = [pscustomobject]@{ Lines = @($line) }
            return [pscustomobject]@{
                Result = $result
                Results = @($result)
                Text = $Text
                WindowRect = [pscustomobject]@{ Width = 1200; Height = 800 }
            }
        }

        $label = [pscustomobject]@{ Text = 'Report date'; Left = 100; Top = 96; Right = 180; Bottom = 120 }

        It 'accepts localized renderings of the same execution date near the date field' {
            foreach ($display in @(
                '2026-08-28',
                '2026-8-28',
                '2026/8/28',
                '2026.08.28',
                '08/28/2026',
                'Aug 28, 2026',
                'August 28, 2026',
                [string]::Concat('2026', [char]0x5E74, '8', [char]0x6708, '28', [char]0x65E5)
            )) {
                { Assert-OcrCurrentReportDate (New-DateSnapshot $display) $label '2026-08-28' } | Should Not Throw
            }
        }

        It 'still rejects a different date in the same field area' {
            {
                Assert-OcrCurrentReportDate (New-DateSnapshot '2026/8/27') $label '2026-08-28'
            } | Should Throw
        }

        It 'does not accept the expected date outside the bounded date field area' {
            {
                Assert-OcrCurrentReportDate (New-DateSnapshot '2026-08-28' 900 600) $label '2026-08-28'
            } | Should Throw
        }

        It 'accepts a date merged into the same OCR line as its label' {
            $snapshot = New-DateSnapshot 'Report date 2026-8-28' 100 96
            { Assert-OcrCurrentReportDate $snapshot $label '2026-08-28' } | Should Not Throw
        }

        It 'selects today when DingTalk exposes a blank date placeholder' {
            $blankSnapshot = New-DateSnapshot 'Choose time' 120 150
            $selectedSnapshot = New-DateSnapshot '2026-08-28' 120 150
            Mock Find-OcrCurrentReportDateHit {
                param($Snapshot)
                if ($Snapshot -eq $selectedSnapshot) { return [pscustomobject]@{ Text = '2026-08-28' } }
                return $null
            }
            Mock Get-OcrInputHint { return [pscustomobject]@{ Hit = [pscustomobject]@{}; ExactMatch = $true } }
            Mock Get-OcrInputTarget { return [pscustomobject]@{ Left = 120; Top = 150; Width = 120; Height = 24 } }
            Mock Set-OcrInputValue { }
            Mock Get-WindowOcrSnapshot { return $selectedSnapshot }
            Mock Find-OcrHit { return $label }

            $changed = Resolve-OcrReportDate (Get-Process -Id $PID) $blankSnapshot $label '2026-08-28'

            $changed | Should Be $true
            Assert-MockCalled Set-OcrInputValue -Times 1 -Exactly
        }
    }
}
