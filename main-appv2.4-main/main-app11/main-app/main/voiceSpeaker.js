'use strict';

// ── Better voices ────────────────────────────────────────────────────────────
//
// The speech host talks through `System.Speech`, which is SAPI5, and SAPI5 can
// only see the "Desktop" voices — on a typical machine that is Microsoft David
// Desktop and Zira Desktop, both from the concatenative era. They are the main
// reason the assistant sounds like a 2009 satnav.
//
// Windows 10/11 also ship the OneCore voices (David, Mark, Zira, and on some
// machines Aria/Jenny), which are considerably better. SAPI5 cannot reach them.
// WinRT can: `Windows.Media.SpeechSynthesis`.
//
// This is a SEPARATE process from the recognition host on purpose. The host is
// a load-bearing, tested component that owns the microphone; rewiring its audio
// path to gain a nicer voice would risk the thing that actually matters. So the
// speaker lives on its own, and if it fails to start — old Windows, WinRT
// unavailable, a locked-down machine — the caller simply keeps using the host's
// SAPI voice and nothing is lost.
//
// Protocol (one line each way, same idiom as the other persistent helpers):
//   in   VOICES                     -> VOICE <name> for each, then VOICES-END
//        SPEAK <rate>|<voice>|<text>
//        STOP
//        EXIT
//   out  READY | VOICE <name> | VOICES-END | SPEAK-START | SPEAK-DONE | ERROR <msg>

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

// The helper. Kept here rather than in a file on disk so it cannot drift from
// the code that speaks to it.
const SPEAKER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit([string]$line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  Add-Type -AssemblyName System.Speech
  # Awaiting a WinRT IAsyncOperation from PowerShell 5.1 needs this shim.
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`" + `1'
  })[0]
  $synth = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType=WindowsRuntime]::new()
  $allVoices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
} catch {
  Emit ('ERROR init: ' + $_.Exception.Message)
  exit 1
}

function Await($op, $type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  [void]$t.Wait(-1)
  $t.Result
}

$player = New-Object System.Media.SoundPlayer
$tmp = Join-Path $env:TEMP ('main-voice-' + [guid]::NewGuid().ToString('N') + '.wav')

Emit 'READY'

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  if ($line -eq 'EXIT') { break }

  if ($line -eq 'VOICES') {
    foreach ($v in $allVoices) { Emit ('VOICE ' + $v.DisplayName) }
    Emit 'VOICES-END'
    continue
  }

  if ($line -eq 'STOP') {
    try { $player.Stop() } catch { }
    continue
  }

  if ($line.StartsWith('SPEAK ')) {
    $payload = $line.Substring(6)
    $parts = $payload.Split([char]124, 3)   # rate | voice | text
    if ($parts.Count -lt 3) { Emit 'SPEAK-DONE'; continue }
    $rate = 0.0
    [void][double]::TryParse($parts[0], [ref]$rate)
    $voiceName = $parts[1]
    $text = $parts[2]
    if ($text -eq '') { Emit 'SPEAK-DONE'; continue }

    try {
      if ($voiceName -ne '') {
        $pick = $allVoices | Where-Object { $_.DisplayName -eq $voiceName } | Select-Object -First 1
        if ($pick) { $synth.Voice = $pick }
      }
      # SSML carries the pacing. -5..5 maps onto a sane speaking-rate range.
      $mult = [math]::Round(1.0 + ($rate * 0.12), 2)
      if ($mult -lt 0.5) { $mult = 0.5 }
      if ($mult -gt 2.0) { $mult = 2.0 }
      $escaped = [System.Security.SecurityElement]::Escape($text)
      $ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><prosody rate='$mult'>$escaped</prosody></speak>"

      $op = $synth.SynthesizeSsmlToStreamAsync($ssml)
      $stream = Await $op ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
      $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
      $fs = [System.IO.File]::Create($tmp)
      $net.CopyTo($fs)
      $fs.Close(); $net.Close()

      Emit 'SPEAK-START'
      $player.SoundLocation = $tmp
      $player.Load()
      $player.PlaySync()
      Emit 'SPEAK-DONE'
    } catch {
      Emit ('ERROR speak: ' + $_.Exception.Message)
      Emit 'SPEAK-DONE'
    }
    continue
  }
}

try { Remove-Item $tmp -ErrorAction SilentlyContinue } catch { }
`;

// Bump when the script body changes.
const SPEAKER_SCRIPT_VERSION = 1;

function createSpeaker(options) {
  const opts = options || {};
  const logger = opts.logger || { log() {}, error() {}, debug() {} };
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};

  let child = null;
  let ready = false;
  let buffer = '';
  let voices = [];
  let collecting = null;
  let startTimer = null;

  function handleLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    if (trimmed === 'READY') {
      ready = true;
      clearTimeout(startTimer);
      send('VOICES');
      onEvent('ready');
      return;
    }
    if (trimmed.startsWith('VOICE ')) {
      if (collecting) collecting.push(trimmed.slice(6));
      return;
    }
    if (trimmed === 'VOICES-END') {
      if (collecting) { voices = collecting.slice(); collecting = null; }
      onEvent('voices', voices);
      return;
    }
    if (trimmed === 'SPEAK-START') { onEvent('speak-start'); return; }
    if (trimmed === 'SPEAK-DONE') { onEvent('speak-done'); return; }
    if (trimmed.startsWith('ERROR ')) {
      logger.error('Voice speaker error', null, { detail: trimmed.slice(6) });
      onEvent('error', trimmed.slice(6));
      return;
    }
  }

  function send(line) {
    if (!child || !child.stdin.writable) return false;
    try { child.stdin.write(line + '\n'); return true; } catch (e) { return false; }
  }

  function start() {
    if (child) return;
    collecting = [];
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SPEAKER_SCRIPT], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (e) {
      logger.error('Voice speaker could not start', e);
      child = null;
      onEvent('unavailable');
      return;
    }
    child.stdout.on('data', (d) => {
      buffer += d.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        handleLine(line);
      }
    });
    child.stderr.on('data', (d) => logger.debug('Voice speaker stderr', { detail: String(d).slice(0, 300) }));
    child.on('exit', () => {
      child = null;
      ready = false;
      onEvent('exit');
    });
    // If WinRT is unavailable the helper dies immediately; the caller must not
    // wait on it forever, and must fall back rather than losing speech.
    startTimer = setTimeout(() => {
      if (!ready) {
        logger.log('Voice speaker did not become ready; using the built-in voice', 'INFO');
        stop();
        onEvent('unavailable');
      }
    }, 6000);
  }

  function speak(text, voiceName, rate) {
    if (!ready) return false;
    const clean = String(text == null ? '' : text).replace(/[\r\n|]+/g, ' ').slice(0, 500);
    if (!clean) return false;
    return send('SPEAK ' + (Number(rate) || 0) + '|' + String(voiceName || '') + '|' + clean);
  }

  function stopSpeaking() { if (ready) send('STOP'); }

  function stop() {
    clearTimeout(startTimer);
    if (!child) return;
    try { send('EXIT'); } catch (e) { /* already gone */ }
    const dying = child;
    child = null;
    ready = false;
    setTimeout(() => { try { dying.kill(); } catch (e) { /* already dead */ } }, 400);
  }

  return {
    start,
    stop,
    speak,
    stopSpeaking,
    isReady: () => ready,
    getVoices: () => voices.slice()
  };
}

module.exports = { createSpeaker, SPEAKER_SCRIPT, SPEAKER_SCRIPT_VERSION };
