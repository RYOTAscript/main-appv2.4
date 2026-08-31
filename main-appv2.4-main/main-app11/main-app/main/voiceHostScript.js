// ── Voice Assistant: the PowerShell/C# speech host ───────────────────────────
//
// One long-lived helper process that owns everything speech-related on Windows:
// the offline recognizer, the synthesizer, and the push-to-talk key watch. Split
// into its own module purely for size — main/voiceAssistant.js is the only
// consumer, and test/voice-assistant.test.js asserts the two still speak the
// same protocol.
//
// WHY A PERSISTENT PROCESS, not a spawn per utterance: loading System.Speech,
// compiling the grammar and acquiring the audio device costs well over a second.
// Paying that on every activation would make the assistant feel broken. This is
// the same shape main/macros.js uses for its input engine — a compiled C# core
// driven over a line protocol on stdin/stdout.
//
// WHY C# RATHER THAN PLAIN POWERSHELL: the host has to read commands from stdin
// *while* recognizer callbacks fire and a key-watch thread runs. PowerShell's
// event queue makes that awkward and fragile; in C# the main thread simply
// blocks on ReadLine, the engine raises events on its own threads, and one lock
// serialises stdout.
//
// ── Protocol ────────────────────────────────────────────────────────────────
// Commands IN (one per line). Deliberately plain text, never JSON: phrases are
// pre-normalised to [a-z0-9 ] by main/voiceCommands.js, so there is nothing to
// escape and nothing to parse.
//
//   GRAMMAR-BEGIN            start a grammar rebuild
//   PHRASE <text>              one literal phrase
//   DICTATION <carrier>        carrier + free dictation, e.g. "search for"
//   CONFIRM <word>             yes/no vocabulary, live only while confirming
//   WAKE <phrase>              wake phrase, e.g. "hey main"
//   CHAIN <0|1>                allow several commands in one utterance
//   GRAMMAR-END              compile and load; replaces any previous grammar
//   LISTEN <timeoutMs>       open the mic and recognise (command mode)
//   WAKE-LISTEN              open the mic and listen ONLY for a wake phrase,
//                            continuously and with no timeout
//   MODE wake | MODE command <timeoutMs>
//                            switch between wake and command listening WITHOUT
//                            releasing the audio device — it only flips which
//                            grammars are enabled, so waking is instant
//   STOP                     cancel recognition and RELEASE the audio device
//   SPEAK <text>             speak asynchronously
//   SHUTUP                   cancel any in-flight speech
//   VOICE <name>             select a synthesizer voice ('' = system default)
//   RATE <-5..5>             synthesizer rate
//   WATCH <vk> <mods>        push-to-talk key watch (vk 0 = off; mods bitmask
//                            1 Ctrl, 2 Shift, 4 Alt, 8 Win — same as autoClicker)
//   PING / EXIT
//
// Events OUT (one per line):
//   READY <recognizerName>       VOICE-AVAILABLE <name>     GRAMMAR-OK <count>
//   LISTENING                    STOPPED                    TIMEOUT
//   LEVEL <0..100>               AUDIO <Silence|Noise|Speech>
//   HYP <text>                   RESULT <confidence> <text>
//   WAKED <confidence> <text>    (a wake-grammar hit; the text may carry a
//                                 command spoken in the same breath)
//   REJECTED <confidence> <text> SPEAK-START                SPEAK-DONE
//   KEY-DOWN                     KEY-UP                     PONG
//   ERROR <message>
//
// Confidence is REPORTED, never enforced here — the threshold is a user setting
// and lives in main/voiceAssistant.js, so changing it must not require a grammar
// reload or a host restart.
//
// Bump VOICE_HOST_SCRIPT_VERSION on any change to the script body:
// scriptCache.ensureVersionedScript() rewrites the cached .ps1 on a version
// change, and a stale host would silently speak an older protocol.
const VOICE_HOST_SCRIPT_VERSION = 3;

