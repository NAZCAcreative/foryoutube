param([string]$TextFile, [string]$WaveFile)
$ErrorActionPreference = 'Stop'
$speaker = New-Object -ComObject SAPI.SpVoice
$voices = @($speaker.GetVoices() | Where-Object { $_.GetAttribute('Language') -match '(^|;)412(;|$)' })
if (-not $voices) { throw 'Korean Windows voice unavailable.' }
$speaker.Voice = $voices[0]
$stream = New-Object -ComObject SAPI.SpFileStream
$stream.Open($WaveFile, 3, $false)
try {
  $speaker.AudioOutputStream = $stream
  $sentence = [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8)
  $null = $speaker.Speak($sentence, 0)
} finally {
  $stream.Close()
}
