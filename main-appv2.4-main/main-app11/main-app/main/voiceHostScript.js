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
const VOICE_HOST_SCRIPT_VERSION = 8;

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
using System.Text;
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
    static Grammar freeGrammar;
    static Grammar bulkGrammar;
    static List<string> pendingBulk = new List<string>();
    static bool freeform = true;
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
        // Prefer an installed recognizer that actually matches the culture. The
        // default constructor takes whatever is first, which on some machines is
        // a worse engine than one already installed alongside it.
        RecognizerInfo best = null;
        try {
          foreach (RecognizerInfo ri in SpeechRecognitionEngine.InstalledRecognizers()) {
            if (ri == null || ri.Culture == null) continue;
            if (ri.Culture.Name == Culture.Name) { best = ri; break; }
            if (best == null && ri.Culture.TwoLetterISOLanguageName == Culture.TwoLetterISOLanguageName) best = ri;
          }
        } catch { }
        rec = (best != null) ? new SpeechRecognitionEngine(best) : new SpeechRecognitionEngine(Culture);
        // More candidates for the main process to re-rank against the real
        // command list. Cheap, and the extra ones are exactly what rescues a
        // miss when the top pick is wrong.
        try { rec.MaxAlternates = 8; } catch { }
        // Let the engine adapt to this speaker over time.
        try { rec.UpdateRecognizerSetting("AdaptationOn", 1); } catch { }
        // ── Endpointing ──
        // Defaults are tuned for dictating prose. A command is one short
        // phrase, so the engine should stop waiting sooner after speech ends
        // (snappier, and less room for a trailing noise to be folded in) while
        // still tolerating a pause before the user starts.
        try {
          rec.EndSilenceTimeout = TimeSpan.FromMilliseconds(500);
          rec.EndSilenceTimeoutAmbiguous = TimeSpan.FromMilliseconds(900);
          // NO BabbleTimeout. The default is infinite, and capping it means the
          // engine ABORTS an utterance once it has heard that much non-speech —
          // which on a noisy room or a far-field laptop array fires constantly
          // and looks exactly like "it cannot hear me at all". Shipped at 3s in
          // v4.2.0 and reported in the field as total deafness the same day.
          rec.InitialSilenceTimeout = TimeSpan.Zero;
        } catch { }
        // Let the engine surface weaker hypotheses instead of silently binning
        // them: the main process re-ranks the alternates against the command
        // registry and is far better placed to judge which one is plausible.
        // Rejection here would throw that evidence away before anyone sees it.
        try { rec.UpdateRecognizerSetting("CFGConfidenceRejectionThreshold", 10); } catch { }
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
          pendingBulk = new List<string>();
          pendingDictation = new List<string>();
          pendingConfirm = new List<string>();
          pendingWake = new List<string>();
          break;
        case "PHRASE": if (arg.Length > 0) pendingPhrases.Add(arg); break;
        // Bulk vocabulary — names discovered from the machine rather than
        // written into the registry. Same recognizer, lower weight.
        case "BULK": if (arg.Length > 0) pendingBulk.Add(arg); break;
        case "DICTATION": if (arg.Length > 0) pendingDictation.Add(arg); break;
        case "CONFIRM": if (arg.Length > 0) pendingConfirm.Add(arg); break;
        case "WAKE": if (arg.Length > 0) pendingWake.Add(arg); break;
        case "CHAIN": chaining = (arg != "0"); break;
        case "GRAMMAR-END": LoadGrammars(); break;
        // Whether the free-dictation catch-all is loaded. Off makes the
        // assistant strictly literal again.
        case "FREEFORM": freeform = (arg == "1"); break;
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
          // Outranks the freeform catch-all, so a real command always wins.
          try { commandGrammar.Priority = 10; commandGrammar.Weight = 1.0f; } catch { }
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

        // ── The catch-all ──
        // Everything above is a CLOSED grammar: it can only hear phrases that
        // were compiled into it, and anything else is not misheard, it is
        // inaudible. That is the single biggest reason the assistant "doesn't
        // understand what I said" — the words never reached it at all.
        //
        // So a free dictation grammar sits underneath as a safety net. It is far
        // less accurate at exact transcription, but it produces SOMETHING, and
        // the main process can fuzzy-match that against the real command list —
        // which is a much easier problem than transcribing English.
        //
        // Priority and weight keep it strictly subordinate: whenever the command
        // grammar fires, it wins, so this can only add understanding rather than
        // degrade what already worked.
        // ── Bulk vocabulary ──
        // App names discovered from the Start Menu are ~29% of every phrase the
        // recognizer knows, and they are not equal in value to a real command:
        // "pause the music" should never lose to an app that happens to sound
        // like it. A closed grammar discriminates across everything loaded, so
        // adding hundreds of names makes the core commands harder to hear.
        //
        // Splitting them into their own lower-weight, lower-priority grammar
        // keeps the coverage without paying for it on every other command.
        if (pendingBulk.Count > 0) {
          try {
            GrammarBuilder gbulk = new GrammarBuilder();
            gbulk.Culture = Culture;
            gbulk.Append(new Choices(pendingBulk.ToArray()));
            bulkGrammar = new Grammar(gbulk);
            bulkGrammar.Name = "bulk";
            // Below the command grammar's 10/1.0, above the freeform catch-all.
            try { bulkGrammar.Priority = 5; bulkGrammar.Weight = 0.45f; } catch { }
            rec.LoadGrammar(bulkGrammar);
            count += pendingBulk.Count;
          } catch (Exception be) { Fail("bulk grammar", be); }
        }

        if (freeform) {
          try {
            freeGrammar = new DictationGrammar();
            freeGrammar.Name = "freeform";
            // Priority cannot be set on a DictationGrammar, and does not need to
            // be: the command grammar sets its own to 10, which already outranks
            // this one's default of 0. Weight is attempted separately so that a
            // refusal there cannot stop the grammar loading at all.
            try { freeGrammar.Weight = 0.15f; } catch { }
            rec.LoadGrammar(freeGrammar);
          } catch (Exception ge) { Fail("freeform grammar", ge); }
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
      bool fromFree = e.Result.Grammar != null && e.Result.Grammar.Name == "freeform";
      // FREE, not RESULT: this text came from open dictation, so it is a guess
      // at what was SAID rather than a match against what can be DONE. The main
      // process treats it accordingly — it has to clear the fuzzy matcher on its
      // own merits, and it never gets the benefit of the doubt a grammar hit does.
      Emit((fromWake ? "WAKED " : fromFree ? "FREE " : "RESULT ") + conf + " " + OneLine(e.Result.Text));

      // ── N-best ──
      // The top result is the engine's guess, not the only thing it heard. When
      // it is wrong it is very often wrong in a way the SECOND candidate fixes,
      // and the main process can check each against the real command list —
      // something the recognizer cannot do. Emitted after RESULT so a listener
      // that ignores ALT behaves exactly as before.
      if (!fromWake && !fromFree) {
        try {
          int n = 0;
          foreach (RecognizedPhrase alt in e.Result.Alternates) {
            if (alt == null) continue;
            // The first alternate is the accepted result itself.
            if (String.Equals(alt.Text, e.Result.Text, StringComparison.OrdinalIgnoreCase)) continue;
            Emit("ALT " + alt.Confidence.ToString("0.000", CultureInfo.InvariantCulture) + " " + OneLine(alt.Text));
            if (++n >= 4) break;
          }
        } catch { }
      }
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

    // Levels are emitted in BOTH modes, deliberately. Wake mode stays silent
    // about hypotheses and audio state because nothing is watching, but the main
    // process gates an unsolicited wake on whether real speech-level audio was
    // behind it — and a gate fed only by command-mode levels judges the wake
    // word on the loudness of some earlier, unrelated session. It never updated
    // while waking, so once it was low it stayed low and the wake word went deaf.
    static void OnLevel(object sender, AudioLevelUpdatedEventArgs e) {
      if (e == null || !listening) return;
      Emit("LEVEL " + e.AudioLevel);
    }

    static void OnAudioState(object sender, AudioStateChangedEventArgs e) {
      if (e == null || !listening || mode == "wake") return;
      Emit("AUDIO " + e.AudioState);
    }

    // ── Synthesis ──
    // Escapes text for use inside an SSML document.
    static string Xml(string t) {
      if (t == null) return "";
      StringBuilder b = new StringBuilder(t.Length + 16);
      foreach (char c in t) {
        if (c == '&') b.Append("&amp;");
        else if (c == '<') b.Append("&lt;");
        else if (c == '>') b.Append("&gt;");
        else if (c == '"') b.Append("&quot;");
        // (char)39 is an apostrophe. Written as a code point on purpose: this C#
        // lives inside a JS template literal, which eats the backslash and hands
        // the compiler an empty character literal.
        else if (c == (char)39) b.Append("&apos;");
        else b.Append(c);
      }
      return b.ToString();
    }

    // ── Prosody ──
    // The stock SAPI voices read a flat line at a constant pitch, which is most
    // of why they sound synthetic. SSML costs nothing and fixes the two worst
    // parts: it gives punctuation real breathing room, and it stops every
    // sentence landing on the same note. Applied to whatever voice is selected,
    // so it improves the ones already installed rather than depending on better
    // ones being available.
    static string BuildSsml(string text) {
      string body = Xml(text);
      // A dash in an answer ("Working but fine — CPU at 34 percent") is a beat,
      // not a word. Without this the voice runs the two halves together.
      body = body.Replace("&#8212;", ", ").Replace("—", ", ");
      return
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
        "<prosody rate='" + (rate >= 0 ? "+" : "") + (rate * 6).ToString(CultureInfo.InvariantCulture) + "%' pitch='+2%'>" +
        body +
        "</prosody></speak>";
    }

    static void Speak(string text) {
      if (syn == null || text == null || text.Length == 0) { Emit("SPEAK-DONE"); return; }
      try {
        syn.SpeakAsyncCancelAll();
        try {
          syn.SpeakSsmlAsync(BuildSsml(text));
        } catch {
          // A voice that will not take SSML must still be able to talk.
          syn.SpeakAsync(text);
        }
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

    static int rate = 0;

    static void SetRate(int r) {
      if (r < -5) r = -5;
      if (r > 5) r = 5;
      rate = r;
      // Kept on the synthesizer too, for the plain-text fallback path.
      if (syn == null) return;
      try { syn.Rate = r; } catch (Exception e) { Fail("rate", e); }
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