const VOICE_HOST_SCRIPT_CONTENT = `$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
} catch { }

Add-Type -AssemblyName System.Speech

$speechDll = [System.Reflection.Assembly]::LoadWithPartialName('System.Speech').Location

Add-Type -ReferencedAssemblies $speechDll -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Speech.Recognition;
using System.Speech.Synthesis;
using System.Threading;

namespace MainVoiceHost {
  public static class Host {
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);

    static readonly object OutLock = new object();
    static readonly CultureInfo Culture = new CultureInfo("en-US");

    static SpeechRecognitionEngine rec;
    static SpeechSynthesizer syn;

    static volatile bool running = true;
    static volatile bool listening = false;
    static volatile bool grammarLoaded = false;

    // Push-to-talk watch state, written by the command thread and read by the
    // watcher thread. volatile is enough: these are single 32-bit writes and the
    // watcher only ever needs to see the latest value, not a consistent pair.
    static volatile int watchVk = 0;
    static volatile int watchMods = 0;

    static Timer listenTimer;

    static List<string> pendingPhrases = new List<string>();
    static List<string> pendingDictation = new List<string>();
    static List<string> pendingConfirm = new List<string>();
    static List<string> pendingWake = new List<string>();
    // Whether the command grammar accepts several commands in one breath.
    static bool chaining = true;

    // Held so the mode switch can enable/disable them in place. Reloading
    // grammars would mean stopping recognition and re-acquiring the microphone,
    // which is far too slow to sit between a wake word and the command after it.
    static Grammar commandGrammar;
    static Grammar dictationGrammar;
    static Grammar confirmGrammar;
    static Grammar wakeGrammar;

    // "wake" = idle, listening only for the wake phrase. "command" = the full
    // grammar, with audio levels streamed for the overlay's animation.
    static volatile string mode = "command";

    static void Emit(string line) {
      lock (OutLock) {
        try { Console.Out.WriteLine(line); Console.Out.Flush(); } catch { }
      }
    }

    // Everything crossing the protocol is one line — a stray newline inside a
    // recognised phrase or a spoken track title would desynchronise the reader.
    static string OneLine(string s) {
      if (s == null) return "";
      return s.Replace("\\r", " ").Replace("\\n", " ").Trim();
    }

    static void Fail(string what, Exception e) {
      Emit("ERROR " + OneLine(what + ": " + (e == null ? "unknown" : e.Message)));
    }

    public static void Run() {
      try {
        syn = new SpeechSynthesizer();
        syn.SpeakStarted += delegate { Emit("SPEAK-START"); };
        syn.SpeakCompleted += delegate { Emit("SPEAK-DONE"); };
      } catch (Exception e) { Fail("synthesizer init", e); }

      try {
        rec = new SpeechRecognitionEngine(Culture);
        rec.SpeechRecognized += OnRecognized;
        rec.SpeechRecognitionRejected += OnRejected;
        rec.SpeechHypothesized += OnHypothesized;
        rec.AudioLevelUpdated += OnLevel;
        rec.AudioStateChanged += OnAudioState;
      } catch (Exception e) {
        Fail("recognizer init", e);
        Emit("READY none");
        return;
      }

      Thread watcher = new Thread(WatchLoop);
      watcher.IsBackground = true;
      watcher.Start();

      Emit("READY " + OneLine(rec.RecognizerInfo.Name));
      if (syn != null) {
        try {
          foreach (InstalledVoice v in syn.GetInstalledVoices()) {
            if (v.Enabled) Emit("VOICE-AVAILABLE " + OneLine(v.VoiceInfo.Name));
          }
        } catch (Exception e) { Fail("voice list", e); }
      }

      string line;
      while (running && (line = Console.In.ReadLine()) != null) {
        try { Dispatch(line.Trim()); }
        catch (Exception e) { Fail("command", e); }
      }
      Shutdown();
    }

    static void Dispatch(string line) {
      if (line.Length == 0) return;
      string cmd = line;
      string arg = "";
      int sp = line.IndexOf(' ');
      if (sp > 0) { cmd = line.Substring(0, sp); arg = line.Substring(sp + 1).Trim(); }

      switch (cmd) {
        case "GRAMMAR-BEGIN":
          pendingPhrases = new List<string>();
          pendingDictation = new List<string>();
          pendingConfirm = new List<string>();
          pendingWake = new List<string>();
          break;
        case "PHRASE": if (arg.Length > 0) pendingPhrases.Add(arg); break;
        case "DICTATION": if (arg.Length > 0) pendingDictation.Add(arg); break;
        case "CONFIRM": if (arg.Length > 0) pendingConfirm.Add(arg); break;
        case "WAKE": if (arg.Length > 0) pendingWake.Add(arg); break;
        case "CHAIN": chaining = (arg != "0"); break;
        case "GRAMMAR-END": LoadGrammars(); break;
        case "LISTEN": SetMode("command", ParseInt(arg, 7000)); StartListening(ParseInt(arg, 7000)); break;
        case "WAKE-LISTEN": SetMode("wake", 0); StartListening(0); break;
        case "MODE": {
          string[] mp = arg.Split(' ');
          SetMode(mp.Length > 0 ? mp[0] : "command", mp.Length > 1 ? ParseInt(mp[1], 7000) : 0);
          break;
        }
        case "STOP": StopListening(false); break;
        case "SPEAK": Speak(arg); break;
        case "SHUTUP": CancelSpeech(); break;
        case "VOICE": SelectVoice(arg); break;
        case "RATE": SetRate(ParseInt(arg, 0)); break;
        case "WATCH": SetWatch(arg); break;
        case "PING": Emit("PONG"); break;
        case "EXIT": running = false; break;
        default: Emit("ERROR unknown command " + OneLine(cmd)); break;
      }
    }

    static int ParseInt(string s, int fallback) {
      int v;
      return int.TryParse(s, out v) ? v : fallback;
    }

    // ── Grammar ──
    static void LoadGrammars() {
      bool wasListening = listening;
      // LoadGrammar throws while recognition is running, so a rebuild always
      // stops first. The mic is released too — a grammar rebuild is not a reason
      // to hold the device open.
      if (wasListening) StopListening(true);
      try {
        rec.UnloadAllGrammars();
        int count = 0;

        if (pendingPhrases.Count > 0) {
          Choices choices = new Choices(pendingPhrases.ToArray());
          GrammarBuilder gb = new GrammarBuilder();
          gb.Culture = Culture;
          gb.Append(choices);
          // Chaining is a REPETITION, not a cross product: "<phrase> ([and]
          // <phrase>){0,2}" adds a couple of arcs rather than squaring the
          // grammar, so 590 phrases stay 590 rather than becoming 348,000.
          if (chaining) {
            GrammarBuilder more = new GrammarBuilder();
            more.Culture = Culture;
            more.Append(new Choices(new string[] { "and", "then", "and then", "also", "plus" }), 0, 1);
            more.Append(choices);
            gb.Append(more, 0, 2);
          }
          commandGrammar = new Grammar(gb);
          commandGrammar.Name = "commands";
          rec.LoadGrammar(commandGrammar);
          count += pendingPhrases.Count;
        }

        // The one open-ended slot: a carrier phrase followed by free dictation,
        // e.g. "search for <anything>". Kept as a separate grammar so its far
        // lower accuracy can never drag down the closed command grammar.
        if (pendingDictation.Count > 0) {
          GrammarBuilder gd = new GrammarBuilder();
          gd.Culture = Culture;
          gd.Append(new Choices(pendingDictation.ToArray()));
          gd.AppendDictation();
          dictationGrammar = new Grammar(gd);
          dictationGrammar.Name = "dictation";
          rec.LoadGrammar(dictationGrammar);
          count += pendingDictation.Count;
        }

        if (pendingConfirm.Count > 0) {
          GrammarBuilder gc = new GrammarBuilder();
          gc.Culture = Culture;
          gc.Append(new Choices(pendingConfirm.ToArray()));
          confirmGrammar = new Grammar(gc);
          confirmGrammar.Name = "confirm";
          rec.LoadGrammar(confirmGrammar);
          count += pendingConfirm.Count;
        }

        // The wake grammar is "<wake phrase> [command]" — the command tail is
        // OPTIONAL, which is what lets "hey main" and "hey main next track" both
        // be single utterances. Kept separate from the command grammar so it can
        // be the only thing enabled while idle.
        if (pendingWake.Count > 0) {
          GrammarBuilder gwake = new GrammarBuilder();
          gwake.Culture = Culture;
          gwake.Append(new Choices(pendingWake.ToArray()));
          if (pendingPhrases.Count > 0) {
            GrammarBuilder tail = new GrammarBuilder();
            tail.Culture = Culture;
            tail.Append(new Choices(pendingPhrases.ToArray()));
            gwake.Append(tail, 0, 1);
          }
          wakeGrammar = new Grammar(gwake);
          wakeGrammar.Name = "wake";
          rec.LoadGrammar(wakeGrammar);
          count += pendingWake.Count;
        }
        ApplyMode();

        grammarLoaded = count > 0;
        Emit("GRAMMAR-OK " + count);
      } catch (Exception e) {
        grammarLoaded = false;
        Fail("grammar", e);
      }
      if (wasListening) StartListening(mode == "wake" ? 0 : 7000);
    }

    // Flips which grammars are live. Cheap enough to do mid-recognition, which
    // is the whole point: after a wake phrase the command grammar has to be
    // available immediately, without touching the audio device.
    static void SetMode(string next, int timeoutMs) {
      mode = (next == "wake") ? "wake" : "command";
      ApplyMode();
      if (listenTimer != null) { try { listenTimer.Dispose(); } catch { } listenTimer = null; }
      if (mode == "command" && timeoutMs > 0 && listening) ArmTimeout(timeoutMs);
    }

    static void ApplyMode() {
      bool waking = (mode == "wake");
      try {
        if (wakeGrammar != null) wakeGrammar.Enabled = waking;
        // With no wake grammar loaded there is nothing to listen for in wake
        // mode, so leave the command grammar on rather than going deaf.
        bool cmdOn = !waking || wakeGrammar == null;
        if (commandGrammar != null) commandGrammar.Enabled = cmdOn;
        if (dictationGrammar != null) dictationGrammar.Enabled = cmdOn;
        if (confirmGrammar != null) confirmGrammar.Enabled = cmdOn;
      } catch (Exception e) { Fail("mode", e); }
    }

    static void ArmTimeout(int timeoutMs) {
      listenTimer = new Timer(delegate {
        if (!listening || mode == "wake") return;
        StopListening(true);
        Emit("TIMEOUT");
      }, null, timeoutMs, System.Threading.Timeout.Infinite);
    }

    // ── Recognition ──
    static void StartListening(int timeoutMs) {
      if (listening) return;
      if (!grammarLoaded) { Emit("ERROR no grammar loaded"); return; }
      try {
        rec.SetInputToDefaultAudioDevice();
      } catch (Exception e) {
        Fail("microphone", e);
        return;
      }
      try {
        listening = true;
        rec.RecognizeAsync(RecognizeMode.Multiple);
        Emit("LISTENING");
      } catch (Exception e) {
        listening = false;
        try { rec.SetInputToNull(); } catch { }
        Fail("recognize", e);
        return;
      }
      // Host-side safety net. The main process runs its own timeout too, but the
      // microphone must close even if that process stops asking — a hot mic left
      // behind by a hung caller is the one failure this feature must never have.
      // Wake mode is the deliberate exception: it is continuous by definition,
      // and the user opted into that by switching the wake word on.
      if (timeoutMs > 0 && mode != "wake") {
        if (listenTimer != null) { listenTimer.Dispose(); listenTimer = null; }
        ArmTimeout(timeoutMs);
      }
    }

    static void StopListening(bool quiet) {
      if (listenTimer != null) { try { listenTimer.Dispose(); } catch { } listenTimer = null; }
      if (!listening) { if (!quiet) Emit("STOPPED"); return; }
      listening = false;
      try { rec.RecognizeAsyncCancel(); } catch { }
      // SetInputToNull is what actually hands the audio device back to Windows —
      // cancelling recognition alone leaves the mic (and its indicator) live.
      try { rec.SetInputToNull(); } catch { }
      if (!quiet) Emit("STOPPED");
    }

    static void OnRecognized(object sender, SpeechRecognizedEventArgs e) {
      if (e == null || e.Result == null) return;
      string conf = e.Result.Confidence.ToString("0.000", CultureInfo.InvariantCulture);
      // Which grammar matched decides what this means: a wake hit may carry a
      // command in the same breath, and the main process gates it on a separate,
      // higher confidence threshold.
      bool fromWake = e.Result.Grammar != null && e.Result.Grammar.Name == "wake";
      Emit((fromWake ? "WAKED " : "RESULT ") + conf + " " + OneLine(e.Result.Text));
    }

    static void OnRejected(object sender, SpeechRecognitionRejectedEventArgs e) {
      string text = (e != null && e.Result != null) ? e.Result.Text : "";
      float conf = (e != null && e.Result != null) ? e.Result.Confidence : 0f;
      Emit("REJECTED " + conf.ToString("0.000", CultureInfo.InvariantCulture) + " " + OneLine(text));
    }

    // Hypotheses, levels and audio-state are only useful while the overlay is on
    // screen. In wake mode they would stream forever for nothing, so they stop at
    // the source rather than being filtered by the reader.
    static void OnHypothesized(object sender, SpeechHypothesizedEventArgs e) {
      if (e == null || e.Result == null || mode == "wake") return;
      Emit("HYP " + OneLine(e.Result.Text));
    }

    static void OnLevel(object sender, AudioLevelUpdatedEventArgs e) {
      if (e == null || !listening || mode == "wake") return;
      Emit("LEVEL " + e.AudioLevel);
    }

    static void OnAudioState(object sender, AudioStateChangedEventArgs e) {
      if (e == null || !listening || mode == "wake") return;
      Emit("AUDIO " + e.AudioState);
    }

    // ── Synthesis ──
    static void Speak(string text) {
      if (syn == null || text == null || text.Length == 0) { Emit("SPEAK-DONE"); return; }
      try {
        syn.SpeakAsyncCancelAll();
        syn.SpeakAsync(text);
      } catch (Exception e) { Fail("speak", e); Emit("SPEAK-DONE"); }
    }

    static void CancelSpeech() {
      if (syn == null) return;
      try { syn.SpeakAsyncCancelAll(); } catch { }
    }

    static void SelectVoice(string name) {
      if (syn == null) return;
      try {
        if (name == null || name.Length == 0) syn.SelectVoiceByHints(VoiceGender.NotSet, VoiceAge.NotSet);
        else syn.SelectVoice(name);
      } catch (Exception e) { Fail("voice", e); }
    }

    static void SetRate(int rate) {
      if (syn == null) return;
      if (rate < -5) rate = -5;
      if (rate > 5) rate = 5;
      try { syn.Rate = rate; } catch (Exception e) { Fail("rate", e); }
    }

    // ── Push-to-talk ──
    // Watched with GetAsyncKeyState rather than registered as a global shortcut,
    // for the same reason autoClicker does: a registered accelerator is consumed,
    // has no key-up event, and would swallow the key from whatever is focused.
    static void SetWatch(string arg) {
      string[] parts = arg.Split(' ');
      watchVk = parts.Length > 0 ? ParseInt(parts[0], 0) : 0;
      watchMods = parts.Length > 1 ? ParseInt(parts[1], 0) : 0;
    }

    static void WatchLoop() {
      bool wasDown = false;
      while (running) {
        int vk = watchVk;
        if (vk == 0) {
          if (wasDown) { wasDown = false; Emit("KEY-UP"); }
          Thread.Sleep(60);
          continue;
        }
        bool isDown = (GetAsyncKeyState(vk) & 0x8000) != 0;
        if (isDown) {
          int mods = 0;
          if ((GetAsyncKeyState(0x11) & 0x8000) != 0) mods |= 1; // Ctrl
          if ((GetAsyncKeyState(0x10) & 0x8000) != 0) mods |= 2; // Shift
          if ((GetAsyncKeyState(0x12) & 0x8000) != 0) mods |= 4; // Alt
          if ((GetAsyncKeyState(0x5B) & 0x8000) != 0 || (GetAsyncKeyState(0x5C) & 0x8000) != 0) mods |= 8; // Win
          if (mods != watchMods) isDown = false;
        }
        if (isDown && !wasDown) { wasDown = true; Emit("KEY-DOWN"); }
        else if (!isDown && wasDown) { wasDown = false; Emit("KEY-UP"); }
        Thread.Sleep(15);
      }
    }

    static void Shutdown() {
      running = false;
      StopListening(true);
      CancelSpeech();
      try { if (rec != null) rec.Dispose(); } catch { }
      try { if (syn != null) syn.Dispose(); } catch { }
    }
  }
}
'@

[MainVoiceHost.Host]::Run()
`;

module.exports = { VOICE_HOST_SCRIPT_CONTENT, VOICE_HOST_SCRIPT_VERSION };
